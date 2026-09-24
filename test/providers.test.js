// Provider registry: model refs, resolution, run environment, catalogue parsing, the
// SQLite store and the catalogue fetcher. Run: node test/providers.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const P = require('../providers');
const { createProviderStore } = require('../providers-store');
const { fetchCatalog } = require('../providers-catalog');
const openDatabase = require('../db-adapter');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// ── fixtures ────────────────────────────────────────────────────────────────
const claude = { id: 'claude', type: 'claude-subscription', label: 'Claude', enabled: true, aliases: true, models: [], roles: {}, options: {} };
const gateway = { id: 'gateway', type: 'anthropic-compatible', label: 'kilo', enabled: true, aliases: true, baseUrl: 'https://kilo.example', apiKey: 'kgw', authScheme: 'bearer',
  models: [{ id: 'z-ai/glm-5:free', enabled: true, caps: { tools: true, contextWindow: 200000 } }], roles: {}, options: { quietCli: false } };
const deepseek = { id: 'deepseek', type: 'openai-compatible', label: 'DeepSeek', enabled: true, aliases: false, baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-ds', dialect: 'deepseek',
  models: [
    { id: 'deepseek-chat', enabled: true, caps: { tools: true, vision: false, reasoning: false, contextWindow: 128000, maxOutput: 8192 } },
    { id: 'deepseek-reasoner', enabled: true, caps: { tools: true, reasoning: true, contextWindow: 128000, maxOutput: 64000 } },
  ], roles: { main: 'deepseek-chat', fast: 'deepseek-chat', strong: 'deepseek-reasoner' }, options: {} };
const off = { id: 'off', type: 'openai-compatible', label: 'Off', enabled: false, models: [{ id: 'm', enabled: true }], roles: {}, options: {} };
const reg = { providers: [claude, gateway, deepseek, off], defaultProviderId: 'gateway', utilityModel: '' };

console.log('model refs:');
check('bare alias', P.parseModelRef('sonnet'), { providerId: null, modelId: 'sonnet' });
check('bare gateway id keeps its colon suffix', P.parseModelRef('z-ai/glm-5:free'), { providerId: null, modelId: 'z-ai/glm-5:free' });
check('qualified ref', P.parseModelRef('kilo::z-ai/glm-5:free'), { providerId: 'kilo', modelId: 'z-ai/glm-5:free' });
check('garbage is refused', ['', '  ', 'a b', 'x;rm', 'Bad::m', '::m', 'p::', 'p::a b', null, 5].map(v => P.parseModelRef(v)), [null, null, null, null, null, null, null, null, null, null]);
check('format round-trips', P.formatModelRef('deepseek', 'deepseek-chat'), 'deepseek::deepseek-chat');
check('bareModelId strips the provider', [P.bareModelId('claude::opus'), P.bareModelId('opus'), P.bareModelId('x y')], ['opus', 'opus', null]);
check('a qualified ref still passes the bot model check (gateway-models.MODEL_ID_RE)', require('../gateway-models').MODEL_ID_RE.test('deepseek::deepseek-chat'), true);

