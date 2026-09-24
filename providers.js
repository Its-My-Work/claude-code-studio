// Provider registry — the pure half (no fs, no db, no network).
//
// Before this module the studio had exactly one provider: whatever ANTHROPIC_BASE_URL /
// ANTHROPIC_AUTH_TOKEN said at boot, and four hardcoded aliases (haiku/sonnet/opus/fable)
// to pick from. Every run still goes through the `claude` CLI — that is what gives each
// mode its tools, MCP, hooks, resume and compaction — so "another provider" means
// "another endpoint + model for THIS run", decided here and handed to the spawn.
//
// A model is stored as ONE string everywhere it already travels (sessions.model,
// tasks.model, bots.model, WS frames, MCP create_task, plan files, bot exports):
//
//     "<providerId>::<modelId>"      e.g. "deepseek::deepseek-chat", "kilo::z-ai/glm-5:free"
//     "<modelId>"                    legacy / bare: resolved on the DEFAULT provider
//
// `::` because model ids themselves carry `/` and `:` (":free"), never `::`. A bare value
// keeps every row written before this module meaning exactly what it meant: "sonnet" on
// the provider the studio used to talk to.
//
// Four provider types:
//   claude-subscription  — the CLI's own login (OAuth). No bridge, no key. The only type
//                          the tmux "Subscription" engine runs on.
//   anthropic            — Anthropic API key. Bridge in passthrough mode.
//   anthropic-compatible — any /v1/messages endpoint (a gateway such as kilo-gateway,
//                          DeepSeek/Kimi/GLM/MiniMax Anthropic endpoints). Passthrough.
//   openai-compatible    — /v1/chat/completions. Bridge TRANSLATES (llm-bridge/).
'use strict';

const crypto = require('crypto');

const PROVIDER_TYPES = ['claude-subscription', 'anthropic', 'anthropic-compatible', 'openai-compatible'];
const DIALECTS = ['generic', 'openai', 'openrouter', 'deepseek', 'gemini', 'qwen', 'mistral', 'ollama'];
const AUTH_SCHEMES = ['bearer', 'x-api-key', 'both'];
const CLAUDE_ALIASES = ['haiku', 'sonnet', 'opus', 'fable'];
const ROLE_KEYS = ['main', 'fast', 'strong', 'fable', 'subagent'];
const REF_SEP = '::';
const BUILTIN_CLAUDE_ID = 'claude';

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// Wider than gateway-models.MODEL_ID_RE on purpose: Vertex/Bedrock-style ids carry `@`,
// some local servers `+`. Still no whitespace, quotes or shell metacharacters — the value
// reaches argv (`--model`) and, for the subscription engine, a generated shell script.
const MODEL_ID_RE = /^[A-Za-z0-9._:/@+-]{1,160}$/;

/** Split a stored model value. Bare values keep `providerId: null` (= default provider). */
function parseModelRef(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;
  const i = v.indexOf(REF_SEP);
  if (i === -1) return MODEL_ID_RE.test(v) ? { providerId: null, modelId: v } : null;
  const providerId = v.slice(0, i), modelId = v.slice(i + REF_SEP.length);
  if (!PROVIDER_ID_RE.test(providerId) || !MODEL_ID_RE.test(modelId)) return null;
  return { providerId, modelId };
}

function formatModelRef(providerId, modelId) {
  return providerId ? `${providerId}${REF_SEP}${modelId}` : modelId;
}

/** True for `provider::model` (not for a bare id) — what chat-defaults accepts beyond its alias list. */
function isQualifiedRef(value) {
  const r = parseModelRef(value);
  return !!(r && r.providerId);
}

/** The model id without its provider — what a REMOTE `claude` (SSH) or the tmux engine can use. */
function bareModelId(value) {
  const r = parseModelRef(value);
  return r ? r.modelId : null;
}

