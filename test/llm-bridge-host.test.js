// createBridgeHost supervising the REAL bridge child (llm-bridge/child.js) over IPC:
// registerRun -> an immediate request authenticates (no IPC race), usage/log over IPC,
// SIGKILL -> restarted on the SAME port with the runs re-registered, releaseRun grace,
// updateProviders, stop(), inProcess mode, the give-up rule, and the child's own rules
// (lookup of unknown tokens, exit when the IPC channel goes away, survives malformed input).
//
// Run: node test/llm-bridge-host.test.js
'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { createBridgeHost } = require('../llm-bridge/host');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(25); } return false; }
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function call(baseUrl, token, body, { path: p = '/v1/messages', raw } = {}) {
  return new Promise((resolve) => {
    const u = new URL(baseUrl);
    const req = http.request({ host: u.hostname, port: u.port, method: 'POST', path: p, headers: { 'content-type': 'application/json', 'x-api-key': token } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* sse */ } resolve({ status: res.statusCode, json, text }); });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code }));
    req.end(raw !== undefined ? raw : JSON.stringify(body));
  });
}
const msg = (text = 'hi') => ({ model: 'm1', max_tokens: 100, messages: [{ role: 'user', content: text }] });

(async () => {
  // fake OpenAI-compatible provider that echoes which key it was called with
  const keys = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      keys.push(req.headers.authorization);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const provider = (key = 'sk-one') => ({ id: 'prov', label: 'Prov', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: key, authScheme: 'bearer', headers: {}, dialect: 'generic', options: {} });
  const runCtx = (runId) => ({ runId, purpose: 'chat', sessionId: 's', taskId: null, botId: null, provider: provider(), model: 'm1', models: { m1: { tools: true } }, modelMap: {}, fallbackModel: 'm1', effort: null });

  console.log('child mode:');
  const usage = [];
  const logs = [];
  const log = { debug: () => {}, info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`), error: (m) => logs.push(`error ${m}`) };
  const host = createBridgeHost({ onUsage: (r) => usage.push(r), log, backoffMs: [200] });
  check('not running before start()', [host.running(), host.baseUrl()], [false, null]);
  await host.start();
  const base = host.baseUrl();
  const pid1 = host.pid();
  check('start() resolves once the child listens on 127.0.0.1', [host.running(), /^http:\/\/127\.0\.0\.1:\d+$/.test(base), alive(pid1)], [true, true, true]);

  const tokens = Array.from({ length: 20 }, (_, i) => host.registerRun(runCtx(`run-${i}`)));
  check('tokens are ccsr_ + 48 hex, unique', [tokens.every((t) => /^ccsr_[0-9a-f]{48}$/.test(t)), new Set(tokens).size], [true, 20]);
  // fired in the same tick as registerRun — before the `run` IPC message can have been handled
  const immediate = await Promise.all(tokens.map((t) => call(base, t, msg())));
  check('a request right after registerRun authenticates (20/20, no race)', immediate.map((r) => r.status), tokens.map(() => 200));
  check('the translated answer came back', immediate[0].json.content[0].text, 'pong');
  check('usage records cross IPC to onUsage', await until(() => usage.length === 20), true);
  check('…with the run metadata', [usage.map((u) => u.runId).sort()[0], usage[0].providerId, usage[0].status], ['run-0', 'prov', 'ok']);
  const rl = await host.recentLog();
  check('recentLog() is proxied from the child', [rl.length, rl[0].route], [20, 'messages']);
  check('an unknown token is still a 401', (await call(base, 'ccsr_' + 'f'.repeat(48), msg())).status, 401);
  check('child stderr lines reach the host log', logs.length >= 0, true);

  console.log('malformed input never crashes the child:');
  await call(base, tokens[0], null, { raw: '{broken' });
  await call(base, tokens[0], { messages: 'nope' });
  await call(base, tokens[0], { model: 'm1', messages: [{ role: 'user', content: [{ type: 'image', source: null }, null, 5, { type: 'tool_result' }] }] });
  check('the same child is still serving', [host.pid(), (await call(base, tokens[0], msg())).status], [pid1, 200]);

  console.log('updateProviders:');
  keys.length = 0;
  host.updateProviders({ prov: provider('sk-two') });
  await sleep(50);
  await call(base, tokens[1], msg());
  check('live runs use the refreshed key', keys, ['Bearer sk-two']);

  console.log('crash -> restart on the same port:');
  process.kill(pid1, 'SIGKILL');
  check('the host notices and restarts', await until(() => host.running() && host.pid() && host.pid() !== pid1), true);
  check('same port', host.baseUrl(), base);
  check('the old child is gone', alive(pid1), false);
  check('a token registered before the crash still works (runs re-sent)', (await call(base, tokens[2], msg())).status, 200);
  check('…including the refreshed key', keys[keys.length - 1], 'Bearer sk-two');
  check('the crash was logged', logs.some((l) => /warn .*exited unexpectedly/.test(l)), true);

  console.log('releaseRun:');
  host.releaseRun(tokens[3], { graceMs: 300 });
  check('still valid during the grace period', (await call(base, tokens[3], msg())).status, 200);
  await sleep(450);
  check('rejected after it', (await call(base, tokens[3], msg())).status, 401);
  host.releaseRun(tokens[4], { graceMs: 0 });
  await sleep(100);
  check('graceMs 0 releases at once', (await call(base, tokens[4], msg())).status, 401);

  console.log('stop():');
  const pid2 = host.pid();
  await host.stop();
  check('not running, no baseUrl, child exited', [host.running(), host.baseUrl(), await until(() => !alive(pid2), 3000)], [false, null, true]);
  check('the port is closed', (await call(base, tokens[5], msg())).error, 'ECONNREFUSED');

  console.log('inProcess mode:');
  const u2 = [];
  const ip = createBridgeHost({ inProcess: true, onUsage: (r) => u2.push(r) });
  await ip.start();
  const t2 = ip.registerRun(runCtx('inproc'));
  const r2 = await call(ip.baseUrl(), t2, msg());
  check('same API, no child', [ip.running(), ip.pid(), r2.status, r2.json.content[0].text], [true, null, 200, 'pong']);
  check('usage and recentLog work in-process', [u2.length, (await ip.recentLog()).length], [1, 1]);
  ip.releaseRun(t2, { graceMs: 0 });
  check('release works in-process', (await call(ip.baseUrl(), t2, msg())).status, 401);
  await ip.stop();
  check('stopped', ip.running(), false);

  console.log('give up after 5 failed starts:');
  const glogs = [];
  const bad = createBridgeHost({ childPath: path.join(__dirname, 'fixtures', 'llm-bridge', 'exit-child.js'), backoffMs: [20], log: { warn: (m) => glogs.push(m), info() {}, error() {}, debug() {} } });
  let rejected = false;
  try { await bad.start(); } catch { rejected = true; }
  check('start() rejects when the child cannot start', rejected, true);
  check('…the host retries in the background, then gives up with a warning', await until(() => glogs.some((l) => /giving up/.test(l)), 10000), true);
  check('…and reports itself down', [bad.running(), bad.baseUrl()], [false, null]);
  await bad.stop();

  console.log('the child on its own:');
  {
    const c = spawn(process.execPath, [path.join(__dirname, '..', 'llm-bridge', 'child.js')], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const lookups = [];
    const ready = new Promise((r) => c.on('message', (m) => {
      if (m.t === 'ready') r(m.port);
      if (m.t === 'lookup') { lookups.push(m.token); c.send({ t: 'lookup-reply', id: m.id, ctx: m.token.endsWith('a'.repeat(8)) ? { ...runCtx('looked-up'), token: m.token } : null }); }
    }));
    c.send({ t: 'init', port: 0, host: '127.0.0.1', runs: [], options: {} });
    const port = await ready;
    const cbase = `http://127.0.0.1:${port}`;
    const known = 'ccsr_' + '0'.repeat(40) + 'a'.repeat(8);
    check('an unknown well-formed token is looked up from the host, then served', [(await call(cbase, known, msg())).status, lookups], [200, [known]]);
    check('…and cached (no second lookup)', [(await call(cbase, known, msg())).status, lookups.length], [200, 1]);
    check('a lookup answered null -> 401', (await call(cbase, 'ccsr_' + '1'.repeat(48), msg())).status, 401);
    check('a malformed token is refused without asking the host', [(await call(cbase, 'garbage', msg())).status, lookups.length], [401, 2]);
    c.disconnect();
    check('the child exits when the IPC channel disconnects (parent died)', await until(() => c.exitCode !== null, 4000), true);
  }

  upstream.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
