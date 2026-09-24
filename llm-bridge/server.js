'use strict';
// The bridge's HTTP server: what `claude` talks to as ANTHROPIC_BASE_URL. It authenticates the
// per-run token, finds the run's provider/model/effort, and hands the request to passthrough
// (Anthropic-shaped providers) or translate (OpenAI-compatible ones).
//
//   const srv = createBridgeServer({ getRun, onUsage, log });
//   await srv.listen(0, '127.0.0.1');   // -> { port }
//
// Routes (any path PREFIX is tolerated — the CLI appends /v1/messages to whatever base it got —
// and so is any query string, e.g. ?beta=true):
//   POST …/v1/messages               stream and non-stream
//   POST …/v1/messages/count_tokens
//   GET  …/v1/models, …/v1/models/<id>
//   GET  /health                     no auth
// Prompt content is never logged: the request log holds ids, sizes, statuses and token counts.

const http = require('http');
const { anthropicError, sleep } = require('./util');
const { send, discard, RETRYABLE_CODES } = require('./upstream');
const { createLimiter } = require('./limiter');
const { createCalibrator, estimateInputTokens } = require('./estimate');
const { handlePassthrough } = require('./passthrough');
const { handleTranslate } = require('./openai');

const MAX_BODY = 64 * 1024 * 1024;
const LOG_KEEP = 200;
const RETRY_STATUSES = new Set([502, 503, 504]);
const MODELS_CREATED_AT = '2025-01-01T00:00:00Z';

function normalizeLog(log) {
  const noop = () => {};
  const l = log || {};
  return {
    debug: typeof l.debug === 'function' ? l.debug.bind(l) : noop,
    info: typeof l.info === 'function' ? l.info.bind(l) : noop,
    warn: typeof l.warn === 'function' ? l.warn.bind(l) : noop,
    error: typeof l.error === 'function' ? l.error.bind(l) : noop,
  };
}

function tokenOf(req) {
  const k = req.headers['x-api-key'];
  if (typeof k === 'string' && k.trim()) return k.trim();
  const a = req.headers.authorization;
  if (typeof a === 'string') { const m = /^Bearer\s+(.+)$/i.exec(a.trim()); if (m) return m[1].trim(); }
  return null;
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      n += c.length;
      if (n > max) { over = true; chunks.length = 0; return; } // keep draining, answer 413 at the end
      chunks.push(c);
    });
    req.on('end', () => (over ? reject(Object.assign(new Error('too large'), { code: 'E2BIG' })) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
    req.on('close', () => { if (!req.complete) reject(Object.assign(new Error('client disconnected'), { code: 'ABORTED' })); });
  });
}

/** Sleep that ends early (rejecting) when the client goes away — a retry for nobody is waste. */
function abortableSleep(ms, signal) {
  if (!signal) return sleep(ms);
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(Object.assign(new Error('client disconnected'), { code: 'ABORTED' })); return; }
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(Object.assign(new Error('client disconnected'), { code: 'ABORTED' })); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * @param {object} o
 * @param {(token:string)=>object|null|Promise<object|null>} o.getRun
 * @param {(record:object)=>void} [o.onUsage]
 * @param {object} [o.log]            {debug,info,warn,error}
 * @param {number} [o.pingIntervalMs] keep-alive ping cadence on silent translated streams (15000)
 * @param {()=>number} [o.retryDelayMs] backoff before a retry (jittered 0.5–2 s)
 * @param {number} [o.maxRetries]     retries before the first client byte (2)
 * @param {number} [o.maxBodyBytes]   request body cap (64 MB)
 */
