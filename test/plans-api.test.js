// Integration test for POST /api/plans/review and /api/plans/import. Starts a real server against a
// THROWAWAY data directory and a real plan/ folder on disk, so it never touches the developer's data.
// Run standalone: node test/plans-api.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = parseInt(process.env.TEST_PORT || '', 10) || 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-planstest-app-'));
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-planstest-wd-'));
process.on('exit', () => { for (const d of [APP_DIR, WORKDIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });

function probePort(port) {
  return new Promise(resolve => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    const done = busy => { try { s.destroy(); } catch {} resolve(busy); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 1000);
  });
}
async function api(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

function writeTask(id, { bot = 'kolya-prohramist', depends_on = [], covers = ['1. Цель'], title = 'Задача', extraBody = '## Критерии приёмки\nx\n## Проверка\ny\n' } = {}) {
  fs.mkdirSync(path.join(WORKDIR, 'plan', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(WORKDIR, 'plan', 'tasks', `${id}.md`),
    `---\nid: ${id}\ntitle: ${title}\nbot: ${bot}\ndepends_on: [${depends_on.join(', ')}]\ncovers: [${covers.join(', ')}]\n---\n${extraBody}`);
}
function clearPlan() { try { fs.rmSync(path.join(WORKDIR, 'plan'), { recursive: true, force: true }); } catch {} }

(async () => {
  if (await probePort(PORT)) { console.error(`port ${PORT} in use — set TEST_PORT`); process.exit(1); }

  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), CCS_DESKTOP: '1', APP_DIR, WORKDIR, ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; srv.stdout.on('data', d => { log += d; }); srv.stderr.on('data', d => { log += d; });
  const stop = () => { try { srv.kill('SIGTERM'); } catch {} };
  process.on('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stop(); process.exit(1); });

  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`${BASE}/api/health`); if (r.ok) { up = true; break; } } catch {} await sleep(250); }
  if (!up) { console.error('server did not start\n' + log); stop(); process.exit(1); }

  // A global bot, visible without registering a project.
  const kolya = (await api('POST', '/api/bots', { label: 'Kolya', id: 'kolya-prohramist', isGlobal: true })).json.id;
  const taras = (await api('POST', '/api/bots', { label: 'Taras', id: 'taras-qa', isGlobal: true })).json.id;

  console.log('review, no plan/ yet:');
  {
    const r = await api('POST', '/api/plans/review', { workdir: WORKDIR });
    check('no plan/ directory: an empty, non-approvable review, not an error', [r.status, r.json.hasPlanDir, r.json.canApprove], [200, false, false]);
  }
  check('workdir is required', (await api('POST', '/api/plans/review', {})).status, 400);

  console.log('review, a clean plan:');
  writeTask('T-001', { covers: ['1. Введение'] });
  writeTask('T-002', { bot: 'taras-qa', depends_on: ['T-001'], covers: ['2. Тесты'] });
  {
    const r = await api('POST', '/api/plans/review', { workdir: WORKDIR });
    check('two tasks, no errors, can approve', [r.status, r.json.tasks.length, r.json.errors, r.json.canApprove], [200, 2, [], true]);
    check('bots resolved as the real global roster', r.json.tasks.map(t => t.bot).sort(), ['kolya-prohramist', 'taras-qa']);
  }

  console.log('import refuses a plan with lint errors:');
  writeTask('T-003', { bot: 'no-such-bot' });
  {
    const r = await api('POST', '/api/plans/import', { workdir: WORKDIR });
    check('409, the review travels with the refusal', [r.status, r.json.error, r.json.review.canApprove], [409, 'the plan has lint errors and cannot be approved', false]);
    check('nothing was written to the board', (await api('GET', `/api/tasks?workdir=${encodeURIComponent(WORKDIR)}`)).json.length, 0);
  }
  fs.rmSync(path.join(WORKDIR, 'plan', 'tasks', 'T-003.md'));

  console.log('import, the whole plan:');
  let created;
  {
    const r = await api('POST', '/api/plans/import', { workdir: WORKDIR });
    check('creates both, updates none, skips none', [r.status, r.json.created, r.json.updated, r.json.skipped], [200, 2, 0, []]);
    const board = (await api('GET', `/api/tasks?workdir=${encodeURIComponent(WORKDIR)}`)).json;
    created = board;
    check('both land as backlog cards', board.map(t => t.status).sort(), ['backlog', 'backlog']);
    check('bot_id is the real handle from the file, for both cards', board.map(t => t.bot_id).sort(), ['kolya-prohramist', 'taras-qa']);
    check('titles round-trip', new Set(board.map(t => t.title)), new Set(['Задача']));
    const t2 = board.find(t => t.bot_id === 'taras-qa');
    check('depends_on is remapped to a real Kanban id (T-002 -> T-001s real id)', JSON.parse(t2.depends_on || '[]'), [board.find(t => t.bot_id === 'kolya-prohramist').id]);
    check('the response says both were archived, no errors', [r.json.archived, r.json.archiveErrors], [2, []]);
    check('the source files are gone from plan/tasks/', [fs.existsSync(path.join(WORKDIR, 'plan', 'tasks', 'T-001.md')), fs.existsSync(path.join(WORKDIR, 'plan', 'tasks', 'T-002.md'))], [false, false]);
    check('...and moved to plan/imported/, stamped with the real card id', [
      fs.readFileSync(path.join(WORKDIR, 'plan', 'imported', 'T-001.md'), 'utf8').includes(`imported_card: ${board.find(t => t.bot_id === 'kolya-prohramist').id}`),
      fs.readFileSync(path.join(WORKDIR, 'plan', 'imported', 'T-002.md'), 'utf8').includes(`imported_card: ${t2.id}`),
    ], [true, true]);
  }

  console.log('re-import: updates in place, no duplicates:');
  // T-002's file was archived away by the first import; only a task actively re-proposed (its file
  // put back in plan/tasks/) is reviewed again — the archived one is not touched by this import.
  writeTask('T-001', { covers: ['1. Введение'], title: 'Задача (переписана)' });
  {
    const r = await api('POST', '/api/plans/import', { workdir: WORKDIR });
    check('only T-001 (its file is back) updates; T-002 (still archived) is not part of this review', [r.status, r.json.created, r.json.updated], [200, 0, 1]);
    const board = (await api('GET', `/api/tasks?workdir=${encodeURIComponent(WORKDIR)}`)).json;
    check('still exactly two cards — no duplicate created', board.length, 2);
    check('the title change reached the card', board.some(t => t.title === 'Задача (переписана)'), true);
    check('T-001 is archived again (overwriting the earlier copy), still stamped', fs.readFileSync(path.join(WORKDIR, 'plan', 'imported', 'T-001.md'), 'utf8').includes('Задача (переписана)'), true);
  }

  console.log('a card already moved along keeps its status:');
  {
    const t1 = created.find(t => t.bot_id === 'kolya-prohramist');
    await api('PUT', `/api/tasks/${t1.id}`, { status: 'in_progress' });
    writeTask('T-001', { covers: ['1. Введение'], title: 'Задача (ещё раз переписана)' });
    await api('POST', '/api/plans/import', { workdir: WORKDIR });
    const row = (await api('GET', `/api/tasks?workdir=${encodeURIComponent(WORKDIR)}`)).json.find(t => t.id === t1.id);
    check('the text updates, the status a human already changed does not get reset to backlog', [row.title, row.status], ['Задача (ещё раз переписана)', 'in_progress']);
  }

  console.log('selecting a subset:');
  clearPlan();
  writeTask('A', { covers: ['x'] });
  writeTask('B', { bot: 'taras-qa', depends_on: ['A'], covers: ['x'] });
  writeTask('C', { bot: 'taras-qa', covers: ['x'] });
  {
    const before = (await api('GET', `/api/tasks?workdir=${encodeURIComponent(WORKDIR)}`)).json.length;
    const r = await api('POST', '/api/plans/import', { workdir: WORKDIR, selected: ['C'] });
    check('only C is created; A and B (not selected) are skipped, B named why', [r.json.created, r.json.skipped.sort((x, y) => x.id.localeCompare(y.id))],
      [1, [{ id: 'A', reason: 'not selected' }, { id: 'B', reason: 'not selected' }]]);
    check('board grew by exactly one', (await api('GET', `/api/tasks?workdir=${encodeURIComponent(WORKDIR)}`)).json.length, before + 1);
    check('C (imported) is archived; A and B (skipped, not on the board yet) keep their only copy in plan/tasks/', [
      fs.existsSync(path.join(WORKDIR, 'plan', 'tasks', 'C.md')), fs.existsSync(path.join(WORKDIR, 'plan', 'imported', 'C.md')),
      fs.existsSync(path.join(WORKDIR, 'plan', 'tasks', 'A.md')), fs.existsSync(path.join(WORKDIR, 'plan', 'tasks', 'B.md')),
    ], [false, true, true, true]);
  }
  {
    // deselecting A (a dependency of B) while selecting B: B must not import with a dangling depends_on
    const r = await api('POST', '/api/plans/import', { workdir: WORKDIR, selected: ['B'] });
    check('B alone (its dependency A not selected) is skipped, not imported half-broken', r.json.skipped.some(s => s.id === 'B' && /A/.test(s.reason)), true);
  }

  console.log('the import cap:');
  clearPlan();
  for (let i = 0; i < 3; i++) writeTask(`M-${i}`, { covers: ['x'] });
  check('a small plan is fine (cap sanity, not exercising the real 200-task limit here)', (await api('POST', '/api/plans/review', { workdir: WORKDIR })).json.canApprove, true);

  stop();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); stop(); process.exit(1); });
