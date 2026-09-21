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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
