// The built-in tool names server.js hands to the CLI (`--tools` / `--allowedTools`).
//
// The lists used the pre-1.0 names View / GlobTool / GrepTool / ListDir / SearchReplace.
// Measured on CLI 2.1.197: `--tools Bash,View,GlobTool,GrepTool,ListDir,SearchReplace,Write`
// sends the model only `Bash,Write` — the unknown names are dropped without a word — so an
// agent that tried `Read` got "No such tool available: Read. Read exists but is not enabled
// in this context" while the prompt told it to "read the attached files". A room of bots
// then reported an existing 25 KB attachment as empty. The same names with Read / Glob /
// Grep / Edit / NotebookEdit give `Bash,Edit,Glob,Grep,NotebookEdit,Read,Write`.
//
// Run: node test/cli-tool-names.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const LEGACY = ['View', 'GlobTool', 'GrepTool', 'ListDir', 'ReadNotebook', 'NotebookEditCell', 'SearchReplace'];
// Names of the tools the CLI really has that we hand out; anything else in these lists is a typo.
const REAL = new Set(['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit']);

console.log('server.js hands the CLI only tool names it has:');
for (const name of LEGACY) {
  check(`no '${name}' string literal left`, new RegExp(`['"\`]${name}['"\`]`).test(src), false);
}

// Every array literal that lists built-ins: it starts at 'Bash' or 'Read' and holds plain names.
const lists = [];
const re = /\[\s*'(?:Bash|Read)'(?:\s*,\s*'[A-Za-z_]+')*/g;
for (let m; (m = re.exec(src));) lists.push([...m[0].matchAll(/'([A-Za-z_]+)'/g)].map(x => x[1]).filter(n => !n.startsWith('mcp__')));
check('the tool lists were found (guards the scan itself)', lists.length >= 6, true);
for (const l of lists) check(`[${l.join(',')}] only names real tools`, l.filter(n => !REAL.has(n)), []);
for (const l of lists) if (l.includes('Bash')) check(`[${l.join(',')}] can read a file`, l.includes('Read'), true);

// The room's list. It used to be a literal ['Bash','Read','Glob','Grep'] — no Edit/Write, so a
// bot that wanted to save the document it had just written could only do it through a shell
// redirect — and ignored the chat mode entirely. It now follows the split runCliSingle makes.
console.log('the conversation room has a real tool list:');
{
  const m = /const BOT_READ_TOOLS[\s\S]*?function roomBuiltinTools\(mode, scope\) \{[^\n]*\}/.exec(src);
  check('the shared lists and the helper are found', !!m, true);
  if (m) {
    const roomTools = new Function(m[0] + '; return { roomBuiltinTools, BOT_WORK_TOOLS, BOT_READ_TOOLS };')();
    const tools = roomTools.roomBuiltinTools;
    check('planning: read-only', tools('planning'), ['Read', 'Glob', 'Grep']);
    check('planning: no shell (a shell can write)', tools('planning').includes('Bash'), false);
    for (const mode of ['auto', 'task', undefined]) {
      check(`${mode}: reads, runs commands and writes files`, tools(mode), ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write']);
    }
    check('the caller cannot mutate the shared list', (() => { tools('task').push('X'); return tools('task').length; })(), 6);
    // a bot's own scope (bots.room_tools) narrows what a room lets it do to files
    check("scope 'read': read-only, whatever the mode", [tools('auto', 'read'), tools('task', 'read')], [['Read', 'Glob', 'Grep'], ['Read', 'Glob', 'Grep']]);
    check("scope 'run': read + shell, no Edit/Write", tools('auto', 'run'), ['Read', 'Glob', 'Grep', 'Bash']);
    check("scope 'work' / unset: everything", [tools('auto', 'work'), tools('auto', undefined), tools('auto', null)], [['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write'], ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write'], ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write']]);
    check("planning stays read-only even for a 'work' bot", tools('planning', 'work'), ['Read', 'Glob', 'Grep']);
    check('a scope the room does not know is not a way to more rights', tools('auto', 'root').includes('Write'), true);
    check('@-bots and multi-agent workers use the same base list',
      /const botTools = \[\.\.\.BOT_WORK_TOOLS,/.test(src) && /const agentTools = \[\.\.\.BOT_WORK_TOOLS,/.test(src), true);
  }
  check('the room hands the CLI that list (not a literal)', /allowedTools: roomBuiltinTools\(mode, botsLogic\.roomToolScope\(bot\)\),/.test(src), true);
  check('the room gets the mode from its params', /engine, mode \} = p;/.test(src), true);
  const rules = src.slice(src.indexOf('const ROOM_RULES = '), src.indexOf('const ROOM_RULES = ') + 1800);
  check('the room rules tell bots what they may do in planning mode', rules.includes("Planning mode: read and analyse, but do not modify any file"), true);
  check('…and in the other modes', rules.includes('You can read and edit files in the project'), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
