'use strict';
// Supervisor for the bridge child, living in the studio process.
//
//   const host = createBridgeHost({ onUsage, log });
//   await host.start();
//   const token = host.registerRun(ctx);           // synchronous
//   spawn claude with ANTHROPIC_BASE_URL=host.baseUrl(), ANTHROPIC_AUTH_TOKEN=token
//   host.releaseRun(token);                         // when the run ends (5 s grace)
//
// The child is spawned with the plain `nodeCmd` and stdio ['ignore','pipe','pipe','ipc'] — NOT
// child_process.fork: the packaged desktop app runs this module under Electron, whose fork
// would start another Electron. The studio's MCP helpers are spawned the same way.
//
// The HOST's registry is the source of truth for run tokens. The child keeps a copy (sent on
// init, on every registerRun, and again after a restart) and asks the host about any token it
// does not know, so a request that beats the `run` message over IPC still authenticates.
//
// Restarts: backoff 1 s, 2 s, 5 s, 10 s, 30 s (reset after 60 s of uptime), always on the SAME
// port — live CLI processes have that port in their ANTHROPIC_BASE_URL. Five failures within two
// minutes and the host gives up: running() false, baseUrl() null, one warn line; the server
// falls back.

const crypto = require('crypto');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { createBridgeServer } = require('./server');

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const GIVE_UP_FAILURES = 5;
const GIVE_UP_WINDOW_MS = 2 * 60 * 1000;
const STABLE_MS = 60 * 1000;
const READY_TIMEOUT_MS = 15000;
const IPC_REQUEST_TIMEOUT_MS = 2000;
const LOG_RE = /^\[(debug|info|warn|error)\] ?(.*)$/;

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

const newToken = () => `ccsr_${crypto.randomBytes(24).toString('hex')}`;

/**
 * @param {object} o
 * @param {string}   [o.nodeCmd='node']
 * @param {string}   [o.childPath]         default: ./child.js next to this file
 * @param {number}   [o.port]              fixed port; default: ephemeral on first start, then reused
 * @param {function} [o.onUsage]           UsageRecord sink (fire-and-forget)
 * @param {object}   [o.log]
 * @param {boolean}  [o.inProcess]         run the server in THIS process (tests / fallback)
 * @param {object}   [o.serverOptions]     passed to the child / createBridgeServer (pingIntervalMs, retryDelayMs, debug)
 * @param {number[]} [o.backoffMs]         restart backoff (tests shorten it)
 * @param {object}   [o.env]               child environment (default process.env)
 */
