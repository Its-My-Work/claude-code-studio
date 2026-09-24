// Provider registry — the persistent half (SQLite). providers.js holds the pure rules.
//
// Kept in SQLite rather than config.json for the same reasons as bots: catalogues run
// to hundreds of models, config.json is rewritten wholesale on every settings change,
// and the usage ledger joins against sessions/tasks.
//
// Secrets (API keys, extra headers) are encrypted with the SAME function the SSH host
// passwords use (AES-256-GCM, key in data/hosts.key) and never leave this module in a
// public view: the API answers `hasKey`, and a header value whose NAME looks secret is
// masked as '***' (sending '***' back on save keeps the stored value — the SSH-host
// "blank means keep" rule, adapted to a map).
'use strict';

const P = require('./providers');

const SECRET_HEADER_RE = /(SECRET|TOKEN|PASSWORD|AUTH|API_?KEY|KEY|COOKIE)/i;
const USAGE_RETENTION_DAYS = 90;
// A catalogue this small is enabled wholesale on first import; a big one (OpenRouter
// lists hundreds) is imported switched off, so the pickers are not flooded.
const AUTO_ENABLE_MAX = 40;

function j(v, fallback) {
  if (v == null || v === '') return fallback;
  try { const x = JSON.parse(v); return x == null ? fallback : x; } catch { return fallback; }
}

