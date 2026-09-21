// runConversationRoom, run as it is in server.js against a scripted CLI.
//
// server.js exports nothing and starts a server when required, so the function is lifted out of the
// source and given its dependencies: the real bots.js and room-files.js, a temp working directory
// with real files, and a fake CLI that answers from a script (and can write files, as a bot with
// Write/Edit would). This is the behaviour that was wrong on a real run (2026-09-21): 44 messages and
// no change to the file the user asked to have finished, "the document is updated" said by a bot that
// had written nothing, 8 of 20 replies lost to a 5-turn limit ("failed - see the error above" with no
// error above), the chat history given to the first speaker only.
//
// Run: node test/room-run.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const botsLogic = require('../bots');
const roomFiles = require('../room-files');
const { isAgentSuccess, roomStopReason } = require('../multi-agent-result');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const roomSrc = SRC.slice(SRC.indexOf('async function runConversationRoom('), SRV_END());
function SRV_END() { return SRC.indexOf('async function runBotTurns('); }
const toolsSrc = /function roomBuiltinTools\(mode, scope\) \{[^\n]*\}/.exec(SRC)[0];
const BOT_READ_TOOLS = ['Read', 'Glob', 'Grep'], BOT_WORK_TOOLS = ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write'];

const NAMES = ['ROOM_CLOSING', 'ClaudeCLI', 'stmts', 'ROOM_SEATING', 'botsLogic', 'getUserLang', 'pickRoomSeating', 'WORKDIR', 'seatingNote', 'botLangName',
  'roomFiles', 'MULTI_AGENT_MAX_TURNS_CAP', 'mcpServersForBot', 'runInteractiveSingle', 'killInteractiveTmux', 'isAgentSuccess',
  'roomStopReason', 'BOT_READ_TOOLS', 'BOT_WORK_TOOLS', 'tmuxAvailable', 'ROOM_GIT', 'roomGit', 'WM'];
const build = (deps) => new Function(...NAMES, `${toolsSrc}\n return ${roomSrc.trim().replace(/^async function runConversationRoom/, 'async function runConversationRoom')};`)(...NAMES.map(n => deps[n]));

/** Runs one room turn. `script(call)` decides what each CLI run does: { text, subtype, error, write: [[relPath, data]] }. */
async function runRoom({ closing = true, bots, script, mode = 'auto', maxTurns = 5, prompt = 'Доработайте ТЗ', userContent = 'Доработайте ТЗ', rows = [], workdir, engine = 'api', lang = 'ru', perBotEngine = false, tmux = true, git = 'none', gitOn = true }) {
  const saved = [], sent = [], calls = [], interactive = [], gitCalls = [];
  class FakeCLI {
    send(opts) {
      const h = {};
      const chain = { onText(f) { h.text = f; return chain; }, onResult(f) { h.result = f; return chain; }, onError(f) { h.error = f; return chain; }, onTool() { return chain; }, onDone(f) { h.done = f; return chain; } };
      const closing = /You are @([\w-]+) and you close this conversation/.exec(opts.prompt);
      const who = closing ? closing[1] : (/Now add your own contribution as @([\w-]+)/.exec(opts.prompt) || [])[1];
      const call = { ...opts, who, closing: !!closing, n: calls.length + 1 };
      calls.push(call);
      setImmediate(async () => {
        const r = (await script(call)) || {};
        for (const [rel, data] of r.write || []) { fs.mkdirSync(path.dirname(path.join(workdir, rel)), { recursive: true }); fs.writeFileSync(path.join(workdir, rel), data); }
        if (r.text) h.text && h.text(r.text);
        if (r.error) h.error && h.error('exit 1');
        if (r.subtype !== null) h.result && h.result({ subtype: r.subtype || 'success' });
        h.done && h.done();
      });
      return chain;
    }
  }
  const deps = {
    ROOM_CLOSING: closing, ClaudeCLI: FakeCLI, ROOM_SEATING: 'priority', botsLogic, roomFiles, isAgentSuccess, roomStopReason, BOT_READ_TOOLS, BOT_WORK_TOOLS,
    stmts: {
      getRoomRoster: { get: () => ({ room_roster: null }) }, setRoomRoster: { run() {} },
      getMsgsLite: { all: () => rows },
      addMsg: { run: (sid, role, type, text, tool, agent) => { if (type === 'text') saved.push({ text, agent: agent || null }); } },
    },
    getUserLang: () => lang, pickRoomSeating: async () => null, WORKDIR: workdir, seatingNote: () => '', botLangName: () => (lang === 'ru' ? 'Russian' : 'English'),
    MULTI_AGENT_MAX_TURNS_CAP: 200, mcpServersForBot: (base) => base, runInteractiveSingle: async (o) => { interactive.push(o); return { fullText: `subscription answer of ${o.agent}`, completed: true, toolEvents: [] }; }, killInteractiveTmux() {},
    tmuxAvailable: () => tmux,
    ROOM_GIT: gitOn, WM: {},
    // `git`: 'none' = not a repo the app manages; a function = the checkpoint result for call n (1-based)
    roomGit: { checkpoint: (dir, msg) => { gitCalls.push({ dir, msg }); return typeof git === 'function' ? git(gitCalls.length, dir, msg) : { managed: false }; } },
  };
  const run = build(deps);
  const ws = { send: (x) => sent.push(JSON.parse(x)) };
  await run({ mcpServers: {}, model: 'sonnet', maxTurns, ws, sessionId: 's1', abortController: new AbortController(), workdir, tabId: 't1', effort: null, userContent, engine, mode, perBotEngine },
    { bots, prompt, rosterBots: bots });
  return { saved, sent, calls, interactive, gitCalls };
}

