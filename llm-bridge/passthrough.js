'use strict';
// Anthropic -> Anthropic (provider.type 'anthropic' | 'anthropic-compatible'). The body is
// already in the provider's language, so the bridge only swaps credentials, maps the model,
// clamps max_tokens, and TAPS the response for usage. Response bytes are forwarded as they
// arrive — never buffered — so a passthrough stream is byte-identical to the provider's.

const { isPlainObject, deepMerge, anthropicError } = require('./util');
const { resolveModel, capsFor, clampMaxTokens } = require('./models');
const { createSseParser, parseEventJson } = require('./sse');
const { readAll } = require('./upstream');
const { transportError } = require('./errors');
const { estimateInputTokens } = require('./estimate');

/** `<base>/v1/messages` — unless the base already ends in /v1, then `<base>/messages`. */
function anthropicUrl(baseUrl, suffix) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return /\/v1$/.test(base) ? `${base}${suffix}` : `${base}/v1${suffix}`;
}

function defaultScheme(type) { return type === 'anthropic' ? 'x-api-key' : type === 'anthropic-compatible' ? 'both' : 'bearer'; }

/** Credentials per authScheme. The client's own auth headers are never copied — only ever the provider key. */
function authHeaders(provider) {
  const h = {};
  const key = provider.apiKey;
  if (!key) return h; // a local server without auth
  const scheme = provider.authScheme || defaultScheme(provider.type);
  if (scheme === 'bearer' || scheme === 'both') h.authorization = `Bearer ${key}`;
  if (scheme === 'x-api-key' || scheme === 'both') h['x-api-key'] = key;
  return h;
}

function extraHeaders(provider) {
  const h = {};
  if (isPlainObject(provider.headers)) for (const [k, v] of Object.entries(provider.headers)) if (v != null) h[k.toLowerCase()] = String(v);
  return h;
}

function passthroughHeaders(inHeaders, provider) {
  const opts = provider.options || {};
  const h = {
    'content-type': 'application/json',
    'anthropic-version': inHeaders['anthropic-version'] || '2023-06-01',
    'accept-encoding': 'identity', // we tap the bytes for usage; a gzip stream would hide it
  };
  if (inHeaders['anthropic-beta'] && !opts.stripBetas) h['anthropic-beta'] = inHeaders['anthropic-beta'];
  if (inHeaders.accept) h.accept = inHeaders.accept;
  if (inHeaders['user-agent']) h['user-agent'] = inHeaders['user-agent'];
  for (const [k, v] of Object.entries(inHeaders)) if (k.startsWith('x-claude-code-')) h[k] = v;
  return { ...h, ...authHeaders(provider), ...extraHeaders(provider) };
}

/** Response headers worth keeping: the SDK reads request-id and the retry hints. */
const KEEP_RES = /^(content-type|request-id|x-request-id|retry-after|x-should-retry|anthropic-ratelimit-.*|anthropic-organization-id)$/i;
function pickResponseHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) if (KEEP_RES.test(k)) out[k] = v;
  return out;
}

