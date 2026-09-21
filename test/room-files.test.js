// What a conversation room actually changed on disk (room-files.js).
//
// A real room produced 44 messages and no change to the file the user asked to have finished, while
// the writer said the document was updated. The room now snapshots the working directory before the
// discussion and compares afterwards; these pin the snapshot, the diff and the note.
//
// Run: node test/room-files.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const RF = require('../room-files');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const w = (root, rel, data) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return f; };
const bump = (f, ms = 5000) => { const t = new Date(Date.now() + ms); fs.utimesSync(f, t, t); };   // an mtime step that cannot be missed

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-files-'));
  const TZ = w(root, 'TZ.md', '# spec\n'.repeat(100));
  w(root, 'docs/a.md', 'a');
  w(root, 'src/deep/er/file.js', '1');

  console.log('snapshot:');
  const s1 = await RF.snapshotDir(root);
  check('lists the files by relative, slash-separated path', [...s1.files.keys()].sort(), ['TZ.md', 'docs/a.md', 'src/deep/er/file.js']);
  check('is not truncated', s1.truncated, false);
  check('an entry is "size:mtime"', /^\d+:\d+$/.test(s1.files.get('TZ.md')), true);
  check('nothing changed -> an empty diff', RF.isEmptyDiff(RF.diffSnapshots(s1.files, (await RF.snapshotDir(root)).files)), true);

  console.log('\nignored places:');
  w(root, '.git/HEAD', 'x'); w(root, 'node_modules/p/index.js', 'x'); w(root, '__pycache__/m.pyc', 'x'); w(root, '.kanban-attachments/t1/f.txt', 'x');
  const s2 = await RF.snapshotDir(root);
  check('.git, node_modules, caches and the app\'s attachment folder are not the user\'s work', [...s2.files.keys()].sort(), ['TZ.md', 'docs/a.md', 'src/deep/er/file.js']);

  console.log('\nthe diff:');
  fs.writeFileSync(TZ, '# spec\n'.repeat(100) + 'a new section\n'); bump(TZ);       // modified (size and mtime)
  w(root, 'PLAN.md', 'plan');                                                     // created
  fs.unlinkSync(path.join(root, 'docs/a.md'));                                    // deleted
  const s3 = await RF.snapshotDir(root);
  const d = RF.diffSnapshots(s2.files, s3.files);
  check('modified', d.modified, ['TZ.md']);
  check('created', d.added, ['PLAN.md']);
  check('deleted', d.deleted, ['docs/a.md']);
  check('a rewrite with the same size is still seen (mtime)', (() => {
    const before = new Map([['x', '5:1000']]); return RF.diffSnapshots(before, new Map([['x', '5:2000']])).modified;
  })(), ['x']);
  check('the lists are sorted', RF.diffSnapshots(new Map(), new Map([['b', '1:1'], ['a', '1:1']])).added, ['a', 'b']);

  console.log('\nthe note:');
  const en = RF.describeChanges(d, s3.files, 'en');
  check('lists what changed with the verb and a size', en.includes('- `TZ.md` — changed (') && en.includes('- `PLAN.md` — created (') && en.includes('- `docs/a.md` — deleted'), true);
  check('has the heading', en.startsWith('📁 **Files changed during the discussion:**'), true);
  const ru = RF.describeChanges(d, s3.files, 'ru');
  check('in Russian', ru.includes('изменён') && ru.includes('создан') && ru.includes('удалён') && ru.startsWith('📁 **Файлы, изменённые за время обсуждения:**'), true);
  check('nothing changed -> no note at all', RF.describeChanges({ added: [], modified: [], deleted: [] }, new Map()), '');
  {
    const many = { added: Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, '0')}.md`), modified: [], deleted: [] };
    const note = RF.describeChanges(many, new Map(), 'en', 15);
    check('a long list is cut with a count', (note.match(/^- `/gm) || []).length === 15 && note.includes('and 25'), true);
  }
  check('sizes read as B / KB', [RF.describeChanges({ added: ['a'], modified: [], deleted: [] }, new Map([['a', '500:1']]), 'en').includes('(500 B)'),
    RF.describeChanges({ added: ['a'], modified: [], deleted: [] }, new Map([['a', '2048:1']]), 'en').includes('(2.0 KB)'),
    RF.describeChanges({ added: ['a'], modified: [], deleted: [] }, new Map([['a', '204800:1']]), 'en').includes('(200 KB)')], [true, true, true]);

  console.log('\nbounds and failures never give a wrong verdict:');
  {
    const big = fs.mkdtempSync(path.join(os.tmpdir(), 'room-files-big-'));
    for (let i = 0; i < 30; i++) w(big, `f${i}.txt`, 'x');
    const s = await RF.snapshotDir(big, { maxFiles: 10 });
    check('too many files -> truncated, capped', [s.files.size, s.truncated], [10, true]);
    w(big, 'a/b/c/d/e.txt', 'x');
    const d2 = await RF.snapshotDir(big, { maxDepth: 2 });
    check('too deep -> truncated', d2.truncated, true);
    fs.rmSync(big, { recursive: true, force: true });
  }
  check('a missing root -> an empty, truncated snapshot (no verdict)', await RF.snapshotDir(path.join(root, 'nope')), { files: new Map(), truncated: true });
  check('no root at all -> the same', await RF.snapshotDir(undefined), { files: new Map(), truncated: true });
  {
    const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'room-files-link-'));
    w(linkRoot, 'real.txt', 'x');
    try { fs.symlinkSync(path.join(linkRoot, 'real.txt'), path.join(linkRoot, 'link.txt')); fs.symlinkSync(linkRoot, path.join(linkRoot, 'loop')); } catch {}
    const s = await RF.snapshotDir(linkRoot);
    check('a symlink loop cannot hang the walk (links are not followed as directories)', s.files.has('real.txt'), true);
    fs.rmSync(linkRoot, { recursive: true, force: true });
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
