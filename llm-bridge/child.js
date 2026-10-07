'use strict';
// The bridge child process: runs createBridgeServer, supervised by host.js over Node IPC.
// A separate process so a translator bug, a runaway upstream or a memory spike cannot take the
// studio down with it — the host restarts us on the same port and re-sends the live runs.
//
// IPC, host -> child:  init {port, host, runs, options} | run {ctx} | release {token}
//                      providers {map} | lookup-reply {id, ctx} | recent-log {id} | stop
// IPC, child -> host:  ready {port, pid} | fatal {error} | usage {record} | lookup {id, token}
//                      recent-log-reply {id, entries}
// Logs go to stderr as "[level] message" lines; the host forwards them to its own log.
//
// Unknown token: the host's registry is the source of truth, so the child ASKS (lookup) instead
// of answering 401 — registerRun() returns synchronously and the CLI may connect before the
// `run` message was processed here. Whichever arrives first, the answer is the same.

const { createBridgeServer } = require('./server');

const TOKEN_RE = /^ccsr_[0-9a-f]{48}$/;
const LOOKUP_TIMEOUT_MS = 2000;

function line(level, msg) {
  const text = String(msg && msg.stack ? msg.stack : msg);
  for (const l of text.split('\n')) process.stderr.write(`[${level}] ${l}\n`);
}
let debugOn = !!process.env.CCS_LLM_BRIDGE_DEBUG;
const log = {
  debug: (m) => { if (debugOn) line('debug', m); },
  info: (m) => line('info', m),
  warn: (m) => line('warn', m),
  error: (m) => line('error', m),
};

if (typeof process.send !== 'function') {
  line('error', 'llm-bridge child must be started with an IPC channel (stdio "ipc")');
  process.exit(2);
}

const runs = new Map();
const lookups = new Map();
let lookupSeq = 0;
let srv = null;
let shuttingDown = false;

function send(msg) {
  if (!process.connected) return;
  try { process.send(msg, (err) => { if (err) { /* channel closing; 'disconnect' ends us */ } }); } catch { /* same */ }
}

function getRun(token) {
  const hit = runs.get(token);
  if (hit) return hit;
  if (!TOKEN_RE.test(token) || !process.connected) return null;
  return new Promise((resolve) => {
    const id = ++lookupSeq;
    const timer = setTimeout(() => { lookups.delete(id); resolve(null); }, LOOKUP_TIMEOUT_MS);
    lookups.set(id, { resolve, timer });
    send({ t: 'lookup', id, token });
  });
}

async function start(msg) {
  try {
    if (srv) return; // a second init (should not happen) must not open a second listener
    for (const r of msg.runs || []) if (r && r.token) runs.set(r.token, r);
    const options = msg.options || {};
    if (options.debug) debugOn = true;
    srv = createBridgeServer({
      getRun,
      onUsage: (record) => send({ t: 'usage', record }),
      log,
      pingIntervalMs: options.pingIntervalMs,
      retryDelayMs: options.retryDelayMs != null ? () => options.retryDelayMs : undefined,
    });
    const { port } = await srv.listen(msg.port || 0, msg.host || '127.0.0.1');
    send({ t: 'ready', port, pid: process.pid });
  } catch (e) {
    send({ t: 'fatal', error: `${e.code || ''} ${e.message}`.trim() });
    setTimeout(() => process.exit(3), 100);
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  const bye = setTimeout(() => process.exit(code), 2000);
  bye.unref();
  Promise.resolve(srv && srv.close()).catch(() => {}).then(() => process.exit(code));
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  try {
    switch (msg.t) {
      case 'init': start(msg); break;
      case 'run': if (msg.ctx && msg.ctx.token) runs.set(msg.ctx.token, msg.ctx); break;
      case 'release': runs.delete(msg.token); break;
      case 'providers':
        for (const ctx of runs.values()) {
          const next = ctx.provider && msg.map && msg.map[ctx.provider.id];
          if (next) ctx.provider = next;
        }
        break;
      case 'lookup-reply': {
        const w = lookups.get(msg.id);
        if (!w) break;
        lookups.delete(msg.id);
        clearTimeout(w.timer);
        if (msg.ctx && msg.ctx.token) runs.set(msg.ctx.token, msg.ctx);
        w.resolve(msg.ctx || null);
        break;
      }
      case 'recent-log': send({ t: 'recent-log-reply', id: msg.id, entries: srv ? srv.recentLog() : [] }); break;
      case 'stop': shutdown(0); break;
      default: break;
    }
  } catch (e) {
    log.error(`[llm-bridge] bad IPC message ${msg.t}: ${e.message}`);
  }
});

// The parent died (or closed the channel): nobody can register runs or read usage any more.
process.on('disconnect', () => shutdown(0));

// Per-request failures are caught where they happen (a malformed request is a 400/500, never a
// crash). Anything reaching here is a bug with unknown blast radius: log it and let the host
// restart a clean process.
process.on('uncaughtException', (e) => { log.error(`[llm-bridge] uncaught exception: ${(e && e.stack) || e}`); process.exit(1); });
process.on('unhandledRejection', (e) => { log.error(`[llm-bridge] unhandled rejection: ${(e && e.stack) || e}`); });
