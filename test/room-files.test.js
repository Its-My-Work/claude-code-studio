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

  console.log('a document that came out much smaller is called out:');
  {
    const B = (n) => `${n}:1000`, A = (n) => `${n}:2000`;
    const before = new Map([['TZ.md', B(25937)], ['plan.md', B(52703)], ['small.md', B(900)], ['same.md', B(5000)], ['grown.md', B(4000)], ['gone.md', B(8000)], ['tiny-gone.md', B(100)]]);
    const after = new Map([['TZ.md', A(13800)], ['plan.md', A(23010)], ['small.md', A(100)], ['same.md', A(4900)], ['grown.md', A(9000)], ['new.md', A(500)]]);
    const diff = RF.diffSnapshots(before, after);
    const shrunk = RF.shrunkFiles(diff, before, after);
    check('the ТЗ that went 25.9 KB -> 13.8 KB is named, biggest loss (in bytes) first', shrunk.map(s => [s.path, s.pct]), [['plan.md', 56], ['TZ.md', 47], ['gone.md', 100]]);
    check('a tiny file, a small change and a growing file are not news', shrunk.some(s => ['small.md', 'same.md', 'grown.md', 'tiny-gone.md', 'new.md'].includes(s.path)), false);
    check('a threshold of exactly 80% is not a shrink; below is', [RF.shrunkFiles({ modified: ['x'], deleted: [] }, new Map([['x', B(1000)]]), new Map([['x', A(800)]]), { minBytes: 0 }).length,
      RF.shrunkFiles({ modified: ['x'], deleted: [] }, new Map([['x', B(1000)]]), new Map([['x', A(799)]]), { minBytes: 0 }).length], [0, 1]);
    check('missing maps do not throw', RF.shrunkFiles({ modified: ['x'], deleted: ['y'] }, null, null), []);

    const w = RF.describeShrink(shrunk, { lang: 'ru', ref: 'abc1234' });
    check('the warning lists sizes and percentages', w.includes('`TZ.md` — 25 KB → 13 KB (−47%)') && w.includes('`plan.md` — 51 KB → 22 KB (−56%)'), true);
    check('...and the exact way back', w.includes('git checkout abc1234 -- <файл>'), true);
    check('without a git version it says there is none', RF.describeShrink(shrunk, { lang: 'ru' }).includes('Версии до правки в git нет'), true);
    check('English', RF.describeShrink(shrunk, { lang: 'en', ref: 'abc1234' }).includes('Documents got much smaller'), true);
    check('nothing to say, nothing said', [RF.describeShrink([], { lang: 'ru' }), RF.describeShrink(null)], ['', '']);
    check('the list is capped', RF.describeShrink(Array.from({ length: 9 }, (_, i) => ({ path: `f${i}`, from: 9000, to: 1, pct: 99 })), { limit: 5 }).includes('… and 4'), true);

    const note = RF.describeChanges(diff, after, 'ru', 15, before);
    check('a changed file shows "before → after" when the before map is given', note.includes('`TZ.md` — изменён (25 KB → 13 KB)'), true);
    check('...and just its size without it (old callers)', RF.describeChanges(diff, after, 'ru').includes('`TZ.md` — изменён (13 KB)'), true);
    check('a new file shows its size, a deleted one none', note.includes('`new.md` — создан (500 B)') && note.includes('`gone.md` — удалён\n'), true);
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