console.log('resolution:');
{
  const r = P.resolveModel('sonnet', reg, { engine: 'api' });
  check('a bare alias lands on the default provider, unchanged (what every old row meant)', [r.ok, r.provider.id, r.cliModel, r.routing, r.ref], [true, 'gateway', 'sonnet', 'bridge', 'gateway::sonnet']);
}
{
  const r = P.resolveModel('z-ai/glm-5:free', reg, { engine: 'api' });
  check('a bare gateway id (old bot row) lands on the default provider', [r.provider.id, r.cliModel, r.caps.contextWindow], ['gateway', 'z-ai/glm-5:free', 200000]);
}
{
  const r = P.resolveModel('deepseek::deepseek-reasoner', reg, { engine: 'api' });
  check('a qualified ref picks its provider and model', [r.provider.id, r.cliModel, r.caps.reasoning, r.pricing], ['deepseek', 'deepseek-reasoner', true, null]);
}
{
  const r = P.resolveModel('haiku', { ...reg, defaultProviderId: 'deepseek' }, { engine: 'api' });
  check('an alias on a provider that serves no Claude maps through its roles', [r.provider.id, r.cliModel], ['deepseek', 'deepseek-chat']);
  const o = P.resolveModel('deepseek::opus', reg, { engine: 'api' });
  check('…opus → the strong role', o.cliModel, 'deepseek-reasoner');
}
{
  const r = P.resolveModel('sonnet', reg, { engine: 'subscription' });
  check('the Subscription engine means the CLI login, whatever the default is', [r.provider.id, r.routing, r.engine, r.engineChanged], ['claude', 'oauth', 'subscription', false]);
  const d = P.resolveModel('deepseek::deepseek-chat', reg, { engine: 'subscription' });
  check('a non-Claude model on the Subscription engine runs on the API engine instead, and says so', [d.provider.id, d.engine, d.engineChanged, d.routing], ['deepseek', 'api', true, 'bridge']);
  check('effectiveEngine mirrors it', [P.effectiveEngine('subscription', 'deepseek::deepseek-chat', reg), P.effectiveEngine('subscription', 'opus', reg), P.effectiveEngine('api', 'opus', reg)], ['api', 'subscription', 'api']);
}
{
  const r = P.resolveModel('ghost::gpt-9', reg, { engine: 'api' });
  check('a deleted provider falls back to the default, flagged', [r.ok, r.provider.id, r.cliModel, r.fallback], [true, 'gateway', 'sonnet', 'provider_missing']);
  const o = P.resolveModel('off::m', reg, { engine: 'api' });
  check('a switched-off provider falls back too', [o.provider.id, o.fallback], ['gateway', 'provider_disabled']);
  const n = P.resolveModel('ghost::x', { ...reg, defaultProviderId: 'deepseek' }, { engine: 'api' });
  check('…onto the default provider\'s main model when it serves no aliases', [n.provider.id, n.cliModel], ['deepseek', 'deepseek-chat']);
}
{
  check('the SSH engine routes remote (the remote host decides)', P.resolveModel('deepseek::deepseek-chat', reg, { engine: 'ssh' }).routing, 'remote');
  check('no default configured → the CLI login', P.resolveModel('sonnet', { providers: [claude] }, {}).provider.id, 'claude');
  check('empty value means the built-in default model', P.resolveModel('', reg, {}).cliModel, 'sonnet');
  check('an invalid value is an error, not a silent sonnet', P.resolveModel('x;rm -rf', reg, {}), { ok: false, error: 'invalid_model' });
  const empty = { id: 'e', type: 'openai-compatible', label: 'E', enabled: true, models: [], roles: {}, options: {} };
  check('a provider with no models at all cannot resolve an alias', P.resolveModel('e::sonnet', { providers: [claude, empty] }, {}).error, 'no_model');
}