function createBridgeServer(o = {}) {
  if (typeof o.getRun !== 'function') throw new TypeError('createBridgeServer: getRun(token) is required');
  const log = normalizeLog(o.log);
  const onUsage = typeof o.onUsage === 'function' ? o.onUsage : () => {};
  const pingIntervalMs = o.pingIntervalMs || 15000;
  const retryDelayMs = o.retryDelayMs || (() => 500 + Math.floor(Math.random() * 1500));
  const maxRetries = o.maxRetries != null ? o.maxRetries : 2;
  const maxBody = o.maxBodyBytes || MAX_BODY;

  const recent = [];
  const limiters = new Map();
  const calibrator = createCalibrator();
  const inflight = new Set();
  let seq = 0;

  function limiterFor(p) {
    const key = (p && p.id) || '(none)';
    const max = (p && p.options && p.options.maxConcurrency) || 6;
    let l = limiters.get(key);
    if (!l) { l = createLimiter(max); limiters.set(key, l); } else l.setMax(max);
    return l;
  }

  const env = {
    log,
    calibrator,
    pingIntervalMs,
    acquire: (p, signal) => limiterFor(p).acquire(signal),
    /** Retries ONLY before any byte reached the client: transport errors and 502/503/504. */
    async sendWithRetry(rc, req) {
      const opts = rc.provider.options || {};
      const base = { ...req, connectTimeoutMs: opts.connectTimeoutMs || 30000, idleTimeoutMs: opts.timeoutMs || 600000, signal: rc.signal };
      for (let attempt = 1; ; attempt++) {
        rc.entry.attempts = attempt;
        let up;
        try {
          up = await send(base);
        } catch (e) {
          if (rc.aborted() || attempt > maxRetries || !RETRYABLE_CODES.has(e.code)) throw e;
          log.debug(`[llm-bridge] #${rc.id} retry ${attempt} after ${e.code}`);
          await abortableSleep(retryDelayMs(), rc.signal);
          continue;
        }
        if (RETRY_STATUSES.has(up.status) && attempt <= maxRetries && !rc.aborted()) {
          discard(up);
          log.debug(`[llm-bridge] #${rc.id} retry ${attempt} after HTTP ${up.status}`);
          await abortableSleep(retryDelayMs(), rc.signal);
          continue;
        }
        return up;
      }
    },
  };

  function pushLog(entry) {
    recent.push(entry);
    if (recent.length > LOG_KEEP) recent.splice(0, recent.length - LOG_KEEP);
  }

  function sendJson(res, status, obj, headers = {}) {
    if (res.headersSent || res.destroyed) return;
    const s = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), ...headers });
    res.end(s);
  }

  async function handle(req, res) {
    const t0 = Date.now();
    const url = req.url || '/';
    const q = url.indexOf('?');
    const path = (q >= 0 ? url.slice(0, q) : url).replace(/\/+$/, '') || '/';
    const query = q >= 0 ? url.slice(q) : '';
    if (path === '/health' || path.endsWith('/health')) { sendJson(res, 200, { ok: true }); return; }

    let route = null;
    let modelId = null;
    if (/\/v1\/messages\/count_tokens$/.test(path)) route = 'count';
    else if (/\/v1\/messages$/.test(path)) route = 'messages';
    else if (/\/v1\/models$/.test(path)) route = 'models';
    else { const m = /\/v1\/models\/([^/]+)$/.exec(path); if (m) { route = 'model'; modelId = decodeURIComponent(m[1]); } }
    const wantMethod = route === 'models' || route === 'model' ? 'GET' : 'POST';
    if (!route || req.method !== wantMethod) {
      req.resume();
      sendJson(res, 404, anthropicError('not_found_error', `llm-bridge: no route for ${req.method} ${path}`));
      return;
    }

    const token = tokenOf(req);
    const ctx = token ? await o.getRun(token) : null;
    if (!ctx || !ctx.provider) {
      req.resume();
      sendJson(res, 401, anthropicError('authentication_error', 'llm-bridge: unknown or expired run token'));
      return;
    }

    if (route === 'models' || route === 'model') {
      const ids = [...new Set([ctx.model, ...Object.keys(ctx.models || {})].filter((x) => typeof x === 'string' && x))];
      const data = ids.map((id) => ({ type: 'model', id, display_name: id, created_at: MODELS_CREATED_AT }));
      if (route === 'model') {
        const hit = data.find((d) => d.id === modelId);
        if (hit) sendJson(res, 200, hit); else sendJson(res, 404, anthropicError('not_found_error', `llm-bridge: model ${modelId} is not available to this run`));
      } else {
        sendJson(res, 200, { data, has_more: false, first_id: ids[0] || null, last_id: ids[ids.length - 1] || null });
      }
      return;
    }

    let raw;
    try {
      raw = await readBody(req, maxBody);
    } catch (e) {
      if (e.code === 'E2BIG') sendJson(res, 413, anthropicError('request_too_large', `llm-bridge: request body exceeds ${Math.round(maxBody / 1048576)} MB`));
      else if (!res.destroyed) res.destroy();
      return;
    }
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { body = undefined; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, anthropicError('invalid_request_error', 'llm-bridge: request body is not a JSON object'));
      return;
    }

    const p = ctx.provider;
    const cliSessionId = typeof req.headers['x-claude-code-session-id'] === 'string' ? req.headers['x-claude-code-session-id'] : null;
    const ac = new AbortController();
    const abortHandlers = [];
    let aborted = false;
    let finished = false;
    let firstByteAt = null;
    const entry = {
      id: ++seq, ts: t0, method: req.method, route, runId: ctx.runId || null, purpose: ctx.purpose || null,
      providerId: p.id || null, mode: p.type === 'openai-compatible' ? 'translate' : 'passthrough',
      requestedModel: typeof body.model === 'string' ? body.model : null, model: null,
      stream: body.stream === true, bytesIn: raw.length, messages: Array.isArray(body.messages) ? body.messages.length : 0,
      tools: null, status: 'pending', httpStatus: null, upstreamStatus: null, errorType: null, attempts: 0,
      ms: null, firstByteMs: null, inputTokens: null, outputTokens: null,
    };
    pushLog(entry);

    const rc = {
      id: entry.id, req, res, t0, ctx, provider: p, body, raw, query, entry, cliSessionId,
      calKey: cliSessionId || ctx.runId || token.slice(-12),
      signal: ac.signal,
      aborted: () => aborted,
      onAbort(fn) { if (aborted) fn(); else abortHandlers.push(fn); },
      markFirstByte() { if (firstByteAt == null) firstByteAt = Date.now(); },
      setModel(model, requested) { entry.model = model; entry.requestedModel = requested || entry.requestedModel; },
      json: (status, obj, headers) => sendJson(res, status, obj, headers),
      error: (status, type, message, headers) => sendJson(res, status, anthropicError(type, message), headers),
      finish(f) {
        if (finished) return;
        finished = true;
        inflight.delete(rc);
        const ms = Date.now() - t0;
        Object.assign(entry, {
          status: f.status, httpStatus: f.httpStatus != null ? f.httpStatus : (res.headersSent ? res.statusCode : null),
          errorType: f.errorType || null, ms, firstByteMs: firstByteAt != null ? firstByteAt - t0 : null,
          inputTokens: f.inputTokens != null ? f.inputTokens : null, outputTokens: f.outputTokens != null ? f.outputTokens : null,
        });
        const line = `[llm-bridge] #${entry.id} ${route} run=${entry.runId} ${entry.providerId}/${entry.model} ${f.status} ${entry.httpStatus || '-'} ${ms}ms in=${entry.inputTokens ?? '-'} out=${entry.outputTokens ?? '-'}`;
        if (f.status === 'error') log.warn(`${line} ${entry.errorType || ''}`); else log.debug(line);
        if (route !== 'messages') return;
        const rec = {
          ts: t0, runId: ctx.runId || null, purpose: ctx.purpose || null, sessionId: ctx.sessionId || null,
          taskId: ctx.taskId || null, botId: ctx.botId || null, providerId: p.id || null,
          model: entry.model, requestedModel: entry.requestedModel,
          inputTokens: f.inputTokens || 0, outputTokens: f.outputTokens || 0,
          cacheReadTokens: f.cacheReadTokens || 0, cacheWriteTokens: f.cacheWriteTokens || 0, reasoningTokens: f.reasoningTokens || 0,
          latencyMs: ms, firstByteMs: entry.firstByteMs, stream: entry.stream,
          status: f.status, httpStatus: entry.httpStatus, errorType: entry.errorType, cliSessionId,
        };
        try { const r = onUsage(rec); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (e) { log.warn(`[llm-bridge] onUsage threw: ${e.message}`); }
      },
    };
    inflight.add(rc);
    res.on('close', () => {
      if (res.writableFinished || aborted) return;
      aborted = true;
      ac.abort();
      for (const fn of abortHandlers.splice(0)) { try { fn(); } catch { /* keep going */ } }
      if (!finished) rc.finish({ status: 'aborted' });
    });

    try {
      if (route === 'count') {
        if (entry.mode === 'passthrough') await handlePassthrough(rc, env, 'count');
        else {
          rc.json(200, { input_tokens: calibrator.apply(rc.calKey, estimateInputTokens(body)) });
          rc.finish({ status: 'ok', httpStatus: 200 });
        }
      } else if (entry.mode === 'passthrough') {
        await handlePassthrough(rc, env, 'messages');
      } else {
        await handleTranslate(rc, env);
      }
    } finally {
      if (!finished) {
        // a handler that returned without settling: never leave the CLI hanging
        if (!res.headersSent) rc.error(500, 'api_error', 'llm-bridge: request ended without a response');
        else if (!res.writableEnded) res.end();
        rc.finish({ status: 'error', httpStatus: res.statusCode || 500, errorType: 'api_error' });
      }
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log.error(`[llm-bridge] request failed: ${(e && e.stack) || e}`);
      if (!res.headersSent && !res.destroyed) sendJson(res, 500, anthropicError('api_error', 'llm-bridge: internal error'));
      else if (!res.writableEnded) res.destroy();
    });
  });
  // No server-side clocks on a response that may legitimately stream for an hour.
  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  server.timeout = 0;
  server.keepAliveTimeout = 65000;
  server.on('clientError', (err, sock) => { try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* gone */ } });

  return {
    server,
    /** Loopback only: this port proxies to providers with real keys behind a bearer token. */
    listen(port = 0, host = '127.0.0.1') {
      if (!/^(127\.\d+\.\d+\.\d+|::1|localhost)$/.test(String(host))) {
        return Promise.reject(new Error(`llm-bridge: refusing to listen on non-loopback host ${host}`));
      }
      return new Promise((resolve, reject) => {
        const onErr = (e) => { server.off('listening', onOk); reject(e); };
        const onOk = () => { server.off('error', onErr); resolve({ port: server.address().port }); };
        server.once('error', onErr);
        server.once('listening', onOk);
        server.listen(port, host);
      });
    },
    address: () => server.address(),
    recentLog: () => recent.map((e) => ({ ...e })),
    close() {
      return new Promise((resolve) => {
        for (const rc of inflight) { try { rc.res.destroy(); } catch { /* gone */ } }
        server.close(() => resolve());
        if (server.closeAllConnections) server.closeAllConnections();
      });
    },
    stats: () => ({ inflight: inflight.size, limiters: Object.fromEntries([...limiters].map(([k, l]) => [k, l.stats()])) }),
  };
}

module.exports = { createBridgeServer, tokenOf };
