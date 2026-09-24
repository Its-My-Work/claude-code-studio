// Reading a provider's model catalogue — the one network call the registry makes itself.
// (Model TRAFFIC goes through llm-bridge/; this is only GET /models.)
//
// Two shapes:
//   openai-compatible            GET <base>/models        Authorization: Bearer <key>
//   anthropic / -compatible      GET <base>/v1/models     x-api-key and/or Bearer, anthropic-version
// A provider that publishes no catalogue (404) is not an error for "Test": the endpoint
// answered, so the key and URL are fine; the user adds model ids by hand.
'use strict';

const { normalizeCatalog } = require('./providers');

const TIMEOUT_MS = 10000;
const MAX_PAGES = 5;

function authHeaders(p) {
  const h = { accept: 'application/json', ...(p.headers || {}) };
  const key = p.apiKey || '';
  if (key) {
    const scheme = p.type === 'openai-compatible' ? 'bearer' : (p.authScheme || 'bearer');
    if (scheme === 'bearer' || scheme === 'both') h.authorization = `Bearer ${key}`;
    if (scheme === 'x-api-key' || scheme === 'both') h['x-api-key'] = key;
  }
  if (p.type !== 'openai-compatible') h['anthropic-version'] = '2023-06-01';
  return h;
}

function modelsUrl(p) {
  const base = String(p.baseUrl || '').replace(/\/+$/, '');
  if (p.type === 'openai-compatible') return `${base}/models`;
  return /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
}

async function getJson(url, headers, fetchImpl, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { headers, signal: ctl.signal });
    let body = null;
    try { body = await r.json(); } catch {}
    return { status: r.status, ok: r.ok, body };
  } finally { clearTimeout(timer); }
}

function errText(e) {
  if (e && e.name === 'AbortError') return 'timeout';
  const c = e && (e.cause && (e.cause.code || e.cause.message));
  return String(c || (e && e.message) || e).substring(0, 160);
}

function upstreamMessage(body) {
  if (!body || typeof body !== 'object') return '';
  const e = body.error;
  if (typeof e === 'string') return e;
  if (e && typeof e.message === 'string') return e.message;
  if (typeof body.message === 'string') return body.message;
  if (typeof body.detail === 'string') return body.detail;
  return '';
}

/**
 * @returns {Promise<{ok:boolean, models:Array, status?:number, error?:string, noCatalog?:boolean}>}
 */
async function fetchCatalog(p, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!p || p.type === 'claude-subscription') return { ok: true, models: [], noCatalog: true };
  if (!p.baseUrl) return { ok: false, models: [], error: 'no_base_url' };
  const headers = authHeaders(p);
  const all = [];
  let url = modelsUrl(p), pages = 0;
  try {
    while (url && pages < MAX_PAGES) {
      pages++;
      const r = await getJson(url, headers, fetchImpl, timeoutMs);
      if (r.status === 404 || r.status === 405) return { ok: true, models: all, status: r.status, noCatalog: all.length === 0 };
      if (!r.ok) {
        const msg = upstreamMessage(r.body);
        return { ok: false, models: [], status: r.status, error: `HTTP ${r.status}${msg ? ': ' + msg.substring(0, 160) : ''}` };
      }
      all.push(...normalizeCatalog(r.body));
      // Anthropic's list paginates with has_more/last_id; OpenAI-style lists do not.
      if (r.body && r.body.has_more && r.body.last_id && p.type !== 'openai-compatible') {
        const u = new URL(modelsUrl(p));
        u.searchParams.set('after_id', r.body.last_id);
        u.searchParams.set('limit', '1000');
        url = u.toString();
      } else url = null;
    }
  } catch (e) {
    return { ok: false, models: [], error: errText(e) };
  }
  const seen = new Set();
  return { ok: true, models: all.filter(m => (seen.has(m.id) ? false : (seen.add(m.id), true))) };
}

module.exports = { fetchCatalog, authHeaders, modelsUrl, TIMEOUT_MS };
