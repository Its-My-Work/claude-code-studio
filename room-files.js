'use strict';
// What a conversation room actually changed on disk.
//
// A room of bots talks a lot and, on a real run, produced 44 messages and no change to the file the
// user asked to have finished — while the writer said the document was updated. The room therefore
// takes a snapshot of the working directory before the discussion and compares it afterwards, so
// what the user is shown is what happened, not what a bot said happened.
//
// Nothing is read: a file is identified by its size and modification time, so a snapshot of a big
// project stays cheap, and the walk is bounded (entries and depth) — when a bound is hit the
// snapshot says so and no verdict is given rather than a wrong one.

const fs = require('fs');
const path = require('path');

// Directories that are not the user's work: version control, dependencies, caches, build output,
// and the app's own attachment folder.
const IGNORE_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', 'dist', 'build',
  '.cache', '.idea', '.vscode', 'target', '.kanban-attachments']);

/** { files: Map(relative path -> "size:mtimeMs"), truncated } for the tree under `root`. Never throws:
 *  an unreadable directory is skipped, a missing root is an empty, truncated snapshot. */
async function snapshotDir(root, { maxFiles = 20000, maxDepth = 8 } = {}) {
  const files = new Map();
  let truncated = false;
  if (!root) return { files, truncated: true };
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { if (dir === root) truncated = true; continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        if (depth + 1 > maxDepth) { truncated = true; continue; }
        stack.push([full, depth + 1]);
      } else if (e.isFile()) {
        if (files.size >= maxFiles) { truncated = true; return { files, truncated }; }
        try {
          const st = await fs.promises.stat(full);
          files.set(path.relative(root, full).split(path.sep).join('/'), `${st.size}:${Math.floor(st.mtimeMs)}`);
        } catch { /* vanished while walking */ }
      }
    }
  }
  return { files, truncated };
}

/** { added, modified, deleted } (sorted relative paths) between two snapshots' `files` maps. */
function diffSnapshots(before, after) {
  const added = [], modified = [], deleted = [];
  for (const [p, sig] of after) {
    if (!before.has(p)) added.push(p);
    else if (before.get(p) !== sig) modified.push(p);
  }
  for (const p of before.keys()) if (!after.has(p)) deleted.push(p);
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

const isEmptyDiff = (d) => !d.added.length && !d.modified.length && !d.deleted.length;

function kb(sig) {
  const n = Number(String(sig || '').split(':')[0]);
  if (!Number.isFinite(n)) return '';
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
}

/** The chat note for a diff. Empty string when nothing changed (the caller decides whether that is
 *  worth a warning). `after` (the files map) supplies sizes. */
function describeChanges(diff, after, lang = 'en', limit = 15) {
  if (isEmptyDiff(diff)) return '';
  const ru = lang === 'ru';
  const verbs = ru ? { added: 'создан', modified: 'изменён', deleted: 'удалён' } : { added: 'created', modified: 'changed', deleted: 'deleted' };
  const rows = [];
  for (const kind of ['modified', 'added', 'deleted']) {
    for (const p of diff[kind]) rows.push(`- \`${p}\` — ${verbs[kind]}${kind === 'deleted' ? '' : (kb(after && after.get(p)) ? ` (${kb(after.get(p))})` : '')}`);
  }
  const shown = rows.slice(0, limit);
  const more = rows.length - shown.length;
  return `📁 **${ru ? 'Файлы, изменённые за время обсуждения' : 'Files changed during the discussion'}:**\n\n${shown.join('\n')}`
    + (more > 0 ? `\n- … ${ru ? 'и ещё' : 'and'} ${more}` : '') + '\n\n';
}

module.exports = { snapshotDir, diffSnapshots, isEmptyDiff, describeChanges, IGNORE_DIRS };
