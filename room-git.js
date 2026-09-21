'use strict';
// A restore point for a room's work. A room of bots rewrote the user's ТЗ (25.9 KB -> 13.8 KB) and the
// only copy of the original was the git HEAD nobody had committed against. So the room commits the
// working directory before it starts and after it finished: whatever the bots do, the state before is
// one `git checkout` away.
//
// Only in a repository this app manages (its own auto-created root commit, or one of its `ccs/...`
// branches): a project the user keeps under their own history is not committed to behind their back.
// Never throws — a failed checkpoint must not cost the room its turn.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MANAGED_ROOT_SUBJECT = 'Initial commit (auto-created by Claude Code Studio)';

function git(dir, args, timeout = 15000) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Is `dir` inside a work tree whose history this app owns? */
function isManaged(dir) {
  try { if (git(dir, ['rev-parse', '--is-inside-work-tree']) !== 'true') return false; } catch { return false; }
  try { if (git(dir, ['branch', '--show-current']).startsWith('ccs/')) return true; } catch { /* detached / unborn */ }
  try {
    return git(dir, ['rev-list', '--max-parents=0', 'HEAD']).split('\n').filter(Boolean)
      .some(root => git(dir, ['log', '-1', '--format=%s', root]) === MANAGED_ROOT_SUBJECT);
  } catch { return false; }
}

/** A merge or rebase in progress: committing the tree now would freeze someone's half-done work into history. */
function midOperation(dir) {
  try {
    const gitDir = path.resolve(dir, git(dir, ['rev-parse', '--git-dir']));
    return ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD'].some(n => fs.existsSync(path.join(gitDir, n)));
  } catch { return false; }
}

const clip = (s, n = 72) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Commit whatever is uncommitted in `dir` (if anything) and say where HEAD is now.
 * -> { managed:false } | { managed:true, skipped:'busy' } | { managed:true, committed, sha } | { managed:true, error }
 * `wm` is worktree-manager (its commitAll supplies a git identity on a machine that has none).
 */
function checkpoint(dir, message, wm) {
  try {
    if (!dir || !isManaged(dir)) return { managed: false };
    if (midOperation(dir)) return { managed: true, skipped: 'busy' };
    const r = wm.commitAll({ worktreeDir: dir, message: clip(message, 100) });
    return { managed: true, committed: !!r.committed, sha: git(dir, ['rev-parse', '--short', 'HEAD']) };
  } catch (e) {
    return { managed: true, error: String((e && e.message) || e).slice(0, 160) };
  }
}

module.exports = { checkpoint, isManaged, midOperation, clip, MANAGED_ROOT_SUBJECT };
