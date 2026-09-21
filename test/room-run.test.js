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
const toolsSrc = /function roomBuiltinTools\(mode\) \{[^\n]*\}/.exec(SRC)[0];
const BOT_READ_TOOLS = ['Read', 'Glob', 'Grep'], BOT_WORK_TOOLS = ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write'];

const NAMES = ['ROOM_CLOSING', 'ClaudeCLI', 'stmts', 'ROOM_SEATING', 'botsLogic', 'getUserLang', 'pickRoomSeating', 'WORKDIR', 'seatingNote', 'botLangName',
  'roomFiles', 'MULTI_AGENT_MAX_TURNS_CAP', 'mcpServersForBot', 'runInteractiveSingle', 'killInteractiveTmux', 'isAgentSuccess',
  'roomStopReason', 'BOT_READ_TOOLS', 'BOT_WORK_TOOLS', 'tmuxAvailable'];
const build = (deps) => new Function(...NAMES, `${toolsSrc}\n return ${roomSrc.trim().replace(/^async function runConversationRoom/, 'async function runConversationRoom')};`)(...NAMES.map(n => deps[n]));

/** Runs one room turn. `script(call)` decides what each CLI run does: { text, subtype, error, write: [[relPath, data]] }. */
async function runRoom({ closing = true, bots, script, mode = 'auto', maxTurns = 5, prompt = 'Доработайте ТЗ', userContent = 'Доработайте ТЗ', rows = [], workdir, engine = 'api', lang = 'ru', perBotEngine = false, tmux = true }) {
  const saved = [], sent = [], calls = [], interactive = [];
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
  };
  const run = build(deps);
  const ws = { send: (x) => sent.push(JSON.parse(x)) };
  await run({ mcpServers: {}, model: 'sonnet', maxTurns, ws, sessionId: 's1', abortController: new AbortController(), workdir, tabId: 't1', effort: null, userContent, engine, mode, perBotEngine },
    { bots, prompt, rosterBots: bots });
  return { saved, sent, calls, interactive };
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
    check('is named, with the real reason', !!note && note.text.includes('hit the 20-turn limit'), true);
    check('no "the document is updated" warning is invented for it', has(r, /Файлы не менялись/), false);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\nthe turn limit (Steps = 5 lost 8 of 20 replies on the real run):');
  {
    const dir = tmp();
    const r = await runRoom({ bots: bots3, workdir: dir, maxTurns: 5, script: (c) => (c.closing ? { text: 'PASS' } : (c.n === 1 ? { subtype: 'error_max_turns', error: true } : discuss(c))) });
    check('every bot run gets at least 20 steps although the chat says 5', [...new Set(r.calls.map(c => c.maxTurns))], [20]);
    const note = r.saved.find(m => m.text.includes('@a did not finish'));
    check('a bot that still hits the limit is told why — not "see the error above"', !!note && note.text.includes('(hit the 20-turn limit)') && !note.text.includes('see the error above'), true);
    check('the room carries on after it', r.calls.length > 3, true);
    check('the bots are told their budget', r.calls[0].prompt.includes('You have about 20 steps'), true);
    const big = await runRoom({ bots: bots3, workdir: dir, maxTurns: 60, script: discuss });
    check('a bigger Steps is kept', [...new Set(big.calls.map(c => c.maxTurns))], [60]);
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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