function createBridgeHost(o = {}) {
  const nodeCmd = o.nodeCmd || 'node';
  const childPath = o.childPath || path.join(__dirname, 'child.js');
  const log = normalizeLog(o.log);
  const onUsage = typeof o.onUsage === 'function' ? o.onUsage : () => {};
  const backoff = Array.isArray(o.backoffMs) && o.backoffMs.length ? o.backoffMs : BACKOFF_MS;
  const serverOptions = o.serverOptions || {};

  const runs = new Map();          // token -> ctx (token included)
  const releaseTimers = new Map();
  const ipcWaiters = new Map();
  let ipcSeq = 0;

  let port = o.port || 0;
  let child = null;
  let ready = false;
  let stopping = false;
  let gaveUp = false;
  let readySince = 0;
  let failures = [];
  let backoffIdx = 0;
  let restartTimer = null;
  let inproc = null;

  function safeSend(c, msg) {
    if (!c || !c.connected) return false;
    try { c.send(msg, (err) => { if (err) log.debug(`[llm-bridge] IPC send failed: ${err.message}`); }); return true; } catch { return false; }
  }

  function forwardLines(stream) {
    if (!stream) return;
    const rl = readline.createInterface({ input: stream });
    rl.on('line', (l) => {
      const m = LOG_RE.exec(l);
      if (m) log[m[1]](m[2]); else if (l.trim()) log.info(`[llm-bridge child] ${l}`);
    });
    rl.on('error', () => {});
  }

  function onChildMessage(c, m) {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'usage':
        try { const r = onUsage(m.record); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (e) { log.warn(`[llm-bridge] onUsage threw: ${e.message}`); }
        break;
      case 'lookup':
        safeSend(c, { t: 'lookup-reply', id: m.id, ctx: runs.get(m.token) || null });
        break;
      case 'recent-log-reply': {
        const w = ipcWaiters.get(m.id);
        if (w) { ipcWaiters.delete(m.id); clearTimeout(w.timer); w.resolve(m.entries || []); }
        break;
      }
      default: break;
    }
  }

  function settleWaiters() {
    for (const [id, w] of ipcWaiters) { clearTimeout(w.timer); w.resolve([]); ipcWaiters.delete(id); }
  }

  /** Spawn one child and wait for `ready`. Rejects on spawn error, early exit, fatal or timeout. */
  function spawnChild() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let becameReady = false;
      let c;
      try {
        c = spawn(nodeCmd, [childPath], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: o.env || process.env, windowsHide: true });
      } catch (e) { reject(e); return; }
      child = c;
      ready = false;
      forwardLines(c.stdout);
      forwardLines(c.stderr);
      const readyTimer = setTimeout(() => fail(new Error(`bridge child did not report ready within ${READY_TIMEOUT_MS / 1000} s`)), READY_TIMEOUT_MS);
      function fail(e) {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        try { c.kill('SIGKILL'); } catch { /* gone */ }
        reject(e);
      }
      c.on('error', (e) => {
        if (!settled) fail(e);
        else log.warn(`[llm-bridge] child process error: ${e.message}`);
      });
      c.on('message', (m) => {
        if (m && m.t === 'ready') {
          if (settled) return;
          settled = true;
          clearTimeout(readyTimer);
          port = m.port;
          ready = true;
          becameReady = true;
          readySince = Date.now();
          resolve();
          return;
        }
        if (m && m.t === 'fatal') { fail(new Error(`bridge child could not listen: ${m.error}`)); return; }
        onChildMessage(c, m);
      });
      c.on('exit', (code, signal) => {
        clearTimeout(readyTimer);
        const mine = child === c;
        if (mine) { child = null; ready = false; }
        settleWaiters();
        if (!settled) { settled = true; reject(new Error(`bridge child exited before it was ready (code ${code}, signal ${signal})`)); return; }
        // a child that never became ready is reported through the rejection above, not here
        if (mine && becameReady && !stopping) {
          log.warn(`[llm-bridge] bridge child exited unexpectedly (code ${code}, signal ${signal}); restarting`);
          scheduleRestart();
        }
      });
      safeSend(c, { t: 'init', port, host: '127.0.0.1', runs: [...runs.values()], options: serverOptions });
    });
  }

  function scheduleRestart() {
    if (stopping || restartTimer) return;
    const now = Date.now();
    failures = failures.filter((t) => now - t < GIVE_UP_WINDOW_MS);
    failures.push(now);
    if (failures.length >= GIVE_UP_FAILURES) {
      gaveUp = true;
      log.warn(`[llm-bridge] giving up: the bridge child failed ${failures.length} times within ${GIVE_UP_WINDOW_MS / 60000} min — bridge disabled`);
      return;
    }
    if (readySince && now - readySince > STABLE_MS) backoffIdx = 0;
    const delay = backoff[Math.min(backoffIdx, backoff.length - 1)];
    backoffIdx++;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (stopping) return;
      spawnChild().then(
        () => log.info(`[llm-bridge] bridge child restarted on port ${port}`),
        (e) => { log.warn(`[llm-bridge] bridge child restart failed: ${e.message}`); scheduleRestart(); },
      );
    }, delay);
    if (restartTimer.unref) restartTimer.unref();
  }

  return {
    /** Resolves when the child is listening. Rejects if the first attempt fails (retries continue in the background). */
    async start() {
      stopping = false;
      if (o.inProcess) {
        if (inproc) return;
        inproc = createBridgeServer({ getRun: (t) => runs.get(t) || null, onUsage, log, ...serverOptions,
          retryDelayMs: serverOptions.retryDelayMs != null ? () => serverOptions.retryDelayMs : undefined });
        const r = await inproc.listen(port, '127.0.0.1');
        port = r.port;
        ready = true;
        return;
      }
      if (child && ready) return;
      gaveUp = false;
      failures = [];
      try {
        await spawnChild();
      } catch (e) {
        log.warn(`[llm-bridge] could not start the bridge child: ${e.message}`);
        scheduleRestart();
        throw e;
      }
    },

    running() { return o.inProcess ? !!inproc && ready : !!child && ready && !gaveUp; },
    /** 'running' | 'starting' (first start or a restart pending) | 'down' (gave up) | 'stopped'. */
    state() {
      if (this.running()) return 'running';
      if (gaveUp) return 'down';
      if (stopping) return 'stopped';
      return (restartTimer || child) ? 'starting' : 'stopped';
    },
    baseUrl() { return this.running() ? `http://127.0.0.1:${port}` : null; },
    pid() { return child ? child.pid : null; },

    /** A new run token ('ccsr_' + 48 hex). Synchronous; the child learns it over IPC (or asks). */
    registerRun(ctx) {
      const token = newToken();
      const full = { ...ctx, token };
      runs.set(token, full);
      if (child) safeSend(child, { t: 'run', ctx: full });
      return token;
    },

    /** providerId -> ProviderCfg: refresh keys/options of live runs (new runs pass their own). */
    updateProviders(map) {
      if (!map || typeof map !== 'object') return;
      for (const ctx of runs.values()) {
        const next = ctx.provider && map[ctx.provider.id];
        if (next) ctx.provider = next;
      }
      if (child) safeSend(child, { t: 'providers', map });
    },

    /** The token keeps working for `graceMs` (the CLI's last calls after the turn), then 401s. */
    releaseRun(token, { graceMs = 5000 } = {}) {
      if (!runs.has(token)) return;
      clearTimeout(releaseTimers.get(token));
      const drop = () => {
        releaseTimers.delete(token);
        runs.delete(token);
        if (child) safeSend(child, { t: 'release', token });
      };
      if (!(graceMs > 0)) { drop(); return; }
      const t = setTimeout(drop, graceMs);
      if (t.unref) t.unref();
      releaseTimers.set(token, t);
    },

    async recentLog() {
      if (inproc) return inproc.recentLog();
      if (!child || !ready) return [];
      const c = child;
      return new Promise((resolve) => {
        const id = ++ipcSeq;
        const timer = setTimeout(() => { ipcWaiters.delete(id); resolve([]); }, IPC_REQUEST_TIMEOUT_MS);
        ipcWaiters.set(id, { resolve, timer });
        if (!safeSend(c, { t: 'recent-log', id })) { clearTimeout(timer); ipcWaiters.delete(id); resolve([]); }
      });
    },

    async stop() {
      stopping = true;
      clearTimeout(restartTimer);
      restartTimer = null;
      for (const t of releaseTimers.values()) clearTimeout(t);
      releaseTimers.clear();
      if (inproc) { const s = inproc; inproc = null; ready = false; await s.close(); return; }
      const c = child;
      if (!c) return;
      await new Promise((resolve) => {
        if (c.exitCode !== null || c.signalCode !== null) { resolve(); return; }
        const kill = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
        c.once('exit', () => { clearTimeout(kill); resolve(); });
        if (!safeSend(c, { t: 'stop' })) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
      });
      if (child === c) child = null;
      ready = false;
      settleWaiters();
    },
  };
}

module.exports = { createBridgeHost, newToken };
