'use strict';
// Upstream HTTP on core http/https — deliberately NOT global fetch: undici's default 300 s
// bodyTimeout kills a reasoning model that thinks silently for five minutes, and its
// headersTimeout does the same before the first byte. Here the only clocks are ours:
//   connectTimeoutMs — TCP/TLS connect
//   idleTimeoutMs    — no bytes at all (neither headers nor body) for this long; NOT a total cap
// plus an AbortSignal so a client disconnect tears the upstream request down.

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { pipeline, PassThrough } = require('stream');

// keep-alive: a long agent turn makes dozens of calls to the same host; reusing the TLS session
// saves a handshake per call. A stale pooled socket fails with ECONNRESET, which is retried.
const AGENTS = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 15000 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 15000 }),
};

class UpstreamError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Transport errors worth one more attempt (only ever before a byte went to the client). */
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNECT_TIMEOUT', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNABORTED']);

/**
 * Send one request. Resolves once response headers arrive with
 *   { status, headers, stream (decoded body, Readable), destroy(err), reason() }
 * Rejects on connect/transport/idle failure before headers, or on abort.
 */
function send({ url, method = 'POST', headers = {}, body = null, connectTimeoutMs = 30000, idleTimeoutMs = 600000, signal = null }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { reject(new UpstreamError('EBADURL', `invalid upstream URL: ${url}`)); return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { reject(new UpstreamError('EBADURL', `unsupported protocol ${u.protocol}`)); return; }
    if (signal && signal.aborted) { reject(new UpstreamError('ABORTED', 'client disconnected')); return; }

    const lib = u.protocol === 'https:' ? https : http;
    const hdrs = { ...headers };
    if (body != null) hdrs['content-length'] = Buffer.byteLength(body);
    let settled = false;
    let reason = null;          // why WE destroyed the request (idle, abort) — survives into res 'error'
    let idleTimer = null;
    let connectTimer = null;

    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || undefined,
      path: `${u.pathname}${u.search}`, method, headers: hdrs, agent: AGENTS[u.protocol],
    });
    const kill = (err) => { if (!reason) reason = err; req.destroy(err); };
    const clearTimers = () => { clearTimeout(idleTimer); clearTimeout(connectTimer); };
    const onAbort = () => kill(new UpstreamError('ABORTED', 'client disconnected'));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const detach = () => { clearTimers(); if (signal) signal.removeEventListener('abort', onAbort); };

    const armIdle = () => {
      if (idleTimer) { idleTimer.refresh(); return; }
      idleTimer = setTimeout(() => kill(new UpstreamError('EIDLE', `no data from upstream for ${Math.round(idleTimeoutMs / 1000)} s`)), idleTimeoutMs);
    };
    connectTimer = setTimeout(() => kill(new UpstreamError('ECONNECT_TIMEOUT', `connect timeout after ${Math.round(connectTimeoutMs / 1000)} s`)), connectTimeoutMs);

    req.on('socket', (sock) => {
      const connected = () => { clearTimeout(connectTimer); armIdle(); };
      if (!sock.connecting) connected(); // a pooled keep-alive socket
      else sock.once(u.protocol === 'https:' ? 'secureConnect' : 'connect', connected);
    });

    req.on('response', (res) => {
      clearTimeout(connectTimer);
      armIdle();
      settled = true;
      const done = () => detach();
      res.once('end', done);
      res.once('close', done);
      res.once('error', done);
      // The consumer attaches its listeners only after an await or two; a PassThrough holds the
      // bytes until then (with backpressure) — a bare 'data' listener here would switch `res` to
      // flowing mode and drop everything that arrived before the consumer was ready.
      const out = new PassThrough();
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      const dec = enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip() : enc === 'deflate' ? zlib.createInflate() : enc === 'br' ? zlib.createBrotliDecompress() : null;
      const onPipeEnd = (err) => { if (err && !reason) reason = err; };
      if (dec) pipeline(res, dec, out, onPipeEnd); else pipeline(res, out, onPipeEnd);
      res.on('data', armIdle); // pipe() owns the flow control; this only watches for silence
      resolve({
        status: res.statusCode,
        headers: res.headers,
        stream: out,
        decoded: !!dec,
        destroy: (err) => { kill(err || new UpstreamError('ABORTED', 'closed by bridge')); res.destroy(); out.destroy(); },
        reason: () => reason,
      });
    });

    req.on('error', (err) => {
      detach();
      if (!settled) { settled = true; reject(reason || err); }
    });

    if (body != null) req.end(body); else req.end();
  });
}

/**
 * Read a whole response body (for errors and non-stream JSON), capped. Never rejects:
 * resolves {text, error} so a mid-body failure still yields what arrived.
 */
function readAll(up, max = 4 * 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0;
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      resolve({ text: Buffer.concat(chunks).toString('utf8'), error: error || null });
    };
    up.stream.on('data', (c) => {
      if (n < max) { chunks.push(c); n += c.length; }
    });
    up.stream.once('end', () => finish(null));
    up.stream.once('error', (e) => finish(up.reason() || e));
    up.stream.once('close', () => finish(up.stream.readableEnded ? null : (up.reason() || new UpstreamError('ECONNRESET', 'upstream closed the connection'))));
  });
}

/** Drain and drop a response we are not going to use (so the socket can go back to the pool). */
function discard(up) {
  try { up.stream.resume(); up.stream.on('error', () => {}); } catch { /* already gone */ }
}

module.exports = { send, readAll, discard, UpstreamError, RETRYABLE_CODES, AGENTS };
