// The room's restore point (room-git.js), on REAL git repositories in a temp directory.
// Run: node test/room-git.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const WM = require('../worktree-manager');
const RG = require('../room-git');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'room-git-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const ident = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

console.log('which repositories the app may commit to:');
{
  const managed = tmp();
  WM.ensureGitInitialized(managed);   // the app's own init: an "auto-created" root commit
  check('a repo the app created itself', RG.isManaged(managed), true);

  const foreign = tmp();
  git(foreign, 'init', '-q'); fs.writeFileSync(path.join(foreign, 'a.txt'), 'x'); git(foreign, 'add', '-A'); git(foreign, ...ident, 'commit', '-q', '-m', 'my own history');
  check("the user's own repository is left alone", RG.isManaged(foreign), false);
  git(foreign, 'checkout', '-q', '-b', 'ccs/session-abc');
  check('...unless the work is on one of the app\'s own ccs/ branches', RG.isManaged(foreign), true);

  const plain = tmp();
  check('a folder that is not a repository', RG.isManaged(plain), false);
  check('a missing folder', RG.isManaged(path.join(plain, 'nope')), false);

  console.log('checkpoints:');
  fs.writeFileSync(path.join(managed, 'TZ.md'), 'original spec\n'.repeat(500));
  const c1 = RG.checkpoint(managed, 'room: before the discussion — Доработайте ТЗ', WM);
  check('an uncommitted file is committed and the sha is returned', [c1.managed, c1.committed, /^[0-9a-f]{7,}$/.test(c1.sha)], [true, true, true]);
  check('the commit message carries the room\'s words', git(managed, 'log', '-1', '--format=%s'), 'room: before the discussion — Доработайте ТЗ');
  const c2 = RG.checkpoint(managed, 'again', WM);
  check('a clean tree commits nothing and reports the same HEAD', [c2.committed, c2.sha], [false, c1.sha]);

  // the whole point: the bots shorten the file, the earlier version is one checkout away
  fs.writeFileSync(path.join(managed, 'TZ.md'), 'short\n');
  const c3 = RG.checkpoint(managed, `room: ${'x'.repeat(500)}`, WM);
  check('the room\'s result is committed too', [c3.committed, c3.sha === c1.sha], [true, false]);
  check('a long prompt does not make a huge subject', git(managed, 'log', '-1', '--format=%s').length <= 100, true);
  git(managed, 'checkout', '-q', c1.sha, '--', 'TZ.md');
  check('`git checkout <before> -- <file>` brings the original back', fs.readFileSync(path.join(managed, 'TZ.md'), 'utf8').length, 'original spec\n'.length * 500);

  console.log('what it must not do:');
  const f = RG.checkpoint(foreign.replace('x', 'x'), 'm', WM);
  fs.writeFileSync(path.join(foreign, 'b.txt'), 'y');
  git(foreign, 'checkout', '-q', '-b', 'main2'); // off the ccs/ branch: the user's own again
  check('the user\'s repo gets no commit', [RG.checkpoint(foreign, 'm', WM), git(foreign, 'log', '-1', '--format=%s')], [{ managed: false }, 'my own history']);
  check('not a repo: a plain answer, no throw', RG.checkpoint(plain, 'm', WM), { managed: false });
  check('no directory: a plain answer', RG.checkpoint(null, 'm', WM), { managed: false });

  fs.writeFileSync(path.join(managed, 'wip.txt'), 'half done');
  fs.writeFileSync(path.join(managed, '.git', 'MERGE_HEAD'), git(managed, 'rev-parse', 'HEAD') + '\n');
  const busy = RG.checkpoint(managed, 'm', WM);
  check('in the middle of a merge nothing is frozen into history', [busy.skipped, git(managed, 'status', '--porcelain').includes('wip.txt')], ['busy', true]);
  fs.rmSync(path.join(managed, '.git', 'MERGE_HEAD'));

  const broken = RG.checkpoint(managed, 'm', { commitAll() { throw new Error('index.lock exists'); } });
  check('a failing commit is reported, not thrown', [broken.managed, broken.error], [true, 'index.lock exists']);

  check('clip: whitespace and length', [RG.clip('a\n\n  b   c', 5), RG.clip('x'.repeat(100)).length], ['a b c', 72]);
  [managed, foreign, plain].forEach(rm);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