/** Usage out of an Anthropic SSE stream: message_start.message.usage, then message_delta.usage. */
function createUsageTap(sse) {
  const u = { input: null, output: null, cacheRead: null, cacheWrite: null, stopReason: null, error: null };
  const apply = (x) => {
    if (!x || typeof x !== 'object') return;
    if (x.input_tokens != null) u.input = x.input_tokens;
    if (x.output_tokens != null) u.output = x.output_tokens;
    if (x.cache_read_input_tokens != null) u.cacheRead = x.cache_read_input_tokens;
    if (x.cache_creation_input_tokens != null) u.cacheWrite = x.cache_creation_input_tokens;
  };
  let tail = '';
  const onJson = (j) => {
    if (!j || typeof j !== 'object') return;
    if (j.type === 'message_start' && j.message) apply(j.message.usage);
    else if (j.type === 'message_delta') { apply(j.usage); if (j.delta && j.delta.stop_reason) u.stopReason = j.delta.stop_reason; }
    else if (j.type === 'error') u.error = j.error || {};
    else if (j.type === 'message') { apply(j.usage); u.stopReason = j.stop_reason || null; } // non-stream body
  };
  const parser = sse ? createSseParser(({ data }) => { for (const j of parseEventJson(data)) onJson(j); }) : null;
  const chunks = [];
  let size = 0;
  return {
    usage: u,
    feed(c) {
      if (parser) { parser.feed(c); tail = (tail + c.toString('latin1')).slice(-2); }
      else if (size < 8 * 1024 * 1024) { chunks.push(c); size += c.length; }
    },
    end() {
      if (parser) parser.end();
      else { try { onJson(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { /* not JSON */ } }
    },
    /** true when everything forwarded so far ends on an event boundary (safe to append an event) */
    atBoundary: () => tail === '' || tail === '\n\n',
  };
}

/**
 * @param rc   request context from server.js
 * @param env  { acquire, sendWithRetry, calibrator }
 * @param kind 'messages' | 'count'
 */
async function handlePassthrough(rc, env, kind) {
  const p = rc.provider;
  const opts = p.options || {};
  const body = rc.body;
  const label = p.label || p.id || 'provider';
  const requestedModel = typeof body.model === 'string' ? body.model : '';
  const model = resolveModel(rc.ctx, requestedModel);
  const caps = capsFor(rc.ctx, model);
  rc.setModel(model, requestedModel);

  let out = body;
  let changed = false;
  if (model && model !== requestedModel) { out = { ...out, model }; changed = true; }
  if (kind === 'messages') {
    const mt = clampMaxTokens(out.max_tokens, caps);
    if (mt && mt !== out.max_tokens) {
      out = { ...out, max_tokens: mt };
      changed = true;
      // an explicit thinking budget must stay below max_tokens (and ≥ 1024), or Anthropic 400s
      const t = out.thinking;
      if (t && t.type === 'enabled' && Number.isInteger(t.budget_tokens) && t.budget_tokens >= mt) {
        if (mt - 1 >= 1024) out.thinking = { ...t, budget_tokens: mt - 1 };
        else { const { thinking, ...rest } = out; out = rest; }
      }
    }
  }
  if (isPlainObject(opts.extraBody)) { out = deepMerge(out, opts.extraBody); changed = true; }
  const payload = changed ? Buffer.from(JSON.stringify(out)) : rc.raw;

  let query = rc.query || '';
  if (opts.stripBetas) query = query.replace(/([?&])beta=true(&|$)/, (m, a, b) => (b ? a : '')).replace(/[?&]$/, '');
  const url = anthropicUrl(p.baseUrl, kind === 'count' ? '/messages/count_tokens' : '/messages') + query;
  const headers = passthroughHeaders(rc.req.headers, p);

  const release = kind === 'messages' ? await env.acquire(p, rc.signal).catch(() => null) : () => {};
  if (!release) { rc.finish({ status: 'aborted' }); return; }

  let up;
  try {
    up = await env.sendWithRetry(rc, { url, headers, body: payload });
  } catch (e) {
    release();
    if (rc.aborted()) { rc.finish({ status: 'aborted' }); return; }
    const m = transportError(e, label);
    rc.json(m.status, m.body, m.headers);
    rc.finish({ status: 'error', httpStatus: m.status, errorType: m.errorType });
    return;
  }
  rc.entry.upstreamStatus = up.status;

  if (up.status < 200 || up.status >= 300) {
    const { text } = await readAll(up, 1024 * 1024);
    release();
    if (kind === 'count' && (up.status === 404 || up.status === 405 || up.status === 501)) {
      // an anthropic-compatible provider without count_tokens: answer with our estimate
      rc.json(200, { input_tokens: env.calibrator.apply(rc.calKey, estimateInputTokens(body)) });
      rc.finish({ status: 'ok', httpStatus: 200 });
      return;
    }
    let errorType = null;
    try { errorType = (JSON.parse(text).error || {}).type || null; } catch { /* not JSON */ }
    const h = pickResponseHeaders(up.headers);
    if (!h['content-type']) h['content-type'] = 'application/json';
    if (!rc.res.headersSent && !rc.res.destroyed) { rc.res.writeHead(up.status, h); rc.res.end(text || JSON.stringify(anthropicError('api_error', `${label}: HTTP ${up.status}`))); }
    rc.finish({ status: 'error', httpStatus: up.status, errorType });
    return;
  }

  // 2xx: forward bytes as they come, tap for usage on the side
  const isSse = /event-stream/i.test(up.headers['content-type'] || '');
  const tap = createUsageTap(isSse);
  if (rc.res.destroyed) { up.destroy(); release(); rc.finish({ status: 'aborted' }); return; }
  rc.res.writeHead(up.status, pickResponseHeaders(up.headers));
  if (rc.res.flushHeaders) rc.res.flushHeaders();

  await new Promise((resolve) => {
    let done = false;
    const settle = (fields) => {
      if (done) return;
      done = true;
      release();
      const u = tap.usage;
      rc.finish({
        ...fields,
        inputTokens: u.input || 0, outputTokens: u.output || 0, cacheReadTokens: u.cacheRead || 0, cacheWriteTokens: u.cacheWrite || 0,
      });
      resolve();
    };
    rc.onAbort(() => { up.destroy(); settle({ status: 'aborted' }); });
    up.stream.on('data', (c) => {
      if (done) return;
      rc.markFirstByte();
      tap.feed(c);
      if (!rc.res.write(c)) { up.stream.pause(); rc.res.once('drain', () => up.stream.resume()); }
    });
    up.stream.once('end', () => {
      if (done) return;
      tap.end();
      rc.res.end();
      const err = tap.usage.error;
      settle(err ? { status: 'error', httpStatus: up.status, errorType: err.type || 'api_error' } : { status: 'ok', httpStatus: up.status });
    });
    const broken = (e) => {
      if (done) return;
      if (rc.aborted()) { settle({ status: 'aborted' }); return; }
      const m = transportError(up.reason() || e, label);
      if (isSse && tap.atBoundary()) {
        rc.res.end(`event: error\ndata: ${JSON.stringify(m.body)}\n\n`);
      } else {
        rc.res.destroy(); // mid-event: a clean end would hand the SDK half a JSON frame
      }
      settle({ status: 'error', httpStatus: up.status, errorType: m.errorType });
    };
    up.stream.once('error', broken);
    up.stream.once('close', () => { if (!up.stream.readableEnded) broken(new Error('upstream closed the connection mid-stream')); });
  });
}

module.exports = { handlePassthrough, anthropicUrl, passthroughHeaders, authHeaders, extraHeaders, createUsageTap, pickResponseHeaders };