function createProviderStore(db, { encrypt, decrypt, log } = {}) {
  const L = log || { info() {}, warn() {}, error() {} };
  const enc = (s) => (s ? encrypt(String(s)) : '');
  const dec = (s) => (s ? decrypt(String(s)) : '');

  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      label       TEXT NOT NULL,
      base_url    TEXT NOT NULL DEFAULT '',
      auth_scheme TEXT NOT NULL DEFAULT 'bearer',
      api_key_enc TEXT NOT NULL DEFAULT '',
      headers_enc TEXT NOT NULL DEFAULT '',
      dialect     TEXT NOT NULL DEFAULT 'generic',
      options     TEXT NOT NULL DEFAULT '{}',
      roles       TEXT NOT NULL DEFAULT '{}',
      aliases     INTEGER NOT NULL DEFAULT 0,
      enabled     INTEGER NOT NULL DEFAULT 1,
      -- 'builtin' (the CLI login row), 'env' (seeded from ANTHROPIC_* and kept in sync
      -- with it at boot until edited here), 'user'
      source      TEXT NOT NULL DEFAULT 'user',
      sort_order  INTEGER NOT NULL DEFAULT 0,
      last_test   TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- caps/pricing come from the provider's catalogue and are overwritten on refresh;
    -- caps_user/pricing_user are the user's corrections and are never touched by one.
    CREATE TABLE IF NOT EXISTS provider_models (
      provider_id  TEXT NOT NULL,
      model_id     TEXT NOT NULL,
      label        TEXT NOT NULL DEFAULT '',
      enabled      INTEGER NOT NULL DEFAULT 1,
      source       TEXT NOT NULL DEFAULT 'catalog',
      caps         TEXT NOT NULL DEFAULT '{}',
      caps_user    TEXT NOT NULL DEFAULT '{}',
      pricing      TEXT,
      pricing_user TEXT,
      verified     TEXT,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (provider_id, model_id)
    );
    CREATE TABLE IF NOT EXISTS provider_settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    -- One row per upstream request the llm-bridge served. Before this, usage existed
    -- only on the WS 'done' frame of the CLI's own result and was never stored.
    CREATE TABLE IF NOT EXISTS llm_usage (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      ts                 INTEGER NOT NULL,
      run_id             TEXT,
      purpose            TEXT,
      session_id         TEXT,
      task_id            TEXT,
      bot_id             TEXT,
      provider_id        TEXT,
      model              TEXT,
      requested_model    TEXT,
      input_tokens       INTEGER NOT NULL DEFAULT 0,
      output_tokens      INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
      cost_usd           REAL,
      latency_ms         INTEGER,
      status             TEXT,
      http_status        INTEGER,
      error_type         TEXT,
      cli_session_id     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_llm_usage_ts ON llm_usage(ts);
    CREATE INDEX IF NOT EXISTS idx_llm_usage_run ON llm_usage(run_id);
    CREATE INDEX IF NOT EXISTS idx_llm_usage_session ON llm_usage(session_id);
  `);

  const st = {
    all: db.prepare(`SELECT * FROM providers ORDER BY sort_order, created_at`),
    get: db.prepare(`SELECT * FROM providers WHERE id = ?`),
    insert: db.prepare(`INSERT INTO providers (id, type, label, base_url, auth_scheme, api_key_enc, headers_enc, dialect, options, roles, aliases, enabled, source, sort_order)
                        VALUES (@id, @type, @label, @base_url, @auth_scheme, @api_key_enc, @headers_enc, @dialect, @options, @roles, @aliases, @enabled, @source, @sort_order)`),
    del: db.prepare(`DELETE FROM providers WHERE id = ?`),
    delModels: db.prepare(`DELETE FROM provider_models WHERE provider_id = ?`),
    models: db.prepare(`SELECT * FROM provider_models WHERE provider_id = ? ORDER BY sort_order, model_id`),
    allModels: db.prepare(`SELECT * FROM provider_models ORDER BY provider_id, sort_order, model_id`),
    model: db.prepare(`SELECT * FROM provider_models WHERE provider_id = ? AND model_id = ?`),
    upsertCatalogModel: db.prepare(`INSERT INTO provider_models (provider_id, model_id, label, enabled, source, caps, pricing, sort_order)
                                    VALUES (?, ?, ?, ?, 'catalog', ?, ?, ?)
                                    ON CONFLICT(provider_id, model_id) DO UPDATE SET label = excluded.label, caps = excluded.caps,
                                      pricing = excluded.pricing, sort_order = excluded.sort_order, updated_at = datetime('now')`),
    insertManual: db.prepare(`INSERT INTO provider_models (provider_id, model_id, label, enabled, source, caps, caps_user, sort_order)
                              VALUES (?, ?, ?, 1, 'manual', '{}', ?, 100000)
                              ON CONFLICT(provider_id, model_id) DO UPDATE SET enabled = 1, caps_user = excluded.caps_user, updated_at = datetime('now')`),
    delModel: db.prepare(`DELETE FROM provider_models WHERE provider_id = ? AND model_id = ?`),
    getSetting: db.prepare(`SELECT value FROM provider_settings WHERE key = ?`),
    setSetting: db.prepare(`INSERT INTO provider_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
    delSetting: db.prepare(`DELETE FROM provider_settings WHERE key = ?`),
    usageInsert: db.prepare(`INSERT INTO llm_usage (ts, run_id, purpose, session_id, task_id, bot_id, provider_id, model, requested_model,
                               input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, latency_ms, status, http_status, error_type, cli_session_id)
                             VALUES (@ts, @run_id, @purpose, @session_id, @task_id, @bot_id, @provider_id, @model, @requested_model,
                               @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens, @reasoning_tokens, @cost_usd, @latency_ms, @status, @http_status, @error_type, @cli_session_id)`),
    usagePrune: db.prepare(`DELETE FROM llm_usage WHERE ts < ?`),
    usageByRun: db.prepare(`SELECT COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output, COALESCE(SUM(cache_read_tokens),0) AS cache_read,
                              COALESCE(SUM(reasoning_tokens),0) AS reasoning, SUM(cost_usd) AS cost, COUNT(*) AS requests,
                              SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
                            FROM llm_usage WHERE run_id = ?`),
    usageLastByRun: db.prepare(`SELECT input_tokens, cache_read_tokens, cache_write_tokens FROM llm_usage WHERE run_id = ? AND status = 'ok' ORDER BY id DESC LIMIT 1`),
    usageSummary: db.prepare(`SELECT provider_id, model, date(ts, 'unixepoch') AS day, COUNT(*) AS requests,
                                SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read,
                                SUM(cost_usd) AS cost, SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS errors
                              FROM llm_usage WHERE ts >= ? GROUP BY provider_id, model, day ORDER BY day DESC, cost DESC`),
    lastStatus: db.prepare(`SELECT provider_id, status, error_type, http_status, ts FROM llm_usage
                            WHERE id IN (SELECT MAX(id) FROM llm_usage GROUP BY provider_id)`),
  };

  let _cache = null;
  const invalidate = () => { _cache = null; };

  function rowToModel(r) {
    const caps = { ...P.normalizeCaps(j(r.caps, {})) };
    const user = j(r.caps_user, {});
    for (const k of P.CAP_KEYS) if (user[k] !== undefined && user[k] !== null) caps[k] = user[k];
    const pricing = P.normalizePricing(j(r.pricing_user, null)) || P.normalizePricing(j(r.pricing, null));
    return { id: r.model_id, label: r.label || r.model_id, enabled: !!r.enabled, source: r.source, caps: P.normalizeCaps(caps),
      capsUser: j(r.caps_user, {}), pricing, pricingUser: j(r.pricing_user, null), verified: j(r.verified, null) };
  }

  function rowToProvider(r, models) {
    return {
      id: r.id, type: r.type, label: r.label, baseUrl: r.base_url, authScheme: r.auth_scheme,
      apiKey: dec(r.api_key_enc), headers: j(dec(r.headers_enc), {}), dialect: r.dialect,
      options: j(r.options, {}), roles: j(r.roles, {}), aliases: !!r.aliases, enabled: !!r.enabled,
      source: r.source, sortOrder: r.sort_order, lastTest: j(r.last_test, null), models: models || [],
    };
  }

  /** Decrypted registry for resolveModel(). Cached; every write invalidates. */
  function registry() {
    if (_cache) return _cache;
    const byProv = new Map();
    for (const m of st.allModels.all()) {
      if (!byProv.has(m.provider_id)) byProv.set(m.provider_id, []);
      byProv.get(m.provider_id).push(rowToModel(m));
    }
    const providers = st.all.all().map(r => rowToProvider(r, byProv.get(r.id)));
    const defaultProviderId = getSetting('defaultProvider') || P.BUILTIN_CLAUDE_ID;
    const utilityModel = getSetting('utilityModel') || '';
    _cache = { providers, defaultProviderId, utilityModel };
    return _cache;
  }

  function getSetting(k) { const r = st.getSetting.get(k); return r ? r.value : null; }
  function setSetting(k, v) { if (v == null || v === '') st.delSetting.run(k); else st.setSetting.run(k, String(v)); invalidate(); }

  function maskHeaders(h) {
    const out = {};
    for (const [k, v] of Object.entries(h || {})) out[k] = SECRET_HEADER_RE.test(k) ? (v ? '***' : '') : v;
    return out;
  }

  /** What the browser may see. */
  function publicProvider(p) {
    return {
      id: p.id, type: p.type, label: p.label, baseUrl: p.baseUrl, authScheme: p.authScheme,
      hasKey: !!p.apiKey, headers: maskHeaders(p.headers), dialect: p.dialect, options: p.options,
      roles: p.roles, aliases: P.supportsAliases(p), aliasesSetting: p.aliases, enabled: p.enabled, source: p.source,
      builtin: p.id === P.BUILTIN_CLAUDE_ID, lastTest: p.lastTest,
      models: p.models.map(m => ({ id: m.id, label: m.label, enabled: m.enabled, source: m.source, caps: m.caps, capsUser: m.capsUser, pricing: m.pricing, verified: m.verified })),
    };
  }

  function publicList() {
    const reg = registry();
    return { providers: reg.providers.map(publicProvider), defaultProviderId: reg.defaultProviderId, utilityModel: reg.utilityModel };
  }

  function get(id) { return registry().providers.find(p => p.id === id) || null; }

  function create(v) {
    if (st.get.get(v.id)) throw Object.assign(new Error('exists'), { code: 'exists' });
    const maxOrder = registry().providers.reduce((m, p) => Math.max(m, p.sortOrder || 0), 0);
    st.insert.run({
      id: v.id, type: v.type, label: v.label, base_url: v.baseUrl || '', auth_scheme: v.authScheme || 'bearer',
      api_key_enc: enc(v.apiKey), headers_enc: v.headers && Object.keys(v.headers).length ? enc(JSON.stringify(v.headers)) : '',
      dialect: v.dialect || 'generic', options: JSON.stringify(v.options || {}), roles: JSON.stringify(v.roles || {}),
      aliases: v.aliases ? 1 : 0, enabled: v.enabled === false ? 0 : 1, source: v.source || 'user', sort_order: v.sortOrder ?? (maxOrder + 1),
    });
    invalidate();
    return get(v.id);
  }

  /** Patch semantics: an absent field is unchanged; apiKey '' is unchanged, `clearApiKey` clears it;
   *  a header value '***' keeps the stored one; an option set to null is removed. Only a field
   *  whose value really CHANGES counts — pressing Save on an untouched env-seeded row must not
   *  detach it from .env — and any real edit of such a row makes it the user's. */
  function update(id, patch, { fromEnv } = {}) {
    const cur = get(id);
    if (!cur) return null;
    const sets = [], vals = {};
    let userEdit = false;
    const put = (col, val, isUserField = true) => { sets.push(`${col} = @${col}`); vals[col] = val; if (isUserField) userEdit = true; };
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (patch.label !== undefined && patch.label !== cur.label) put('label', patch.label);
    if (patch.baseUrl !== undefined && cur.type !== 'claude-subscription' && patch.baseUrl !== cur.baseUrl) put('base_url', patch.baseUrl);
    if (patch.type !== undefined && cur.type !== 'claude-subscription' && patch.type !== cur.type) put('type', patch.type);
    if (patch.authScheme !== undefined && patch.authScheme !== cur.authScheme) put('auth_scheme', patch.authScheme);
    if (patch.dialect !== undefined && patch.dialect !== cur.dialect) put('dialect', patch.dialect);
    if (patch.clearApiKey) { if (cur.apiKey) put('api_key_enc', ''); }
    else if (typeof patch.apiKey === 'string' && patch.apiKey !== '' && patch.apiKey !== cur.apiKey) put('api_key_enc', enc(patch.apiKey));
    if (patch.headers !== undefined) {
      const merged = {};
      for (const [k, v] of Object.entries(patch.headers || {})) merged[k] = (v === '***' && cur.headers[k] !== undefined) ? cur.headers[k] : v;
      if (!same(merged, cur.headers)) put('headers_enc', Object.keys(merged).length ? enc(JSON.stringify(merged)) : '');
    }
    if (patch.options !== undefined) {
      const merged = { ...cur.options, ...patch.options };
      for (const k of Object.keys(merged)) if (merged[k] === null || merged[k] === undefined) delete merged[k];
      if (!same(merged, cur.options)) put('options', JSON.stringify(merged));
    }
    if (patch.roles !== undefined && !same(patch.roles || {}, cur.roles || {})) put('roles', JSON.stringify(patch.roles || {}));
    if (patch.aliases !== undefined && !!patch.aliases !== !!cur.aliases) put('aliases', patch.aliases ? 1 : 0);
    if (patch.enabled !== undefined && !!patch.enabled !== !!cur.enabled) put('enabled', patch.enabled ? 1 : 0, false);
    if (patch.lastTest !== undefined) put('last_test', patch.lastTest ? JSON.stringify(patch.lastTest) : null, false);
    if (patch.sortOrder !== undefined) put('sort_order', patch.sortOrder, false);
    if (!fromEnv && cur.source === 'env' && userEdit) put('source', 'user', false);
    if (!sets.length) return cur;
    sets.push(`updated_at = datetime('now')`);
    db.prepare(`UPDATE providers SET ${sets.join(', ')} WHERE id = @id`).run({ ...vals, id });
    invalidate();
    return get(id);
  }

  function remove(id) {
    if (id === P.BUILTIN_CLAUDE_ID) return false;
    const r = st.del.run(id);
    st.delModels.run(id);
    if (getSetting('defaultProvider') === id) setSetting('defaultProvider', P.BUILTIN_CLAUDE_ID);
    invalidate();
    return r.changes > 0;
  }

  function setDefault(id) {
    const p = get(id);
    if (!p || !p.enabled) return false;
    setSetting('defaultProvider', id);
    return true;
  }

  /** Merge a fetched catalogue. Enabled/manual models and the user's corrections survive. */
  function upsertCatalog(providerId, models) {
    const existing = new Map(st.models.all(providerId).map(r => [r.model_id, r]));
    const firstImport = ![...existing.values()].some(r => r.source === 'catalog');
    const autoEnable = firstImport && models.length <= AUTO_ENABLE_MAX;
    const seen = new Set();
    const tx = db.transaction(() => {
      models.forEach((m, i) => {
        seen.add(m.id);
        const prev = existing.get(m.id);
        const enabled = prev ? prev.enabled : (autoEnable ? 1 : 0);
        st.upsertCatalogModel.run(providerId, m.id, m.label || m.id, enabled, JSON.stringify(m.caps || {}), m.pricing ? JSON.stringify(m.pricing) : null, i);
      });
      // A model that left the catalogue is dropped unless the user switched it on —
      // then it stays (a chat may be pinned to it) until they remove it.
      for (const [id, r] of existing) {
        if (!seen.has(id) && r.source === 'catalog' && !r.enabled) st.delModel.run(providerId, id);
      }
    });
    tx();
    invalidate();
    return { total: models.length, added: models.filter(m => !existing.has(m.id)).length, autoEnabled: autoEnable };
  }

  function setModel(providerId, modelId, patch) {
    const r = st.model.get(providerId, modelId);
    if (!r) return null;
    const sets = [], vals = { p: providerId, m: modelId };
    if (patch.enabled !== undefined) { sets.push('enabled = @enabled'); vals.enabled = patch.enabled ? 1 : 0; }
    if (patch.label !== undefined) { sets.push('label = @label'); vals.label = String(patch.label).substring(0, 120); }
    if (patch.caps !== undefined) {
      const cu = {};
      for (const k of P.CAP_KEYS) {
        const v = patch.caps ? patch.caps[k] : undefined;
        if (v === true || v === false) cu[k] = v;
        else if ((k === 'contextWindow' || k === 'maxOutput') && Number(v) > 0) cu[k] = Math.trunc(Number(v));
      }
      sets.push('caps_user = @caps_user'); vals.caps_user = JSON.stringify(cu);
    }
    if (patch.pricing !== undefined) { sets.push('pricing_user = @pricing_user'); const pr = P.normalizePricing(patch.pricing); vals.pricing_user = pr ? JSON.stringify(pr) : null; }
    if (patch.verified !== undefined) { sets.push('verified = @verified'); vals.verified = patch.verified ? JSON.stringify(patch.verified) : null; }
    if (!sets.length) return rowToModel(r);
    sets.push(`updated_at = datetime('now')`);
    db.prepare(`UPDATE provider_models SET ${sets.join(', ')} WHERE provider_id = @p AND model_id = @m`).run(vals);
    invalidate();
    return rowToModel(st.model.get(providerId, modelId));
  }

  function addManualModel(providerId, modelId, { label, caps } = {}) {
    if (!P.MODEL_ID_RE.test(modelId)) return null;
    st.insertManual.run(providerId, modelId, label || modelId, JSON.stringify(P.normalizeCaps(caps)));
    invalidate();
    return rowToModel(st.model.get(providerId, modelId));
  }

  function removeModel(providerId, modelId) {
    const r = st.delModel.run(providerId, modelId);
    invalidate();
    return r.changes > 0;
  }

  // ── usage ledger ──────────────────────────────────────────────────────────
  function recordUsage(u) {
    try {
      st.usageInsert.run({
        ts: Math.floor((u.ts || Date.now()) / 1000), run_id: u.runId || null, purpose: u.purpose || null,
        session_id: u.sessionId || null, task_id: u.taskId || null, bot_id: u.botId || null,
        provider_id: u.providerId || null, model: u.model || null, requested_model: u.requestedModel || null,
        input_tokens: u.inputTokens | 0, output_tokens: u.outputTokens | 0, cache_read_tokens: u.cacheReadTokens | 0,
        cache_write_tokens: u.cacheWriteTokens | 0, reasoning_tokens: u.reasoningTokens | 0,
        cost_usd: u.costUsd == null ? null : Number(u.costUsd), latency_ms: u.latencyMs == null ? null : Math.round(u.latencyMs),
        status: u.status || 'ok', http_status: u.httpStatus || null, error_type: u.errorType || null, cli_session_id: u.cliSessionId || null,
      });
    } catch (e) { L.warn('llm_usage insert failed', { err: e.message }); }
  }

  function usageForRun(runId) {
    if (!runId) return null;
    const s = st.usageByRun.get(runId);
    if (!s || !s.requests) return null;
    const last = st.usageLastByRun.get(runId);
    return { ...s, lastTurn: last ? { input_tokens: last.input_tokens, cache_read_input_tokens: last.cache_read_tokens, cache_creation_input_tokens: last.cache_write_tokens } : null };
  }

  function usageSummary(days = 30) {
    const since = Math.floor(Date.now() / 1000) - Math.max(1, Math.min(366, days | 0)) * 86400;
    return st.usageSummary.all(since);
  }

  function lastStatusByProvider() {
    const out = {};
    for (const r of st.lastStatus.all()) out[r.provider_id] = { status: r.status, errorType: r.error_type, httpStatus: r.http_status, ts: r.ts };
    return out;
  }

  function pruneUsage() {
    try { st.usagePrune.run(Math.floor(Date.now() / 1000) - USAGE_RETENTION_DAYS * 86400); } catch {}
  }

  // ── boot: seed and keep the env-sourced row in sync ───────────────────────
  /**
   * First boot: the CLI-login row always exists; ANTHROPIC_BASE_URL (+ its token) becomes
   * a provider 'gateway' and the DEFAULT, because that is what every run used until now —
   * a bare "sonnet" in an existing row must keep landing on the same endpoint.
   * Later boots: an env-sourced row follows the env (edit .env + restart still works, as
   * before), until it is edited in the UI — then it is the user's and env is ignored.
   */
  /** The part of the env the CLI used to read directly, as a provider's roles and headers. */
  function envShape(env) {
    const roles = {};
    const pick = (k) => { const v = String(env[k] || '').trim(); return v && P.MODEL_ID_RE.test(v) ? v : null; };
    const main = pick('ANTHROPIC_DEFAULT_SONNET_MODEL'), fast = pick('ANTHROPIC_DEFAULT_HAIKU_MODEL') || pick('ANTHROPIC_SMALL_FAST_MODEL');
    const strong = pick('ANTHROPIC_DEFAULT_OPUS_MODEL'), fable = pick('ANTHROPIC_DEFAULT_FABLE_MODEL'), sub = pick('CLAUDE_CODE_SUBAGENT_MODEL');
    if (main) roles.main = main; if (fast) roles.fast = fast; if (strong) roles.strong = strong; if (fable) roles.fable = fable; if (sub) roles.subagent = sub;
    // ANTHROPIC_CUSTOM_HEADERS: "Name: value" lines, as the CLI parses them.
    const headers = {};
    for (const line of String(env.ANTHROPIC_CUSTOM_HEADERS || '').split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i <= 0) continue;
      const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
      if (/^[A-Za-z0-9-]{1,64}$/.test(k) && v && !/[\r\n]/.test(v)) headers[k] = v;
    }
    return { roles, headers };
  }

  /**
   * First boot: the CLI-login row always exists; ANTHROPIC_BASE_URL (+ its token, the
   * ANTHROPIC_DEFAULT_*_MODEL remaps and ANTHROPIC_CUSTOM_HEADERS the CLI used to read
   * directly) becomes a provider 'gateway' and the DEFAULT, because that is what every run
   * used until now — a bare "sonnet" in an existing row must keep landing on the same model.
   * Later boots: an env-sourced row follows the env (edit .env + restart still works, as
   * before), until it is edited in the UI — then it is the user's and env is ignored. An
   * env row whose variable was REMOVED is switched off (and stops being the default), which
   * is what removing it used to mean: back to the CLI login.
   */
  function seedFromEnv(env) {
    if (!st.get.get(P.BUILTIN_CLAUDE_ID)) {
      st.insert.run({ id: P.BUILTIN_CLAUDE_ID, type: 'claude-subscription', label: 'Claude', base_url: '', auth_scheme: 'bearer',
        api_key_enc: '', headers_enc: '', dialect: 'generic', options: '{}', roles: '{}', aliases: 1, enabled: 1, source: 'builtin', sort_order: 0 });
      invalidate();
    }
    const baseUrl = String(env.ANTHROPIC_BASE_URL || '').trim().replace(/\/+$/, '');
    const authToken = String(env.ANTHROPIC_AUTH_TOKEN || '').trim();
    const apiKey = String(env.ANTHROPIC_API_KEY || '').trim();
    const shape = envShape(env);
    const seeded = getSetting('seededFromEnv');
    const envRows = registry().providers.filter(p => p.source === 'env');
    const gwRow = envRows.find(p => p.type === 'anthropic-compatible');
    const anRow = envRows.find(p => p.type === 'anthropic');

    const disableEnvRow = (row) => {
      if (!row.enabled) return;
      update(row.id, { enabled: false }, { fromEnv: true });
      setSetting(`envDisabled:${row.id}`, '1');
      if (getSetting('defaultProvider') === row.id) setSetting('defaultProvider', P.BUILTIN_CLAUDE_ID);
      L.info('env provider switched off — its variable is gone', { id: row.id });
    };
    const syncEnvRow = (row, fields) => {
      const wasEnvDisabled = getSetting(`envDisabled:${row.id}`);
      update(row.id, { ...fields, ...(wasEnvDisabled ? { enabled: true } : {}) }, { fromEnv: true });
      if (wasEnvDisabled) { setSetting(`envDisabled:${row.id}`, ''); if (!getSetting('defaultProvider') || getSetting('defaultProvider') === P.BUILTIN_CLAUDE_ID) setSetting('defaultProvider', row.id); }
    };

    if (baseUrl && /^https?:\/\//i.test(baseUrl)) {
      const key = authToken || apiKey;
      const scheme = authToken ? 'bearer' : 'x-api-key';
      const fields = { baseUrl, apiKey: key || undefined, clearApiKey: !key, authScheme: scheme, roles: shape.roles, headers: shape.headers };
      if (gwRow) {
        syncEnvRow(gwRow, fields);
      } else if (!seeded) {
        let host = baseUrl;
        try { host = new URL(baseUrl).host; } catch {}
        const id = st.get.get('gateway') ? 'gateway-env' : 'gateway';
        create({ id, type: 'anthropic-compatible', label: host.substring(0, 60), baseUrl, apiKey: key, authScheme: scheme,
          aliases: true, source: 'env', options: { quietCli: false }, roles: shape.roles, headers: shape.headers });
        setSetting('defaultProvider', id);
        L.info('provider seeded from ANTHROPIC_BASE_URL', { id, host });
      }
    } else if (gwRow) {
      disableEnvRow(gwRow);
    }

    if (!baseUrl) {
      if (anRow) {
        if (authToken || apiKey) syncEnvRow(anRow, { apiKey: authToken || apiKey, authScheme: authToken ? 'bearer' : 'x-api-key' });
        else disableEnvRow(anRow);
      } else if (!seeded && authToken) {
        // Without a base URL the old code still passed ANTHROPIC_AUTH_TOKEN through (and
        // dropped ANTHROPIC_API_KEY so the CLI used the subscription): keep both behaviours.
        create({ id: 'anthropic', type: 'anthropic', label: 'Anthropic API', baseUrl: 'https://api.anthropic.com', apiKey: authToken,
          authScheme: 'bearer', aliases: true, source: 'env' });
        setSetting('defaultProvider', 'anthropic');
      } else if (!seeded && apiKey) {
        create({ id: 'anthropic', type: 'anthropic', label: 'Anthropic API', baseUrl: 'https://api.anthropic.com', apiKey,
          authScheme: 'x-api-key', aliases: true, source: 'env' });
      }
    }
    if (!seeded) setSetting('seededFromEnv', String(Date.now()));
  }

  return {
    registry, invalidate, publicList, publicProvider, get, create, update, remove, setDefault,
    getSetting, setSetting, upsertCatalog, setModel, addManualModel, removeModel,
    recordUsage, usageForRun, usageSummary, lastStatusByProvider, pruneUsage, seedFromEnv,
  };
}

module.exports = { createProviderStore, SECRET_HEADER_RE, AUTO_ENABLE_MAX, USAGE_RETENTION_DAYS };