console.log('run environment:');
{
  const oauth = P.buildRunEnv(P.resolveModel('opus', reg, { engine: 'subscription' }));
  check('the CLI login injects nothing and strips every provider variable', [Object.keys(oauth.set).length, oauth.unset.includes('ANTHROPIC_BASE_URL'), oauth.unset.includes('ANTHROPIC_API_KEY'), oauth.extraArgs], [0, true, true, []]);
  const env = P.applyRunEnv({ ANTHROPIC_BASE_URL: 'https://stale', ANTHROPIC_AUTH_TOKEN: 'leak', PATH: '/bin' }, oauth);
  check('…so a stale base URL in the server env cannot reach that run', env, { PATH: '/bin' });
}
{
  const t = P.resolveModel('deepseek::deepseek-chat', reg, { engine: 'api' });
  const e = P.buildRunEnv(t, { baseUrl: 'http://127.0.0.1:4567', token: 'ccsr_x' });
  check('a bridge run gets the bridge and its run token — never the provider key', [e.set.ANTHROPIC_BASE_URL, e.set.ANTHROPIC_AUTH_TOKEN, JSON.stringify(e).includes('sk-ds')], ['http://127.0.0.1:4567', 'ccsr_x', false]);
  check('the CLI\'s own alias calls are mapped onto the provider\'s roles', [e.set.ANTHROPIC_DEFAULT_HAIKU_MODEL, e.set.ANTHROPIC_DEFAULT_SONNET_MODEL, e.set.ANTHROPIC_DEFAULT_OPUS_MODEL, e.set.ANTHROPIC_DEFAULT_FABLE_MODEL, e.set.ANTHROPIC_SMALL_FAST_MODEL], ['deepseek-chat', 'deepseek-chat', 'deepseek-reasoner', 'deepseek-chat', 'deepseek-chat']);
  check('the real window, the output cap and the thinking switch reach the CLI', [e.set.CLAUDE_CODE_MAX_CONTEXT_TOKENS, e.set.CLAUDE_CODE_MAX_OUTPUT_TOKENS, e.set.CLAUDE_CODE_DISABLE_THINKING], ['128000', '8192', '1']);
  check('non-Anthropic: betas off, quiet CLI, WebSearch disallowed', [e.set.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, e.set.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, e.extraArgs], ['1', '1', ['--disallowedTools', 'WebSearch']]);
  const r = P.buildRunEnv(P.resolveModel('deepseek::deepseek-reasoner', reg, {}), { baseUrl: 'b', token: 't' });
  check('a reasoning model keeps thinking on and gets the output cap clamped to 32K', [r.set.CLAUDE_CODE_MAX_OUTPUT_TOKENS, r.set.CLAUDE_CODE_DISABLE_THINKING], ['32000', undefined]);
}
{
  const e = P.buildRunEnv(P.resolveModel('sonnet', reg, {}), { baseUrl: 'b', token: 't' });
  check('the migrated gateway keeps its own alias mapping and stays chatty (behaviour unchanged)', [e.set.ANTHROPIC_DEFAULT_SONNET_MODEL, e.set.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, e.set.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS], [undefined, undefined, undefined]);
  const pinned = P.buildRunEnv(P.resolveModel('sonnet', { ...reg, providers: [claude, { ...gateway, roles: { fast: 'x/fast' } }] }, {}), { baseUrl: 'b', token: 't' });
  check('…unless a role was pinned', [pinned.set.ANTHROPIC_DEFAULT_HAIKU_MODEL, pinned.set.ANTHROPIC_DEFAULT_SONNET_MODEL], ['x/fast', undefined]);
  const anth = { id: 'anthropic', type: 'anthropic', label: 'A', enabled: true, models: [], roles: {}, options: {} };
  const a = P.buildRunEnv(P.resolveModel('anthropic::opus', { providers: [claude, anth] }, {}), { baseUrl: 'b', token: 't' });
  check('first-party Anthropic keeps WebSearch and the CLI defaults', [a.extraArgs, a.set.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, a.set.CLAUDE_CODE_MAX_CONTEXT_TOKENS], [[], undefined, undefined]);
}

console.log('bridge run context:');
{
  const ctx = P.buildRunCtx(P.resolveModel('deepseek::deepseek-reasoner', reg, {}), { purpose: 'task', taskId: 't1', effort: 'high' });
  check('carries provider credentials for the bridge only', [ctx.provider.apiKey, ctx.provider.baseUrl, ctx.provider.dialect], ['sk-ds', 'https://api.deepseek.com/v1', 'deepseek']);
  check('main model, caps of every role model, alias map, fallback', [ctx.model, Object.keys(ctx.models).sort(), ctx.modelMap.haiku, ctx.modelMap.opus, ctx.fallbackModel], ['deepseek-reasoner', ['deepseek-chat', 'deepseek-reasoner'], 'deepseek-chat', 'deepseek-reasoner', 'deepseek-chat']);
  check('effort is the source of truth; Auto means "send none", never the CLI\'s own "high"', [ctx.effort, P.buildRunCtx(P.resolveModel('deepseek::deepseek-chat', reg, {}), { effort: 'auto' }).effort, P.buildRunCtx(P.resolveModel('deepseek::deepseek-chat', reg, {}), {}).effort], ['high', 'auto', 'auto']);
  check('metadata for the usage ledger', [ctx.purpose, ctx.taskId, typeof ctx.runId], ['task', 't1', 'string']);
}