// ── Presets ─────────────────────────────────────────────────────────────────
// A preset only pre-fills the form; every field stays editable. Base URLs are the
// providers' documented OpenAI- / Anthropic-compatible roots.
const PRESETS = [
  { id: 'anthropic',   label: 'Anthropic API',          type: 'anthropic',            baseUrl: 'https://api.anthropic.com',                  authScheme: 'x-api-key', aliases: true },
  { id: 'gateway',     label: 'Anthropic-compatible gateway', type: 'anthropic-compatible', baseUrl: '',                                   authScheme: 'bearer',    aliases: true },
  { id: 'openai',      label: 'OpenAI',                 type: 'openai-compatible',    baseUrl: 'https://api.openai.com/v1',                  dialect: 'openai' },
  { id: 'openrouter',  label: 'OpenRouter',             type: 'openai-compatible',    baseUrl: 'https://openrouter.ai/api/v1',               dialect: 'openrouter' },
  { id: 'deepseek',    label: 'DeepSeek (Anthropic API)', type: 'anthropic-compatible', baseUrl: 'https://api.deepseek.com/anthropic',       authScheme: 'x-api-key' },
  { id: 'deepseek-oai', label: 'DeepSeek (OpenAI API)', type: 'openai-compatible',    baseUrl: 'https://api.deepseek.com/v1',                dialect: 'deepseek' },
  { id: 'moonshot',    label: 'Kimi / Moonshot (Anthropic API)', type: 'anthropic-compatible', baseUrl: 'https://api.moonshot.ai/anthropic', authScheme: 'bearer' },
  { id: 'zai',         label: 'Z.ai GLM (Anthropic API)', type: 'anthropic-compatible', baseUrl: 'https://api.z.ai/api/anthropic',           authScheme: 'bearer' },
  { id: 'minimax',     label: 'MiniMax (Anthropic API)', type: 'anthropic-compatible', baseUrl: 'https://api.minimax.io/anthropic',          authScheme: 'bearer' },
  { id: 'qwen',        label: 'Qwen / DashScope',       type: 'openai-compatible',    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', dialect: 'qwen' },
  { id: 'gemini',      label: 'Google Gemini',          type: 'openai-compatible',    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', dialect: 'gemini' },
  { id: 'groq',        label: 'Groq',                   type: 'openai-compatible',    baseUrl: 'https://api.groq.com/openai/v1',             dialect: 'generic' },
  { id: 'mistral',     label: 'Mistral',                type: 'openai-compatible',    baseUrl: 'https://api.mistral.ai/v1',                  dialect: 'mistral' },
  { id: 'xai',         label: 'xAI Grok',               type: 'openai-compatible',    baseUrl: 'https://api.x.ai/v1',                        dialect: 'generic' },
  { id: 'ollama',      label: 'Ollama (local)',         type: 'openai-compatible',    baseUrl: 'http://localhost:11434/v1',                  dialect: 'ollama', noKey: true },
  { id: 'lmstudio',    label: 'LM Studio (local)',      type: 'openai-compatible',    baseUrl: 'http://localhost:1234/v1',                   dialect: 'generic', noKey: true },
  { id: 'custom-oai',  label: 'OpenAI-compatible (custom)', type: 'openai-compatible', baseUrl: '',                                       dialect: 'generic' },
];

// ── Capabilities ────────────────────────────────────────────────────────────
// null = unknown. Only an explicit `false` restricts anything: an unknown model is
// offered everywhere (like gateway-models did), a model that SAYS it has no tools is
// kept out of agent modes.
const CAP_KEYS = ['tools', 'vision', 'reasoning', 'pdf', 'contextWindow', 'maxOutput'];
const CLAUDE_CAPS = Object.freeze({ tools: true, vision: true, reasoning: true, pdf: true, contextWindow: null, maxOutput: null });
const UNKNOWN_CAPS = Object.freeze({ tools: null, vision: null, reasoning: null, pdf: null, contextWindow: null, maxOutput: null });

function normalizeCaps(raw) {
  const out = { ...UNKNOWN_CAPS };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of ['tools', 'vision', 'reasoning', 'pdf']) {
    if (raw[k] === true || raw[k] === false) out[k] = raw[k];
  }
  for (const k of ['contextWindow', 'maxOutput']) {
    const n = Number(raw[k]);
    if (Number.isFinite(n) && n > 0) out[k] = Math.trunc(n);
  }
  return out;
}

/** Pricing in USD per 1M tokens. */
function normalizePricing(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const k of ['in', 'out', 'cacheRead']) {
    // Number(null) is 0: an ABSENT price must stay absent, not become "free".
    if (raw[k] == null || raw[k] === '') continue;
    const n = Number(raw[k]);
    if (Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return Object.keys(out).length ? out : null;
}

// ── Catalogue normalisation ─────────────────────────────────────────────────
// One parser for every /models shape we meet: OpenAI (`{data:[{id}]}`, ids only),
// OpenRouter/Kilo (context_length, supported_parameters, architecture, pricing per
// TOKEN as strings), Anthropic (`{data:[{type:'model', id, display_name}]}`), Ollama.
function perMillion(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : null;
}

function normalizeCatalog(json) {
  const arr = Array.isArray(json) ? json : (json && (json.data || json.models));
  if (!Array.isArray(arr)) return [];
  const seen = new Set(), out = [];
  for (const m of arr) {
    if (!m || typeof m !== 'object') continue;
    const id = typeof m.id === 'string' ? m.id.trim() : (typeof m.name === 'string' && !m.id ? m.name.trim() : '');
    if (!id || !MODEL_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : null;
    const mods = Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities
      : (Array.isArray(m.input_modalities) ? m.input_modalities : null);
    const caps = normalizeCaps({
      tools: params ? params.includes('tools') : (m.capabilities?.tools ?? m.supports_tools),
      reasoning: params ? (params.includes('reasoning') || params.includes('include_reasoning')) : (m.capabilities?.reasoning ?? m.supports_reasoning),
      vision: mods ? mods.includes('image') : (m.capabilities?.vision ?? m.supports_vision),
      pdf: mods ? mods.includes('file') : null,
      contextWindow: m.context_length ?? m.context_window ?? m.max_input_tokens ?? m.top_provider?.context_length,
      maxOutput: m.top_provider?.max_completion_tokens ?? m.max_output_tokens ?? m.max_tokens,
    });
    let pricing = null;
    if (m.pricing && typeof m.pricing === 'object') {
      pricing = normalizePricing({ in: perMillion(m.pricing.prompt), out: perMillion(m.pricing.completion), cacheRead: perMillion(m.pricing.input_cache_read) });
    }
    const label = [m.display_name, m.name].find(s => typeof s === 'string' && s.trim()) || id;
    out.push({ id, label: String(label).trim().substring(0, 120), caps, pricing });
  }
  return out;
}

// ── Resolution ──────────────────────────────────────────────────────────────
// registry: { providers: ProviderRecord[], defaultProviderId, utilityModel }
// ProviderRecord (decrypted, server-side only):
//   { id, type, label, enabled, source, baseUrl, apiKey, authScheme, headers, dialect,
//     options, roles: {main, fast, strong, subagent}, aliases: bool,
//     models: [{ id, label, enabled, source, caps, pricing }] }

function findProvider(registry, id) {
  return (registry && Array.isArray(registry.providers)) ? registry.providers.find(p => p.id === id) || null : null;
}

function builtinClaude(registry) {
  return findProvider(registry, BUILTIN_CLAUDE_ID)
    || { id: BUILTIN_CLAUDE_ID, type: 'claude-subscription', label: 'Claude', enabled: true, aliases: true, models: [], roles: {}, options: {} };
}

/** The provider a BARE value means for this engine. */
function defaultProviderFor(registry, engine) {
  if (engine === 'subscription') return builtinClaude(registry);
  const d = findProvider(registry, registry && registry.defaultProviderId);
  if (d && d.enabled !== false) return d;
  return builtinClaude(registry);
}

function supportsAliases(p) {
  if (p.type === 'claude-subscription' || p.type === 'anthropic') return true;
  if (p.type === 'openai-compatible') return false;
  return p.aliases === true;
}

function enabledModels(p) {
  return (Array.isArray(p.models) ? p.models : []).filter(m => m && m.enabled !== false);
}

/** A role → upstream model id, falling back to `main`, then the first enabled model. */
function roleModel(p, role) {
  const r = p.roles || {};
  if (r[role]) return r[role];
  if (r.main) return r.main;
  const first = enabledModels(p)[0];
  return first ? first.id : null;
}

// roleModel() falls back to `main` for an unset role, so `fable` means main unless pinned.
const ALIAS_ROLE = { haiku: 'fast', sonnet: 'main', opus: 'strong', fable: 'fable' };

function capsFor(p, modelId) {
  const m = (Array.isArray(p.models) ? p.models : []).find(x => x && x.id === modelId);
  if (m) return normalizeCaps(m.caps);
  if ((p.type === 'claude-subscription' || p.type === 'anthropic') || CLAUDE_ALIASES.includes(modelId) || /^claude-/i.test(modelId)) return { ...CLAUDE_CAPS };
  return { ...UNKNOWN_CAPS };
}

function pricingFor(p, modelId) {
  const m = (Array.isArray(p.models) ? p.models : []).find(x => x && x.id === modelId);
  return m ? normalizePricing(m.pricing) : null;
}

/**
 * Resolve a stored model value for one run.
 * @param value   what the row/frame carries ('sonnet', 'deepseek::deepseek-chat', …)
 * @param opts    { engine: 'api'|'subscription'|'ssh' }
 * @returns {{ok:true, ref, provider, modelId, cliModel, caps, pricing, engine, routing, fallback?:string, engineChanged?:boolean}
 *          | {ok:false, error:string}}
 *   routing: 'oauth'  — the CLI's own login, nothing injected
 *            'bridge' — ANTHROPIC_BASE_URL = the local llm-bridge, run token as the key
 *            'remote' — SSH: the remote host's own `claude` config decides
 */
function resolveModel(value, registry, opts = {}) {
  const engine = opts.engine || 'api';
  const parsed = parseModelRef(value == null || value === '' ? 'sonnet' : String(value));
  if (!parsed) return { ok: false, error: 'invalid_model' };

  let provider, fallback = null;
  if (parsed.providerId) {
    provider = findProvider(registry, parsed.providerId);
    if (!provider || provider.enabled === false) {
      // A chat pinned to a provider that was deleted or switched off must still run —
      // on the default, and the caller says so — rather than fail every turn forever.
      fallback = provider ? 'provider_disabled' : 'provider_missing';
      provider = defaultProviderFor(registry, engine);
    }
  } else {
    provider = defaultProviderFor(registry, engine);
  }

  let modelId = parsed.modelId;
  // On a fallback an ALIAS keeps meaning its tier ("claude::haiku" for titles stays a fast
  // model on the default); any other id of the lost provider means nothing here → main.
  if (fallback && !CLAUDE_ALIASES.includes(modelId)) {
    modelId = supportsAliases(provider) ? 'sonnet' : roleModel(provider, 'main');
  } else if (CLAUDE_ALIASES.includes(modelId) && !supportsAliases(provider)) {
    modelId = roleModel(provider, ALIAS_ROLE[modelId]);
  }
  if (!modelId) return { ok: false, error: 'no_model', providerId: provider.id };

  let effEngine = engine, engineChanged = false;
  if (engine === 'subscription' && provider.type !== 'claude-subscription') { effEngine = 'api'; engineChanged = true; }
  const routing = effEngine === 'ssh' ? 'remote' : (provider.type === 'claude-subscription' ? 'oauth' : 'bridge');

  return {
    ok: true,
    ref: formatModelRef(provider.id, modelId),
    provider, modelId,
    cliModel: modelId,
    caps: capsFor(provider, modelId),
    pricing: pricingFor(provider, modelId),
    engine: effEngine, engineChanged, routing,
    ...(fallback ? { fallback } : {}),
  };
}

/** Engine a run should really use: the tmux Subscription engine runs Claude's own login only. */
function effectiveEngine(engine, value, registry) {
  if (engine !== 'subscription') return engine;
  const r = resolveModel(value, registry, { engine });
  return r.ok ? r.engine : engine;
}

// ── Environment for one run ─────────────────────────────────────────────────
// Every variable a provider decision may set. They are stripped from the inherited
// environment FIRST, so a stale ANTHROPIC_BASE_URL in the server's own env (docker
// compose still passes it) can never leak into a run that chose another provider.
// Switches that route the CLI to a cloud backend (or an OAuth token that outranks the
// login). They rank ABOVE ANTHROPIC_BASE_URL in the CLI, so a bridge or direct run must
// not inherit them — but a run on the CLI's own configuration (routing 'oauth') keeps them.
const BACKEND_ENV_VARS = [
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
];

const PROVIDER_ENV_VARS = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
  'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
];

// The CLI asks for up to 64K output tokens by default; many models answer that with a 400.
const MAX_OUTPUT_CEILING = 32000;

/**
 * @param target  resolveModel() result
 * @param bridge  { baseUrl, token } for routing 'bridge'
 * @returns {{ set: Object<string,string>, unset: string[], extraArgs: string[] }}
 */
function buildRunEnv(target, bridge = {}) {
  const set = {}, unset = PROVIDER_ENV_VARS.slice(), extraArgs = [];
  if (!target || !target.ok || target.routing === 'oauth' || target.routing === 'remote') {
    return { set, unset, extraArgs };
  }
  unset.push(...BACKEND_ENV_VARS);
  const p = target.provider, caps = target.caps || UNKNOWN_CAPS, o = p.options || {};
  const firstParty = p.type === 'anthropic';
  // A gateway that serves the Claude aliases, running a Claude model, is Claude as far as
  // the CLI is concerned — before the registry every run looked exactly like this.
  const claudeViaGateway = supportsAliases(p) && (CLAUDE_ALIASES.includes(target.modelId) || /^claude-/i.test(target.modelId));
  set.ANTHROPIC_BASE_URL = bridge.baseUrl;
  set.ANTHROPIC_AUTH_TOKEN = bridge.token;

  // Which model the CLI's OWN background calls use. It asks for "haiku" (WebFetch
  // summaries, Explore sub-agents) and "sonnet"/"opus" by alias; a provider that does
  // not serve Claude would answer every one of those with 404.
  // A provider that serves the aliases itself (a Claude gateway) keeps its own mapping
  // unless a role was pinned explicitly; any other provider always gets one.
  const aliases = supportsAliases(p);
  const r = p.roles || {};
  const haiku = aliases ? (r.fast || null) : (roleModel(p, 'fast') || target.modelId);
  const sonnet = aliases ? (r.main || null) : (roleModel(p, 'main') || target.modelId);
  const opus = aliases ? (r.strong || null) : (roleModel(p, 'strong') || target.modelId);
  if (haiku) { set.ANTHROPIC_DEFAULT_HAIKU_MODEL = haiku; set.ANTHROPIC_SMALL_FAST_MODEL = haiku; }
  const fable = aliases ? (r.fable || r.main || null) : (roleModel(p, 'fable') || target.modelId);
  if (sonnet) set.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnet;
  if (fable) set.ANTHROPIC_DEFAULT_FABLE_MODEL = fable;
  if (opus) set.ANTHROPIC_DEFAULT_OPUS_MODEL = opus;
  if (r.subagent) set.CLAUDE_CODE_SUBAGENT_MODEL = r.subagent;

  if (!firstParty) {
    // For an id the CLI does not recognise it assumes a 200K window and compacts on
    // that — too late for a 128K model, far too early for a 1M one.
    if (caps.contextWindow) set.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(caps.contextWindow);
    // WebSearch is an Anthropic SERVER tool: behind any other endpoint the nested call
    // answers without searching. The `web` MCP server (SearXNG) is the working substitute.
    // A Claude model behind a Claude gateway keeps it, as it always had.
    if (!claudeViaGateway) extraArgs.push('--disallowedTools', 'WebSearch');
  }
  if (caps.maxOutput) set.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.min(caps.maxOutput, MAX_OUTPUT_CEILING));
  if (caps.reasoning === false) set.CLAUDE_CODE_DISABLE_THINKING = '1';
  if (p.type === 'openai-compatible' || o.stripBetas) set.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
  if (o.quietCli !== false && !firstParty) set.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  if (Number(o.apiTimeoutMs) > 0) set.API_TIMEOUT_MS = String(Math.trunc(Number(o.apiTimeoutMs)));
  return { set, unset, extraArgs };
}

/** Apply buildRunEnv() to a copied environment object (mutates and returns it). */
function applyRunEnv(env, runEnv) {
  if (!runEnv) return env;
  for (const k of runEnv.unset) delete env[k];
  for (const [k, v] of Object.entries(runEnv.set)) { if (v != null && v !== '') env[k] = String(v); }
  return env;
}

// ── Bridge run context ──────────────────────────────────────────────────────
/** The provider as the bridge sees it (llm-bridge/server.js ProviderCfg). */
function providerCfg(p) {
  return {
    id: p.id, label: p.label, type: p.type,
    baseUrl: p.baseUrl, apiKey: p.apiKey || '', authScheme: p.authScheme || 'bearer',
    headers: p.headers || {}, dialect: p.dialect || 'generic', options: p.options || {},
  };
}

/** What the llm-bridge needs to serve one run (see llm-bridge/server.js RunCtx). */
function buildRunCtx(target, meta = {}) {
  const p = target.provider;
  const models = {}, modelMap = {};
  const add = (id) => { if (id && !models[id]) models[id] = capsFor(p, id); };
  add(target.modelId);
  for (const role of ROLE_KEYS) add((p.roles || {})[role]);
  if (!supportsAliases(p)) {
    for (const a of CLAUDE_ALIASES) {
      const id = roleModel(p, ALIAS_ROLE[a]) || target.modelId;
      modelMap[a] = id; add(id);
    }
  }
  return {
    runId: meta.runId || crypto.randomBytes(8).toString('hex'),
    purpose: meta.purpose || 'chat',
    sessionId: meta.sessionId || null,
    taskId: meta.taskId || null,
    botId: meta.botId || null,
    provider: providerCfg(p),
    model: target.modelId,
    models, modelMap,
    fallbackModel: supportsAliases(p) ? null : (roleModel(p, 'fast') || target.modelId),
    // 'auto' = send the provider no effort at all. Measured on CLI 2.1.281: with no --effort
    // flag the CLI still sends effort "high" itself, so null ("use the request's") would turn
    // the toolbar's Auto into High on every reasoning model.
    effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(meta.effort) ? meta.effort : 'auto',
  };
}

// ── Choices for the pickers ─────────────────────────────────────────────────
function publicModel(p, m) {
  return { ref: formatModelRef(p.id, m.id), id: m.id, label: m.label || m.id, caps: normalizeCaps(m.caps), pricing: normalizePricing(m.pricing) };
}

/** Grouped list every model picker renders. Never carries a key. */
function listChoices(registry) {
  const providers = [];
  for (const p of (registry && registry.providers) || []) {
    if (p.enabled === false) continue;
    const models = [];
    if (supportsAliases(p)) {
      for (const a of CLAUDE_ALIASES) models.push({ ref: formatModelRef(p.id, a), id: a, label: a, alias: true, caps: { ...CLAUDE_CAPS }, pricing: null });
    }
    for (const m of enabledModels(p)) {
      if (CLAUDE_ALIASES.includes(m.id)) continue;
      models.push(publicModel(p, m));
    }
    providers.push({ id: p.id, label: p.label, type: p.type, builtin: p.id === BUILTIN_CLAUDE_ID, isDefault: p.id === (registry.defaultProviderId || BUILTIN_CLAUDE_ID), models });
  }
  // utilityModel stays '' when unset: the pickers show that as "haiku on the default provider".
  return { defaultProviderId: registry && registry.defaultProviderId || BUILTIN_CLAUDE_ID, utilityModel: (registry && registry.utilityModel) || '', providers };
}

/** Is this value something a run can use right now? (for write-time validation) */
function isKnownModel(value, registry) {
  const r = parseModelRef(value);
  if (!r) return false;
  // Bare: an alias always resolves; any other bare id only if the DEFAULT provider lists
  // it — an agent naming "gpt-4o" must not produce a task that then fails on the login.
  if (!r.providerId) {
    if (CLAUDE_ALIASES.includes(r.modelId)) return true;
    const d = defaultProviderFor(registry, 'api');
    return !!(d && (d.models || []).some(m => m && m.id === r.modelId));
  }
  const p = findProvider(registry, r.providerId);
  if (!p || p.enabled === false) return false;
  if (supportsAliases(p) && CLAUDE_ALIASES.includes(r.modelId)) return true;
  if (!supportsAliases(p) && CLAUDE_ALIASES.includes(r.modelId)) return !!roleModel(p, ALIAS_ROLE[r.modelId]);
  // A model the catalogue does not list is still accepted: catalogues lag (and some
  // providers publish none), and a hand-typed id is a legitimate choice.
  return true;
}

/** Human label for a stored value, e.g. "DeepSeek · deepseek-chat". */
function describeModel(value, registry) {
  const r = parseModelRef(value);
  if (!r) return String(value || '');
  if (!r.providerId) return r.modelId;
  const p = findProvider(registry, r.providerId);
  const m = p && (p.models || []).find(x => x.id === r.modelId);
  return `${p ? p.label : r.providerId} · ${m && m.label ? m.label : r.modelId}`;
}

/** Cost in USD of one usage record under a pricing table (USD per 1M tokens). */
function computeCost(u, pricing) {
  if (!u || !pricing) return null;
  const inp = Number(u.inputTokens) || 0, out = Number(u.outputTokens) || 0, cr = Number(u.cacheReadTokens) || 0;
  const c = (inp * (pricing.in || 0) + out * (pricing.out || 0) + cr * (pricing.cacheRead != null ? pricing.cacheRead : (pricing.in || 0))) / 1e6;
  return Math.round(c * 1e6) / 1e6;
}

// ── Validation of a provider record coming from the API ─────────────────────
function validateProviderInput(raw, { creating } = {}) {
  const errors = [];
  const out = {};
  if (!raw || typeof raw !== 'object') return { errors: ['body'], value: out };
  if (creating) {
    if (!PROVIDER_ID_RE.test(String(raw.id || ''))) errors.push('id');
    else out.id = raw.id;
  }
  if (raw.type !== undefined) {
    if (!PROVIDER_TYPES.includes(raw.type) || raw.type === 'claude-subscription') errors.push('type');
    else out.type = raw.type;
  } else if (creating) errors.push('type');
  if (raw.label !== undefined) {
    const l = String(raw.label).trim();
    if (!l || l.length > 60) errors.push('label'); else out.label = l;
  } else if (creating) errors.push('label');
  if (raw.baseUrl !== undefined) {
    const u = String(raw.baseUrl).trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/?#]+[^\s]*$/i.test(u)) errors.push('baseUrl'); else out.baseUrl = u;
  } else if (creating) errors.push('baseUrl');
  if (raw.authScheme !== undefined) {
    if (!AUTH_SCHEMES.includes(raw.authScheme)) errors.push('authScheme'); else out.authScheme = raw.authScheme;
  }
  if (raw.dialect !== undefined) {
    if (!DIALECTS.includes(raw.dialect)) errors.push('dialect'); else out.dialect = raw.dialect;
  }
  if (raw.apiKey !== undefined && raw.apiKey !== null) {
    const k = String(raw.apiKey);
    if (k.length > 4096 || /[\r\n]/.test(k)) errors.push('apiKey'); else out.apiKey = k.trim();
  }
  if (raw.headers !== undefined) {
    if (!raw.headers || typeof raw.headers !== 'object' || Array.isArray(raw.headers)) errors.push('headers');
    else {
      const h = {};
      for (const [k, v] of Object.entries(raw.headers)) {
        if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || typeof v !== 'string' || /[\r\n]/.test(v) || v.length > 2048) { errors.push('headers'); break; }
        h[k] = v;
      }
      out.headers = h;
    }
  }
  if (raw.roles !== undefined) {
    if (!raw.roles || typeof raw.roles !== 'object') errors.push('roles');
    else {
      const r = {};
      for (const k of ROLE_KEYS) {
        const v = raw.roles[k];
        if (v == null || v === '') continue;
        if (typeof v !== 'string' || !MODEL_ID_RE.test(v)) { errors.push('roles'); break; }
        r[k] = v;
      }
      out.roles = r;
    }
  }
  if (raw.aliases !== undefined) out.aliases = !!raw.aliases;
  if (raw.enabled !== undefined) out.enabled = !!raw.enabled;
  if (raw.options !== undefined) {
    if (!raw.options || typeof raw.options !== 'object' || Array.isArray(raw.options)) errors.push('options');
    else {
      const o = {};
      // An explicit null (a cleared form field) means "remove it" — providers-store drops
      // null keys on merge; an absent key leaves the stored value alone.
      const num = (k, min, max) => { const v = raw.options[k]; if (v === undefined) return; if (v === null || v === '') { o[k] = null; return; } const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) errors.push(`options.${k}`); else o[k] = Math.trunc(n); };
      num('timeoutMs', 10000, 3600000);
      num('apiTimeoutMs', 10000, 3600000);
      num('maxConcurrency', 1, 64);
      for (const b of ['stripBetas', 'quietCli']) if (raw.options[b] !== undefined) o[b] = !!raw.options[b];
      if (raw.options.extraBody === null) o.extraBody = null;
      else if (raw.options.extraBody !== undefined) {
        const eb = raw.options.extraBody;
        if (typeof eb !== 'object' || Array.isArray(eb) || JSON.stringify(eb).length > 8192) errors.push('options.extraBody'); else o.extraBody = eb;
      }
      out.options = o;
    }
  }
  return { errors: [...new Set(errors)], value: out };
}

module.exports = {
  PROVIDER_TYPES, DIALECTS, AUTH_SCHEMES, CLAUDE_ALIASES, ROLE_KEYS, REF_SEP, BUILTIN_CLAUDE_ID,
  PROVIDER_ID_RE, MODEL_ID_RE, PRESETS, CAP_KEYS, CLAUDE_CAPS, UNKNOWN_CAPS, PROVIDER_ENV_VARS, MAX_OUTPUT_CEILING,
  parseModelRef, formatModelRef, isQualifiedRef, bareModelId,
  normalizeCaps, normalizePricing, normalizeCatalog,
  findProvider, defaultProviderFor, supportsAliases, roleModel, capsFor,
  resolveModel, effectiveEngine, buildRunEnv, applyRunEnv, buildRunCtx, providerCfg, BACKEND_ENV_VARS,
  listChoices, isKnownModel, describeModel, computeCost, validateProviderInput,
};
