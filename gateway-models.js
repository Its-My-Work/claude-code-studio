'use strict';
// The model catalogue of the API gateway the `claude` CLI talks to (ANTHROPIC_BASE_URL + /v1/models),
// for the bot editor's model picker. The CLI passes any `--model <id>` through to the gateway
// unchanged, so a bot can be pinned to a specific gateway model instead of the alias the gateway
// maps `sonnet`/`opus` to. The list is fetched with the server's own token and cached; the token
// never leaves this module (the browser gets ids and labels only).

const TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 5000;

// What a model id may look like: gateway ids carry `/` and `:` ("vendor/model:free"), Claude aliases
// and ids do not. Also the shape a bot's `model` must have to be stored.
const MODEL_ID_RE = /^[A-Za-z0-9._:/-]{1,100}$/;

/** OpenAI-style `{data:[...]}` (or a bare array) -> [{id,name,context,tools,free}], usable models first. */
function parseModels(json) {
  const arr = Array.isArray(json) ? json : (json && (json.data || json.models));
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const m of arr) {
    const id = typeof m?.id === 'string' ? m.id.trim() : '';
    if (!id || !MODEL_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : null;
    out.push({
      id,
      name: typeof m.name === 'string' && m.name.trim() ? m.name.trim().substring(0, 120) : id,
      context: Number.isFinite(m.context_length) ? m.context_length : null,
      // null = the gateway did not say; a bot needs tools, so only an explicit "no" is flagged
      tools: params ? params.includes('tools') : null,
      free: m.isFree === true,
    });
  }
  // A model without tools cannot read or write the project, so it goes last; ties keep the gateway's order.
  return out.map((m, i) => ({ m, i })).sort((a, b) => ((a.m.tools === false) - (b.m.tools === false)) || (a.i - b.i)).map(x => x.m);
}

/**
 * A cached reader. `get()` never throws: on a failed fetch it answers the last good list (stale) or an
 * empty one with the reason, so the editor still opens and offers the Claude aliases.
 */
function createCatalog({ baseUrl, token, fetchImpl = globalThis.fetch, ttlMs = TTL_MS, timeoutMs = TIMEOUT_MS, now = Date.now } = {}) {
  let cache = null;     // { at, models }
  let inflight = null;
  const url = baseUrl ? String(baseUrl).replace(/\/+$/, '') + '/v1/models' : null;

  async function load() {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const headers = token ? { authorization: `Bearer ${token}`, 'x-api-key': token } : {};
      const r = await fetchImpl(url, { headers, signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const models = parseModels(await r.json());
      cache = { at: now(), models };
      return { models };
    } catch (e) {
      const reason = e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e).substring(0, 120);
      return cache ? { models: cache.models, stale: true, error: reason } : { models: [], error: reason };
    } finally { clearTimeout(timer); }
  }

  return {
    async get() {
      if (!url) return { models: [], error: 'no-gateway' };
      if (cache && now() - cache.at < ttlMs) return { models: cache.models };
      if (!inflight) inflight = load().finally(() => { inflight = null; });
      return inflight;
    },
  };
}

module.exports = { MODEL_ID_RE, TTL_MS, parseModels, createCatalog };