const B = (id) => ({ id, label: id.toUpperCase(), description: `role ${id}` });
const bots3 = [B('a'), B('b'), B('c')];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'room-run-')); fs.writeFileSync(path.join(d, 'TZ.md'), '# spec\n'); return d; };
const mtimeBump = (f) => { const t = new Date(Date.now() + 5000); fs.utimesSync(f, t, t); };
const texts = (r) => r.saved.map(m => m.text);
const has = (r, re) => r.saved.some(m => re.test(m.text));
// round 1: everyone contributes; round 2: everyone passes (settled) -> then the closing step
const discuss = (call) => (call.closing ? null : (call.n <= 3 ? { text: `contribution of ${call.who}` } : { text: 'PASS' }));

(async () => {
  console.log('the closing step puts the result into the file, and the app shows what changed:');
  {
    const dir = tmp();
    const r = await runRoom({ bots: bots3, workdir: dir, script: (c) => c.closing
      ? { text: 'Обновил TZ.md: добавил раздел «План». Открыто: сроки.', write: [['TZ.md', '# spec\n## План\n' + 'x'.repeat(3000)], ['docs/PLAN.md', 'plan']] }
      : discuss(c) });
    const closing = r.calls.filter(c => c.closing);
    check('exactly one closing run, by the LAST seated bot', closing.map(c => c.who), ['c']);
    check('it comes after the discussion (which settled)', r.calls.findIndex(c => c.closing), r.calls.length - 1);
    check('the closing bot gets the closing rules, the discussion and the user\'s message',
      closing[0].prompt.includes('you close this conversation') && closing[0].prompt.includes('contribution of a') && closing[0].prompt.includes('contribution of b')
      && closing[0].prompt.includes('Доработайте ТЗ') && closing[0].prompt.includes('Write in Russian'), true);
    check('with write tools', closing[0].allowedTools, BOT_WORK_TOOLS);
    check('its answer is saved under its name', r.saved.some(m => m.agent === 'c' && m.text.startsWith('Обновил TZ.md')), true);
    const note = r.saved.find(m => m.text.startsWith('📁'));
    check('the app reports the files that really changed (in Russian)', !!note && note.text.includes('`TZ.md` — изменён') && note.text.includes('`docs/PLAN.md` — создан'), true);
    check('the report comes after the closing answer and before the room summary',
      texts(r).findIndex(t => t.startsWith('Обновил')) < texts(r).findIndex(t => t.startsWith('📁')) && texts(r).findIndex(t => t.startsWith('📁')) < texts(r).findIndex(t => t.includes('Room closed')), true);
    check('no false-claim warning when the files did change', has(r, /Файлы не менялись/), false);
    check('the report is also streamed to the client', r.sent.some(m => m.type === 'text' && m.text.startsWith('📁')), true);
    check('the client is told a closing step is running', r.sent.some(m => m.type === 'agent_status' && m.status === 'Закрывающий шаг…'), true);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n"the document is updated" with nothing written (the false claim on the real run):');
  {
    const dir = tmp();
    const r = await runRoom({ bots: bots3, workdir: dir, script: (c) => c.closing ? { text: 'ТЗ преобразовано и обновлено, план выше.' } : discuss(c) });
    const warn = r.saved.find(m => m.text.startsWith('⚠️ **Файлы не менялись.**'));
    check('is said outright', !!warn && warn.text.includes('считайте, что документ не обновлён'), true);
    const en = await runRoom({ bots: bots3, workdir: dir, lang: 'en', script: (c) => c.closing ? { text: 'Updated the spec.' } : discuss(c) });
    check('…and in English', en.saved.some(m => m.text.startsWith('⚠️ **No files changed.**')), true);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\nthe task asked for no file:');
  {
    const dir = tmp();
    const r = await runRoom({ bots: bots3, workdir: dir, script: (c) => c.closing ? { text: 'PASS' } : discuss(c) });
    check('the closer\'s PASS is silent: not saved, no warning, no files note', [r.saved.some(m => m.agent === 'c' && m.text === 'PASS'), has(r, /Файлы не менялись/), has(r, /^📁/)], [false, false, false]);
    check('the room still closes with its summary', has(r, /Room closed/), true);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\na change made during the discussion is reported even without a closing answer:');
  {
    const dir = tmp();
    const r = await runRoom({ bots: bots3, workdir: dir, script: (c) => c.closing ? { text: 'PASS' } : (c.n === 2 ? { text: 'saved my notes', write: [['notes.md', 'n']] } : discuss(c)) });
    check('the note lists notes.md', has(r, /`notes\.md` — создан/), true);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\nwhen the closing step must not run:');
  {
    const dir = tmp();
    const planning = await runRoom({ bots: bots3, workdir: dir, mode: 'planning', script: discuss });
    check('planning mode: no closing run, no files note, read-only tools', [planning.calls.some(c => c.closing), has(planning, /^📁|Файлы не менялись/), planning.calls[0].allowedTools], [false, false, BOT_READ_TOOLS]);
    const esc = await runRoom({ bots: bots3, workdir: dir, script: (c) => (c.n === 1 ? { text: 'A question first: @user which stage?' } : discuss(c)) });
    check('while the room waits for the user: no closing run', esc.calls.some(c => c.closing), false);
    check('…and it says the room needs the user', has(esc, /needs you/), true);
    const sub = await runRoom({ bots: bots3, workdir: dir, engine: 'subscription', script: discuss });
    check('subscription engine (no headless call): no closing run', sub.calls.some(c => c.closing), false);
    const none = await runRoom({ bots: bots3, workdir: dir, script: () => ({ text: 'PASS' }) });
    check('nobody said anything: nothing to close', none.calls.some(c => c.closing), false);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = tmp();
    const off = await runRoom({ closing: false, bots: bots3, workdir: dir, script: discuss });
    check('ROOM_CLOSING=off: the room only discusses (no closing run) — the files verdict still applies',
      [off.calls.some(c => c.closing), has(off, /Room closed/)], [false, true]);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\nthe closing bot itself fails:');
  {
    const dir = tmp();
    const r = await runRoom({ bots: bots3, workdir: dir, script: (c) => c.closing ? { subtype: 'error_max_turns', error: true } : discuss(c) });
    const note = r.saved.find(m => m.text.includes('did not finish the closing step'));
    check('is named, with the real reason (the closing step has its own, tripled, budget)', !!note && note.text.includes('hit the 60-turn limit'), true);
    check('no "the document is updated" warning is invented for it', has(r, /Файлы не менялись/), false);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\nthe turn limit (Steps = 5 lost 8 of 20 replies on the real run):');
  {
    const dir = tmp();
    const r = await runRoom({ bots: bots3, workdir: dir, maxTurns: 5, script: (c) => (c.closing ? { text: 'PASS' } : (c.n === 1 ? { subtype: 'error_max_turns', error: true } : discuss(c))) });
    check('every discussion turn gets at least 20 steps although the chat says 5', [...new Set(r.calls.filter(c => !c.closing).map(c => c.maxTurns))], [20]);
    const note = r.saved.find(m => m.text.includes('@a did not finish'));
    check('a bot that still hits the limit is told why — not "see the error above"', !!note && note.text.includes('(hit the 20-turn limit)') && !note.text.includes('see the error above'), true);
    check('the room carries on after it', r.calls.length > 3, true);
    check('the bots are told their budget', r.calls[0].prompt.includes('You have about 20 steps'), true);
    const big = await runRoom({ bots: bots3, workdir: dir, maxTurns: 60, script: discuss });
    check('a bigger Steps is kept', [...new Set(big.calls.filter(c => !c.closing).map(c => c.maxTurns))], [60]);
    const crash = await runRoom({ bots: bots3, workdir: dir, script: (c) => (c.closing ? { text: 'PASS' } : (c.n === 1 ? { subtype: null, error: true } : discuss(c))) });
    check('a crash with no result frame still says "failed — see the error above"', crash.saved.some(m => m.text.includes('@a did not finish (failed — see the error above)')), true);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\ncontext on a follow-up turn:');
  {
    const dir = tmp();
    const rows = [
      { role: 'user', type: 'text', content: 'Доработайте ТЗ, план по этапам' },
      { role: 'assistant', type: 'text', agent_id: 'a', content: 'Этап 0: исследовать API Easypanel (2 дня)' },
      { role: 'assistant', type: 'text', agent_id: 'b', content: '⚠️ @b did not finish (hit the 5-turn limit).' },
      { role: 'user', type: 'text', content: 'какой результат?' },
    ];
    const F = (n) => ({ type: 'file', source: { name: n } });
    const replay = [{ type: 'text', text: '[Session recovery]\nold' }, { type: 'text', text: '[User turn 1]' }, { type: 'text', text: '[Attachments from user turn 1]' }, F('TZ.md'),
      { type: 'text', text: 'Доработайте ТЗ, план по этапам' }, { type: 'text', text: '[Assistant turn 1]\nЭтап 0' }, { type: 'text', text: '[User turn 2]' }, { type: 'text', text: 'какой результат?' }];
    const r = await runRoom({ bots: bots3, workdir: dir, rows, prompt: 'какой результат?', userContent: replay, script: discuss });
    const disc = r.calls.filter(c => !c.closing);
    check('EVERY bot of the turn is given the earlier chat, not just the first', disc.every(c => c.prompt.includes('Earlier in this chat') && c.prompt.includes('Этап 0: исследовать API Easypanel')), true);
    check('bookkeeping (a failed bot\'s note) is not part of that history', disc.every(c => !c.prompt.includes('hit the 5-turn limit')), true);
    check('the current message is not in the history, it is asked at the end', disc.every(c => c.prompt.indexOf('какой результат?') === c.prompt.lastIndexOf('какой результат?')), true);
    check('the raw replay is no longer handed to anybody', r.calls.every(c => !JSON.stringify(c.contentBlocks || '').includes('Session recovery')), true);
    check('the old attachment is not attached again', r.calls.every(c => !c.contentBlocks), true);
    check('the closing bot has the history too', r.calls.filter(c => c.closing)[0].prompt.includes('Этап 0: исследовать API Easypanel'), true);

    const withNew = [...replay.slice(0, 6), { type: 'text', text: '[User turn 2]' }, { type: 'text', text: '[Attachments from user turn 2]' }, F('new.md'), { type: 'text', text: 'посмотри' }];
    const r2 = await runRoom({ bots: bots3, workdir: dir, rows, prompt: 'посмотри', userContent: withNew, script: discuss });
    const withFiles = r2.calls.filter(c => c.contentBlocks);
    check('the files of THIS message go to the first speaker only', [withFiles.length, withFiles[0].who, withFiles[0].contentBlocks], [1, 'a', [F('new.md')]]);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\nthe prompt no longer grows with every round:');
  {
    const dir = tmp();
    const longRoom = await runRoom({ bots: bots3, workdir: dir, script: (c) => (c.closing ? { text: 'PASS' } : (c.n <= 9 ? { text: `${c.who} ` + 'z'.repeat(11000) } : { text: 'PASS' })) });
    const disc = longRoom.calls.filter(c => !c.closing);
    const biggest = Math.max(...disc.map(c => c.prompt.length));
    check('with nine 11K-character contributions no bot prompt passes ~30K characters (it reached 71K on the real run)', biggest < 32000, true);
    check('a long contribution reaches the next bot cut, with a pointer to the chat', disc[2].prompt.includes('more characters, the full text is in the chat'), true);
    check('the chat itself keeps every word', longRoom.saved.filter(m => m.agent && m.text.length >= 11000).length, 9);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('a bot can run on its own engine (the planner on the subscription in an API chat):');
  {
    const dir = tmp();
    const planner = { ...B('b'), run_engine: 'subscription' };
    const mixed = [B('a'), planner, B('c')];
    const r = await runRoom({ bots: mixed, workdir: dir, perBotEngine: true, closing: false, script: discuss });
    check('the pinned bot goes through the interactive engine, once per round it speaks', r.interactive.map(o => o.agent).every(a => a === 'b') && r.interactive.length >= 1, true);
    check('its interactive run is its own room seat (per-bot tmux id) with a system prompt', r.interactive[0].sessionId === 's1::room::b' && typeof r.interactive[0].systemPrompt === 'string' && r.interactive[0].systemPrompt.length > 0 && r.interactive[0].agent === 'b', true);
    check('the other bots still use the headless (API) CLI', [...new Set(r.calls.map(c => c.who))].sort(), ['a', 'c']);
    check('the pinned bot never touches the headless CLI', r.calls.some(c => c.who === 'b'), false);
    check('its answer is saved under its name', r.saved.some(m => m.agent === 'b' && m.text === 'subscription answer of b'), true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const dir = tmp();
    const planner = { ...B('b'), run_engine: 'subscription' };
    const off = await runRoom({ bots: [B('a'), planner, B('c')], workdir: dir, perBotEngine: false, closing: false, script: discuss });
    check('where the override is not enabled (Telegram) the pinned bot follows the chat', [off.interactive.length, off.calls.some(c => c.who === 'b')], [0, true]);
    const noTmux = await runRoom({ bots: [B('a'), planner, B('c')], workdir: dir, perBotEngine: true, tmux: false, closing: false, script: discuss });
    check('without tmux the pinned bot follows the chat instead of failing', [noTmux.interactive.length, noTmux.calls.some(c => c.who === 'b')], [0, true]);
    const pinnedApi = await runRoom({ bots: [B('a'), { ...B('b'), run_engine: 'api' }, B('c')], workdir: dir, perBotEngine: true, engine: 'subscription', closing: false, script: discuss });
    check('a bot pinned to api runs headless inside a subscription chat, the rest use the interactive engine', [pinnedApi.calls.some(c => c.who === 'b'), pinnedApi.interactive.some(o => o.agent === 'a')], [true, true]);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('the room leaves a restore point and says when a document got much smaller:');
  {
    const dir = tmp();
    const big = '# spec\n' + 'requirement line\n'.repeat(1500);   // ~25 KB
    fs.writeFileSync(path.join(dir, 'TZ.md'), big);
    const r = await runRoom({ bots: bots3, workdir: dir, prompt: 'Доработайте ТЗ',
      git: (n) => (n === 1 ? { managed: true, committed: true, sha: 'aaa1111' } : { managed: true, committed: true, sha: 'bbb2222' }),
      script: (c) => (c.closing ? { text: 'Обновил TZ.md.', write: [['TZ.md', '# spec\nshort\n']] } : discuss(c)) });
    check('the directory is checkpointed before the discussion and again after it', [r.gitCalls.length, r.gitCalls[0].dir === dir, r.gitCalls[0].msg.startsWith('room: before the discussion'), r.gitCalls[1].msg.startsWith('room: Доработайте ТЗ (a, b, c)')], [2, true, true, true]);
    const shrink = r.saved.find(m => m.text.includes('⚠️ **Документы заметно уменьшились'));
    check('a ТЗ cut to a stub is called out (in the same note as the file list), with sizes', !!shrink && /`TZ\.md` — 25 KB → 13 B \(−100%\)/.test(shrink.text), true);
    check('...with the exact way back: the commit from BEFORE the room', !!shrink && shrink.text.includes('git checkout aaa1111 -- <файл>'), true);
    check('the changed file shows before → after in the change list', r.saved.some(m => m.text.includes('`TZ.md` — изменён (25 KB → 13 B)')), true);
    check('the result commit is announced', r.saved.some(m => m.text.includes('📌 Сохранено в git: `bbb2222`')), true);
    check('the warning is streamed to the client', r.sent.some(m => m.type === 'text' && m.text.includes('⚠️ **Документы заметно уменьшились')), true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'TZ.md'), 'x'.repeat(5000));
    const grow = await runRoom({ bots: bots3, workdir: dir, git: () => ({ managed: true, committed: true, sha: 'ccc3333' }),
      script: (c) => (c.closing ? { text: 'Дополнил.', write: [['TZ.md', 'x'.repeat(9000)]] } : discuss(c)) });
    check('a document that grew raises no alarm', grow.saved.some(m => m.text.includes('заметно уменьшились')), false);
    fs.writeFileSync(path.join(dir, 'TZ.md'), 'x'.repeat(5000));
    const foreign = await runRoom({ bots: bots3, workdir: dir,
      script: (c) => (c.closing ? { text: 'Сократил.', write: [['TZ.md', 'x'.repeat(500)]] } : discuss(c)) });
    check('in a repo the app does not manage there is no commit and the warning says there is no git version',
      foreign.saved.some(m => m.text.includes('Версии до правки в git нет')) && !foreign.saved.some(m => m.text.includes('📌')), true);
    const off = await runRoom({ bots: bots3, workdir: dir, gitOn: false, git: () => ({ managed: true, committed: true, sha: 'ddd4444' }),
      script: (c) => (c.closing ? { text: 'x', write: [['TZ.md', 'y'.repeat(10)]] } : discuss(c)) });
    check('ROOM_GIT=off: no checkpoint at all', off.gitCalls.length, 0);
    const failing = await runRoom({ bots: bots3, workdir: dir, git: () => ({ managed: true, error: 'index.lock exists' }),
      script: (c) => (c.closing ? { text: 'Готово.', write: [['TZ.md', 'z'.repeat(6000)]] } : discuss(c)) });
    check('a failed checkpoint costs the room nothing', [failing.calls.some(c => c.closing), failing.saved.some(m => m.text.includes('Комната закрыта') || m.text.includes('Room closed'))], [true, true]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const dir = tmp();
    const plan = await runRoom({ bots: bots3, workdir: dir, mode: 'planning', git: () => ({ managed: true, committed: true, sha: 'eee5555' }), script: discuss });
    check('planning mode reads only: nothing is committed', plan.gitCalls.length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('every bot is told where it works and not to gut a document:');
  {
    const dir = tmp();
    const r = await runRoom({ bots: bots3, workdir: dir, script: discuss });
    const p = r.calls[0].prompt;
    check('the real working directory is in the rules, and made-up /workspace paths are ruled out', p.includes(`working directory is ${dir}`) && p.includes('do not invent paths such as /workspace/'), true);
    check('read before changing, no rewriting from scratch, no shortening unasked', p.includes('Read a file before you change it') && p.includes('do not rewrite a whole document from scratch') && p.includes('do not make one shorter unless the user asked'), true);
    const ro = await runRoom({ bots: bots3, workdir: dir, mode: 'planning', script: discuss });
    check('planning mode tells the path too (it reads)', ro.calls[0].prompt.includes(`working directory is ${dir}`), true);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('a message about a plan brings the planner, and it speaks last and closes:');
  {
    const dir = tmp();
    const roster = [{ ...B('planner'), description: 'plans' }, B('a'), B('b')];
    const r = await runRoom({ bots: roster, workdir: dir, prompt: 'Сделайте из ТЗ пошаговый план', script: (c) => (c.closing ? { text: 'PASS' } : (c.n <= 3 ? { text: `by ${c.who}` } : { text: 'PASS' })) });
    check('round one order: the others first, the planner last', r.calls.filter(c => !c.closing).slice(0, 3).map(c => c.who), ['a', 'b', 'planner']);
    check('the closing step (the file work) is the planner\'s', r.calls.filter(c => c.closing).map(c => c.who), ['planner']);
    const other = await runRoom({ bots: roster, workdir: dir, prompt: 'Проверь пароль в логине', script: (c) => (c.closing ? { text: 'PASS' } : (c.n <= 3 ? { text: `by ${c.who}` } : { text: 'PASS' })) });
    check('a message that is not about a plan leaves the roster order', other.calls.filter(c => !c.closing).slice(0, 3).map(c => c.who), ['planner', 'a', 'b']);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('each bot works under its own file access, and answers as a discussant, not as a form:');
  {
    const dir = tmp();
    const persona = (name) => `Тебя зовут ${name}.\n\nПравила:\n- Первая строка — вывод.\n- Завершай так: ВЕРДИКТ / ДАЛЬШЕ: <имя> — <что делать>.`;
    const roster = [
      { ...B('reader'), room_tools: 'read', system_prompt: persona('Вира') },
      { ...B('runner'), room_tools: 'run', system_prompt: persona('Рита') },
      { ...B('writer'), system_prompt: persona('Катя') },
    ];
    const r = await runRoom({ bots: roster, workdir: dir, prompt: 'Проверь ТЗ', script: (c) => (c.closing ? { text: 'Готово.' } : (c.n <= 3 ? { text: `by ${c.who}` } : { text: 'PASS' })) });
    const by = (who) => r.calls.find(c => c.who === who && !c.closing);
    check('read: only Read/Glob/Grep', by('reader').allowedTools, ['Read', 'Glob', 'Grep']);
    check('run: adds the shell, still no Edit/Write', by('runner').allowedTools, ['Read', 'Glob', 'Grep', 'Bash']);
    check('no scope means work, but as the closer it is read-only until the closing step (see below)', by('writer').allowedTools, ['Read', 'Glob', 'Grep']);
    check('...and has everything when it closes', r.calls.find(c => c.who === 'writer' && c.closing).allowedTools, ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write']);
    check('a read-only bot is told so, and to leave the change to a writer', by('reader').prompt.includes('you can read the project\'s files but not change them') && !by('reader').prompt.includes('You can read and edit files'), true);
    check('a runner is told it may run commands but not edit', by('runner').prompt.includes('read files and run commands, but not edit files'), true);
    check('the closer (last writer) is told its discussion turn is a contribution and the files come after', by('writer').prompt.includes('You close this conversation') && by('writer').prompt.includes('do not change any file') && !by('writer').prompt.includes('You can read and edit files'), true);
    check('read-only bots are asked for the gist when their answer would be long', by('reader').prompt.includes('give the gist in about ten lines'), true);
    check('discussion turns are told to be short', by('reader').prompt.includes('about ten lines at most'), true);
    check('...and their system prompt has no closing report format (nothing to address a peer with)', r.calls.filter(c => !c.closing).every(c => !c.systemPrompt.includes('Завершай так')), true);
    const closing = r.calls.filter(c => c.closing);
    check('the closing step is done by the last bot that may WRITE, not by a read-only last seat', closing.map(c => c.who), ['writer']);
    check('...and it keeps its persona\'s report format (the closing turn is a deliverable)', closing[0].systemPrompt.includes('Завершай так') && closing[0].prompt.includes('use it'), true);
    check('the closer works with full tools', closing[0].allowedTools, ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write']);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const dir = tmp();
    const readers = [{ ...B('a'), room_tools: 'read' }, { ...B('b'), room_tools: 'read' }, { ...B('c'), room_tools: 'run' }];
    const r = await runRoom({ bots: readers, workdir: dir, script: discuss });
    check('a room where nobody may write has no closing run', r.calls.some(c => c.closing), false);
    check('...and says so instead of skipping silently', r.saved.some(m => m.text.startsWith('ℹ️ Ни у кого из участников нет права записи файлов')), true);
    const planning = await runRoom({ bots: readers, workdir: dir, mode: 'planning', script: discuss });
    check('planning mode (read-only anyway) does not complain about it', planning.saved.some(m => m.text.includes('права записи')), false);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('a writer that is not the closer keeps writing in the discussion; the closer writes at the end:');
  {
    const dir = tmp();
    const roster = [B('a'), B('b'), B('c')];   // all may write: c closes
    const r = await runRoom({ bots: roster, workdir: dir, maxTurns: 5, script: (c) => (c.closing ? { text: 'PASS' } : (c.n <= 3 ? { text: `by ${c.who}` } : { text: 'PASS' })) });
    const p = (who) => r.calls.find(c => c.who === who && !c.closing).prompt;
    check('a is an ordinary writer', p('a').includes('You can read and edit files in the project') && !p('a').includes('You close this conversation'), true);
    check('c (last writer) closes: no file changes in its discussion turn', p('c').includes('You close this conversation') && !p('c').includes('You can read and edit files'), true);
    const tools = (who, closing) => r.calls.find(c => c.who === who && !!c.closing === closing).allowedTools;
    check('...and the tool list says so too: the closer\'s discussion turn is read-only', tools('c', false), ['Read', 'Glob', 'Grep']);
    check('an ordinary writer keeps full tools in the discussion', tools('a', false), ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write']);
    check('the closing step gets three times the steps of a discussion turn', [r.calls.find(c => !c.closing).maxTurns, r.calls.find(c => c.closing).maxTurns], [20, 60]);
    const closes = await runRoom({ bots: roster, workdir: dir, script: (c) => (c.closing ? { text: 'Готово.' } : discuss(c)) });
    check('...but in the closing step it has full tools', closes.calls.find(c => c.closing).allowedTools, ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write']);
    const off = await runRoom({ bots: roster, workdir: dir, closing: false, script: discuss });
    check('with the closing step off nobody is told to wait for it, and nobody is held back', [off.calls.some(c => c.prompt.includes('You close this conversation')), off.calls.every(c => c.allowedTools.includes('Write'))], [false, true]);
    const plan = await runRoom({ bots: roster, workdir: dir, mode: 'planning', script: discuss });
    check('planning mode (read-only anyway) has no closer either', plan.calls.some(c => c.prompt.includes('You close this conversation')), false);
    const sub = await runRoom({ bots: roster, workdir: dir, engine: 'subscription', script: discuss });
    check('on the subscription engine there is no closing step, so nobody defers its writing', sub.calls.some(c => c.prompt.includes('You close this conversation')), false);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