console.log('catalogues:');
{
  const or = P.normalizeCatalog({ data: [
    { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', context_length: 1000000, supported_parameters: ['tools', 'reasoning'],
      architecture: { input_modalities: ['text', 'image', 'file'] }, top_provider: { max_completion_tokens: 64000 }, pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' } },
    { id: 'meta/llama:free', supported_parameters: ['temperature'], architecture: { input_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' } },
    { id: 'bad id' }, { id: 'meta/llama:free' },
  ] });
  check('OpenRouter/Kilo shape: caps, window, output cap', or[0].caps, { tools: true, vision: true, reasoning: true, pdf: true, contextWindow: 1000000, maxOutput: 64000 });
  check('…pricing converted from per-token to per-1M', or[0].pricing, { in: 3, out: 15, cacheRead: 0.3 });
  check('…an explicit "no tools" survives, junk and duplicates dropped', [or.length, or[1].caps.tools, or[1].pricing], [2, false, { in: 0, out: 0 }]);
  check('OpenAI shape (ids only) → unknown caps', P.normalizeCatalog({ object: 'list', data: [{ id: 'gpt-5', object: 'model' }] })[0], { id: 'gpt-5', label: 'gpt-5', caps: { ...P.UNKNOWN_CAPS }, pricing: null });
  check('Anthropic shape uses display_name', P.normalizeCatalog({ data: [{ type: 'model', id: 'claude-opus-5', display_name: 'Claude Opus 5' }] })[0].label, 'Claude Opus 5');
}

console.log('pickers and validation:');
{
  const c = P.listChoices(reg);
  check('disabled providers are not offered', c.providers.map(p => p.id), ['claude', 'gateway', 'deepseek']);
  check('Claude-serving providers offer the four aliases first', c.providers[1].models.map(m => m.ref), ['gateway::haiku', 'gateway::sonnet', 'gateway::opus', 'gateway::fable', 'gateway::z-ai/glm-5:free']);
  check('an OpenAI-compatible provider offers its own models only', c.providers[2].models.map(m => m.id), ['deepseek-chat', 'deepseek-reasoner']);
  check('no key ever reaches a choice list', JSON.stringify(c).includes('sk-ds') || JSON.stringify(c).includes('kgw'), false);
  check('the default is marked', c.providers.filter(p => p.isDefault).map(p => p.id), ['gateway']);
  check('isKnownModel', ['sonnet', 'gateway::opus', 'deepseek::anything-new', 'off::m', 'ghost::x', 'a b'].map(v => P.isKnownModel(v, reg)), [true, true, true, false, false, false]);
  check('describeModel', [P.describeModel('deepseek::deepseek-chat', reg), P.describeModel('opus', reg)], ['DeepSeek · deepseek-chat', 'opus']);
  check('computeCost', P.computeCost({ inputTokens: 1000000, outputTokens: 500000, cacheReadTokens: 2000000 }, { in: 3, out: 15, cacheRead: 0.3 }), 11.1);
  check('computeCost without a price is unknown, not zero', P.computeCost({ inputTokens: 5 }, null), null);
}
{
  const v = P.validateProviderInput({ id: 'my-oai', type: 'openai-compatible', label: 'Mine', baseUrl: 'https://x.example/v1/', apiKey: ' sk ', dialect: 'openai',
    headers: { 'HTTP-Referer': 'https://me' }, roles: { main: 'gpt-5', fast: '' }, options: { maxConcurrency: 4, extraBody: { a: 1 } } }, { creating: true });
  check('a good provider validates and is normalised', [v.errors, v.value.baseUrl, v.value.apiKey, v.value.roles], [[], 'https://x.example/v1', 'sk', { main: 'gpt-5' }]);
  const b = P.validateProviderInput({ id: 'Bad Id', type: 'claude-subscription', label: '', baseUrl: 'ftp://x', dialect: 'nope', headers: { 'a b': 'x' }, options: { maxConcurrency: 999 } }, { creating: true });
  check('each bad field is named', b.errors.sort(), ['baseUrl', 'dialect', 'headers', 'id', 'label', 'options.maxConcurrency', 'type'].sort());
  check('a key with a newline is refused (header injection)', P.validateProviderInput({ apiKey: 'a\nb' }).errors, ['apiKey']);
}

// ── store ───────────────────────────────────────────────────────────────────
(async () => {
  console.log('store:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-prov-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const key = crypto.randomBytes(32);
  const encrypt = (s) => { const iv = crypto.randomBytes(16); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const e = Buffer.concat([c.update(s, 'utf8'), c.final()]); return 'enc:' + Buffer.concat([iv, c.getAuthTag(), e]).toString('base64'); };
  const decrypt = (s) => { const b = Buffer.from(s.slice(4), 'base64'); const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 16)); d.setAuthTag(b.subarray(16, 32)); return d.update(b.subarray(32)).toString('utf8') + d.final('utf8'); };
  const store = createProviderStore(db, { encrypt, decrypt });

  store.seedFromEnv({ ANTHROPIC_BASE_URL: 'https://kilo.example/', ANTHROPIC_AUTH_TOKEN: 'kgw_live_secret' });
  let r = store.registry();
  check('first boot: the CLI login row and the env gateway, gateway is the default', [r.providers.map(p => p.id), r.defaultProviderId], [['claude', 'gateway'], 'gateway']);
  const gw = store.get('gateway');
  check('…seeded as an alias-serving Anthropic-compatible provider with the env token (bearer)', [gw.type, gw.aliases, gw.baseUrl, gw.apiKey, gw.authScheme, gw.source, gw.options.quietCli], ['anthropic-compatible', true, 'https://kilo.example', 'kgw_live_secret', 'bearer', 'env', false]);
  const raw = db.prepare(`SELECT api_key_enc FROM providers WHERE id='gateway'`).get().api_key_enc;
  check('the key is encrypted at rest', [raw.startsWith('enc:'), raw.includes('kgw_live')], [true, false]);
  const pub = store.publicList();
  check('the public view never carries the key', [JSON.stringify(pub).includes('kgw_live'), pub.providers[1].hasKey], [false, true]);

  store.seedFromEnv({ ANTHROPIC_BASE_URL: 'https://kilo2.example', ANTHROPIC_AUTH_TOKEN: 'kgw_live_new' });
  check('a later boot follows a changed env (the .env-and-restart habit still works)', [store.get('gateway').baseUrl, store.get('gateway').apiKey], ['https://kilo2.example', 'kgw_live_new']);
  store.update('gateway', { label: 'Kilo' });
  check('an edit in the UI makes the row the user\'s…', store.get('gateway').source, 'user');
  store.seedFromEnv({ ANTHROPIC_BASE_URL: 'https://kilo3.example', ANTHROPIC_AUTH_TOKEN: 'x' });
  check('…and env no longer rewrites it', store.get('gateway').baseUrl, 'https://kilo2.example');
  store.remove('gateway');
  store.seedFromEnv({ ANTHROPIC_BASE_URL: 'https://kilo.example', ANTHROPIC_AUTH_TOKEN: 'x' });
  check('a deleted env row is not resurrected on the next boot', [store.registry().providers.map(p => p.id), store.registry().defaultProviderId], [['claude'], 'claude']);

  store.create({ id: 'ds', type: 'openai-compatible', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-1', dialect: 'deepseek', headers: { 'X-Api-Key': 'hdr-secret', 'X-Title': 'studio' } });
  check('a secret-looking header is masked, a plain one is not', store.publicProvider(store.get('ds')).headers, { 'X-Api-Key': '***', 'X-Title': 'studio' });
  store.update('ds', { apiKey: '', headers: { 'X-Api-Key': '***', 'X-Title': 'studio2' } });
  check('blank key and "***" header keep the stored secrets', [store.get('ds').apiKey, store.get('ds').headers], ['sk-1', { 'X-Api-Key': 'hdr-secret', 'X-Title': 'studio2' }]);
  store.update('ds', { clearApiKey: true });
  check('clearApiKey clears', store.get('ds').apiKey, '');

  const res = store.upsertCatalog('ds', [{ id: 'deepseek-chat', label: 'Chat', caps: { tools: true, contextWindow: 128000 } }, { id: 'deepseek-reasoner', caps: { reasoning: true } }]);
  check('a small first catalogue is enabled wholesale', [res.autoEnabled, store.get('ds').models.map(m => [m.id, m.enabled])], [true, [['deepseek-chat', true], ['deepseek-reasoner', true]]]);
  store.setModel('ds', 'deepseek-chat', { caps: { contextWindow: 64000, vision: false } });
  store.upsertCatalog('ds', [{ id: 'deepseek-chat', caps: { tools: true, contextWindow: 128000 } }, { id: 'deepseek-v4', caps: {} }]);
  const m = store.get('ds').models;
  check('a refresh keeps the user\'s corrections over the catalogue', [m.find(x => x.id === 'deepseek-chat').caps.contextWindow, m.find(x => x.id === 'deepseek-chat').caps.vision], [64000, false]);
  check('a model that left the catalogue survives only because it was enabled; a new one arrives off', [m.map(x => x.id).sort(), m.find(x => x.id === 'deepseek-v4').enabled], [['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4'], false]);
  const big = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, caps: {} }));
  store.create({ id: 'or', type: 'openai-compatible', label: 'OR', baseUrl: 'https://openrouter.ai/api/v1' });
  check('a big first catalogue is imported switched off', [store.upsertCatalog('or', big).autoEnabled, store.get('or').models.filter(x => x.enabled).length], [false, 0]);
  store.addManualModel('or', 'my/model', { caps: { tools: true } });
  check('a manual model is enabled and kept across refreshes', (store.upsertCatalog('or', big), store.get('or').models.find(x => x.id === 'my/model').enabled), true);

  check('setDefault refuses a disabled provider', (store.update('or', { enabled: false }), store.setDefault('or')), false);
  check('the built-in row cannot be removed', store.remove('claude'), false);

  store.recordUsage({ runId: 'r1', providerId: 'ds', model: 'deepseek-chat', inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, costUsd: 0.001, status: 'ok' });
  store.recordUsage({ runId: 'r1', providerId: 'ds', model: 'deepseek-chat', inputTokens: 300, outputTokens: 10, costUsd: null, status: 'ok' });
  const u = store.usageForRun('r1');
  check('usage per run sums tokens, flags unpriced requests, keeps the last turn', [u.input, u.output, u.requests, u.unpriced, u.lastTurn.input_tokens], [400, 30, 2, 1, 300]);
  check('the summary groups by provider/model/day', store.usageSummary(7).map(x => [x.provider_id, x.requests]), [['ds', 2]]);
  db.close();

  console.log('catalogue fetch:');
  const calls = [];
  const fake = (routes) => async (url, o) => { calls.push({ url, h: o.headers }); const r = routes(url); return { ok: r.status < 400, status: r.status, json: async () => r.body }; };
  {
    const res = await fetchCatalog({ type: 'openai-compatible', baseUrl: 'https://api.x/v1', apiKey: 'sk', authScheme: 'x-api-key' }, { fetchImpl: fake(() => ({ status: 200, body: { data: [{ id: 'a' }, { id: 'b' }] } })) });
    check('OpenAI: <base>/models with a Bearer key whatever the scheme says', [res.models.map(m => m.id), calls[0].url, calls[0].h.authorization, calls[0].h['anthropic-version']], [['a', 'b'], 'https://api.x/v1/models', 'Bearer sk', undefined]);
  }
  calls.length = 0;
  {
    let n = 0;
    const res = await fetchCatalog({ type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k', authScheme: 'x-api-key' },
      { fetchImpl: fake(() => (++n === 1 ? { status: 200, body: { data: [{ id: 'claude-a' }], has_more: true, last_id: 'claude-a' } } : { status: 200, body: { data: [{ id: 'claude-b' }], has_more: false } })) });
    check('Anthropic: /v1/models, x-api-key + version header, follows pagination', [res.models.map(m => m.id), calls[0].url, calls[0].h['x-api-key'], calls[0].h['anthropic-version'], /after_id=claude-a/.test(calls[1].url)], [['claude-a', 'claude-b'], 'https://api.anthropic.com/v1/models', 'k', '2023-06-01', true]);
  }
  check('a provider without a catalogue is reachable, not broken', await fetchCatalog({ type: 'anthropic-compatible', baseUrl: 'https://x' }, { fetchImpl: fake(() => ({ status: 404, body: {} })) }), { ok: true, models: [], status: 404, noCatalog: true });
  check('a refusal names the status and the upstream message', await fetchCatalog({ type: 'openai-compatible', baseUrl: 'https://x/v1', apiKey: 'bad' }, { fetchImpl: fake(() => ({ status: 401, body: { error: { message: 'Incorrect API key' } } })) }), { ok: false, models: [], status: 401, error: 'HTTP 401: Incorrect API key' });
  check('the CLI login has no catalogue to fetch', await fetchCatalog({ type: 'claude-subscription' }), { ok: true, models: [], noCatalog: true });

  console.log('review fixes:');
  {
    const db2 = openDatabase(path.join(dir, 'r.db'));
    const st2 = createProviderStore(db2, { encrypt, decrypt });
    st2.seedFromEnv({ ANTHROPIC_BASE_URL: 'https://kilo.example', ANTHROPIC_AUTH_TOKEN: 'kgw_1',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'z-ai/glm-4.6', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'z-ai/glm-4.5-air', ANTHROPIC_DEFAULT_OPUS_MODEL: 'z-ai/glm-5',
      CLAUDE_CODE_SUBAGENT_MODEL: 'z-ai/glm-4.5-air', ANTHROPIC_CUSTOM_HEADERS: 'cf-aig-authorization: Bearer abc\nX-Title: studio' });
    const g = st2.get('gateway');
    check('the env model remaps become the seeded row\'s roles (a bare "sonnet" keeps meaning glm-4.6)', g.roles, { main: 'z-ai/glm-4.6', fast: 'z-ai/glm-4.5-air', strong: 'z-ai/glm-5', subagent: 'z-ai/glm-4.5-air' });
    check('ANTHROPIC_CUSTOM_HEADERS becomes the row\'s headers', g.headers, { 'cf-aig-authorization': 'Bearer abc', 'X-Title': 'studio' });
    const env = P.buildRunEnv(P.resolveModel('sonnet', st2.registry(), {}), { baseUrl: 'b', token: 't' });
    check('…and they reach the run as before the registry', [env.set.ANTHROPIC_DEFAULT_SONNET_MODEL, env.set.ANTHROPIC_DEFAULT_HAIKU_MODEL, env.set.CLAUDE_CODE_SUBAGENT_MODEL], ['z-ai/glm-4.6', 'z-ai/glm-4.5-air', 'z-ai/glm-4.5-air']);
    check('a Claude alias behind a Claude gateway keeps WebSearch', env.extraArgs, []);
    check('bridge runs strip the cloud-backend switches; the CLI login keeps them', [env.unset.includes('CLAUDE_CODE_USE_BEDROCK'), env.unset.includes('CLAUDE_CODE_OAUTH_TOKEN'), P.buildRunEnv(P.resolveModel('opus', st2.registry(), { engine: 'subscription' })).unset.includes('CLAUDE_CODE_USE_BEDROCK')], [true, true, false]);
    st2.update('gateway', { label: g.label, baseUrl: g.baseUrl, authScheme: g.authScheme, dialect: g.dialect, headers: { 'cf-aig-authorization': '***', 'X-Title': 'studio' }, options: g.options, roles: g.roles, aliases: true, enabled: true });
    check('pressing Save on an untouched env row does not detach it from .env', st2.get('gateway').source, 'env');
    st2.seedFromEnv({});
    check('removing ANTHROPIC_BASE_URL switches the env row off and hands the default back to the CLI login', [st2.get('gateway').enabled, st2.registry().defaultProviderId], [false, 'claude']);
    st2.seedFromEnv({ ANTHROPIC_BASE_URL: 'https://kilo.example', ANTHROPIC_AUTH_TOKEN: 'kgw_2' });
    check('putting it back re-enables the row as the default, with the new token', [st2.get('gateway').enabled, st2.registry().defaultProviderId, st2.get('gateway').apiKey], [true, 'gateway', 'kgw_2']);
    st2.update('gateway', { options: { timeoutMs: 60000, extraBody: { temperature: 2 } } });
    st2.update('gateway', { options: { timeoutMs: null, extraBody: null } });
    check('a cleared option is removed, not kept', [st2.get('gateway').options.timeoutMs, st2.get('gateway').options.extraBody, st2.get('gateway').options.quietCli], [undefined, undefined, false]);
    check('validation passes a cleared option through as null', P.validateProviderInput({ options: { timeoutMs: null, maxConcurrency: '', extraBody: null } }).value.options, { timeoutMs: null, maxConcurrency: null, extraBody: null });
    st2.create({ id: 'x', type: 'openai-compatible', label: 'X', baseUrl: 'https://x/v1' });
    st2.update('x', { type: 'anthropic-compatible' });
    check('changing the API type is stored (it was silently dropped)', st2.get('x').type, 'anthropic-compatible');
    db2.close();
  }
  {
    const r2 = { providers: [claude, { ...gateway, models: [{ id: 'z-ai/glm-5:free', enabled: true, caps: {} }] }, deepseek], defaultProviderId: 'gateway' };
    check('a bare non-alias id is known only if the default provider lists it', ['z-ai/glm-5:free', 'gpt-4o', 'haiku'].map(v => P.isKnownModel(v, r2)), [true, false, true]);
    const f = P.resolveModel('ghost::haiku', { ...r2, defaultProviderId: 'deepseek' }, {});
    check('a fallback keeps an alias\'s tier (haiku → the fast role, not main)', [f.provider.id, f.cliModel, f.fallback], ['deepseek', 'deepseek-chat', 'provider_missing']);
    const ff = P.resolveModel('ghost::opus', { ...r2, defaultProviderId: 'deepseek' }, {});
    check('…opus → the strong role', ff.cliModel, 'deepseek-reasoner');
    const fab = P.buildRunEnv(P.resolveModel('sonnet', { providers: [claude, { ...deepseek, roles: { ...deepseek.roles, fable: 'deepseek-reasoner' } }], defaultProviderId: 'deepseek' }, {}), { baseUrl: 'b', token: 't' });
    check('a pinned fable role reaches ANTHROPIC_DEFAULT_FABLE_MODEL', fab.set.ANTHROPIC_DEFAULT_FABLE_MODEL, 'deepseek-reasoner');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
