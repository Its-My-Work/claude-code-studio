// Two terminal-status regressions, both from a real incident (T-001, 2026-09-22): a Kanban
// task run can end subtype:'success' with the CLI having produced NOTHING — two consecutive
// empty text turns — and the board marked it 'done' anyway, with no report, no escalation.
//
//   - emptyFinalTurn: a task whose LAST turn's own text is empty (regardless of what earlier
//     turns said — an error banner, an auto-continue notice, …) is no longer marked 'done'.
//     failure_reason is 'empty_response', not the generic 'agent_incomplete', so the board
//     says what actually happened.
//   - report_result({blocked:true, reason}): the ONLY correct way to escalate. Status becomes
//     'blocked' — not 'done', not 'cancelled' — a card a human needs to look at, distinct from
//     both a finished task and a failed one.
//
// Also checks the compression fix from the same finding: kanban.html and /api/tasks went out
// uncompressed on every load/poll (verified live against the ~190KB real board this session).
//
// Drives a REAL server + a real (scripted) `claude` binary end to end — not the source text,
// the actual taskWorker loop. report_result is fired the same way mcp-task-manager.js fires
// it: a bearer-authed POST to /api/internal/task-manager while the fake CLI is still "running"
// the task — exactly what the real MCP subprocess does under the hood.
//
// Run: node test/task-blocked-and-empty-response.test.js   (TEST_PORT=<n> to move off the default)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = Number(process.env.TEST_PORT || 4562);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'test-task-manager-secret-blocked0123456789';

const APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-blk-app-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-blk-home-'));
process.on('exit', () => { for (const d of [APP_DIR, HOME_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });
const WORKDIR = path.join(APP_DIR, 'workspace');
fs.mkdirSync(WORKDIR, { recursive: true });
fs.writeFileSync(path.join(APP_DIR, 'config.json'), JSON.stringify({ mcpServers: {}, skills: {} }, null, 2));

const binDir = path.join(HOME_DIR, '.local', 'bin');
fs.mkdirSync(binDir, { recursive: true });
const claudePath = path.join(binDir, 'claude');
function setFakeClaude(script) {
  fs.writeFileSync(claudePath, script);
  fs.chmodSync(claudePath, 0o755);
}
// Scenario A (set before the server even boots): a turn that ends 'success' with literally
// no text — reproduces the real T-001 transcript (two empty assistant turns, then
// subtype:'success').
setFakeClaude(`#!/bin/sh
case " $* " in *" haiku "*) exit 0 ;; esac
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"ccs-blk-fake-a"}'
printf '%s\\n' '{"type":"result","subtype":"success","session_id":"ccs-blk-fake-a"}'
exit 0
`);

let srvLog = '';
const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), CCS_DESKTOP: '1', APP_DIR, WORKDIR, HOME: HOME_DIR, CCS_TASK_MANAGER_SECRET: SECRET },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let exited = false;
child.on('exit', () => { exited = true; });
child.stdout.on('data', d => { srvLog += d; });
child.stderr.on('data', d => { srvLog += d; });
let cleanedUp = false;
function cleanup() { if (cleanedUp) return; cleanedUp = true; if (!exited) { try { child.kill('SIGTERM'); } catch {} } }
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(1); });
function die(msg) { console.error(msg); if (srvLog) console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); }

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
// The shape mcp-task-manager.js posts: bearer token, {...args, action}.
async function tm(args) {
  const res = await fetch(BASE + '/api/internal/task-manager', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
async function getTask(id) {
  const r = await api('GET', '/api/tasks');
  const list = Array.isArray(r.json) ? r.json : r.json?.tasks || [];
  return list.find(t => t.id === id) || null;
}
async function waitForStatus(id, notIn, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = await getTask(id);
    if (t && !notIn.includes(t.status)) return t;
    await sleep(150);
  }
  throw new Error(`task ${id} never left ${JSON.stringify(notIn)} within ${timeoutMs}ms`);
}

(async () => {
  let up = false;
  for (let i = 0; i < 80 && !exited; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch {}
    await sleep(250);
  }
  if (exited) die(`server exited before it became ready — port ${PORT} collision or startup crash`);
  if (!up) die('server did not start');

  console.log('\n— an empty final turn is not "done" —');
  {
    const created = await api('POST', '/api/tasks', { title: 'spike: empty run', status: 'todo' });
    if (created.status !== 200 || !created.json?.id) die(`could not create the task: ${created.text}`);
    const t = await waitForStatus(created.json.id, ['todo', 'in_progress']);
    check('an empty final turn is NOT marked done (T-001, real incident)', t.status, 'cancelled');
    check('failure_reason names it specifically, not the generic "agent_incomplete"', t.failure_reason, 'empty_response');
  }

  console.log('\n— report_result({blocked:true}) —');
  {
    // Sleeps mid-run so this test has a window to fire report_result exactly the way
    // mcp-task-manager.js would — a bearer-authed HTTP call while the process is alive —
    // then still ends the turn 'success'. The point: blocked wins regardless of how the
    // CLI's OWN turn ends.
    setFakeClaude(`#!/bin/sh
case " $* " in *" haiku "*) exit 0 ;; esac
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"ccs-blk-fake-b"}'
sleep 1.5
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"I looked, and I cannot proceed."}]}}'
printf '%s\\n' '{"type":"result","subtype":"success","session_id":"ccs-blk-fake-b"}'
exit 0
`);
    const created = await api('POST', '/api/tasks', { title: 'spike: needs a live instance', status: 'todo' });
    if (created.status !== 200 || !created.json?.id) die(`could not create the task: ${created.text}`);
    const id = created.json.id;
    // Wait for the run to actually start before firing report_result — realistic timing,
    // not a guessed sleep.
    const start = Date.now();
    while (Date.now() - start < 8000) {
      const t = await getTask(id);
      if (t?.status === 'in_progress') break;
      await sleep(100);
    }
    const rr = await tm({ action: 'report_result', taskId: id, data: 'no live instance available', blocked: true, reason: 'no live Easypanel instance to test against — need one provisioned' });
    check('report_result accepts blocked:true', rr.status, 200);
    check('...and echoes it back', rr.json?.blocked, true);
    const t = await waitForStatus(id, ['todo', 'in_progress']);
    check('the task ends "blocked", not "done" or "cancelled"', t.status, 'blocked');
    check('failure_reason carries the escalation reason verbatim', t.failure_reason, 'no live Easypanel instance to test against — need one provisioned');
  }

  console.log('\n— a normal run is unaffected —');
  {
    setFakeClaude(`#!/bin/sh
case " $* " in *" haiku "*) exit 0 ;; esac
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"ccs-blk-fake-c"}'
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"All done, here is the summary."}]}}'
printf '%s\\n' '{"type":"result","subtype":"success","session_id":"ccs-blk-fake-c"}'
exit 0
`);
    const created = await api('POST', '/api/tasks', { title: 'spike: normal', status: 'todo' });
    if (created.status !== 200 || !created.json?.id) die(`could not create the task: ${created.text}`);
    const t = await waitForStatus(created.json.id, ['todo', 'in_progress']);
    check('a real final turn with text still marks the task done', t.status, 'done');
    check('...with no failure_reason', t.failure_reason, null);
  }

  console.log('\n— responses are compressed (found live: kanban.html/api/tasks went out raw) —');
  {
    const kanbanRes = await fetch(BASE + '/kanban.html', { headers: { 'Accept-Encoding': 'gzip' } });
    await kanbanRes.arrayBuffer();
    check('kanban.html is served gzip-encoded', kanbanRes.headers.get('content-encoding'), 'gzip');
    const tasksRes = await fetch(BASE + '/api/tasks', { headers: { 'Accept-Encoding': 'gzip' } });
    // fetch/undici decodes Content-Encoding transparently — the header is what proves
    // the wire format changed; the body is asserted as plain JSON on top of that.
    check('/api/tasks is served gzip-encoded', tasksRes.headers.get('content-encoding'), 'gzip');
    const decoded = await tasksRes.json();
    check('...and it still decodes to valid task JSON', Array.isArray(decoded), true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => die(`unexpected: ${e.stack || e}`));
