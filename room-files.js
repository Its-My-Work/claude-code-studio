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

const sizeOf = (sig) => { if (sig == null || sig === '') return null; const n = Number(String(sig).split(':')[0]); return Number.isFinite(n) ? n : null; };
const kbN = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`);

/**
 * Files the room made much smaller (or removed): [{path, from, to, pct}]. A bot asked to "finish" a spec
 * rewrote it from scratch and left half of it, and the only sign was a lower file size. Small files are
 * ignored (a 300-byte note halving is not news).
 */
function shrunkFiles(diff, before, after, { ratio = 0.8, minBytes = 2048 } = {}) {
  const out = [];
  for (const p of diff.modified) {
    const b = sizeOf(before && before.get(p)), a = sizeOf(after && after.get(p));
    if (b != null && a != null && b >= minBytes && a < b * ratio) out.push({ path: p, from: b, to: a, pct: Math.round((1 - a / b) * 100) });
  }
  for (const p of diff.deleted) {
    const b = sizeOf(before && before.get(p));
    if (b != null && b >= minBytes) out.push({ path: p, from: b, to: 0, pct: 100 });
  }
  return out.sort((x, y) => y.from - y.to - (x.from - x.to));
}

/** The warning under the change list. `ref` = the git commit holding the state before the room, when there is one. */
function describeShrink(shrunk, { lang = 'en', ref = null, limit = 5 } = {}) {
  if (!shrunk || !shrunk.length) return '';
  const ru = lang === 'ru';
  const rows = shrunk.slice(0, limit).map(s => `- \`${s.path}\` — ${kbN(s.from)} → ${kbN(s.to)} (−${s.pct}%)`);
  const more = shrunk.length - rows.length;
  const restore = ref
    ? (ru ? `Если сокращать не просили, верните прежнюю версию: \`git checkout ${ref} -- <файл>\` в папке проекта.`
      : `If you did not ask for it to be shortened, restore the earlier version: \`git checkout ${ref} -- <file>\` in the project folder.`)
    : (ru ? 'Версии до правки в git нет: восстановите файл из своей копии.' : 'There is no pre-edit version in git: restore the file from your own copy.');
  return `⚠️ **${ru ? 'Документы заметно уменьшились' : 'Documents got much smaller'}:**\n\n${rows.join('\n')}`
    + (more > 0 ? `\n- … ${ru ? 'и ещё' : 'and'} ${more}` : '') + `\n\n${restore}\n\n`;
}

/** The chat note for a diff. Empty string when nothing changed (the caller decides whether that is
 *  worth a warning). `after` (the files map) supplies sizes; with `before` a changed file shows "old → new". */
function describeChanges(diff, after, lang = 'en', limit = 15, before = null) {
  if (isEmptyDiff(diff)) return '';
  const ru = lang === 'ru';
  const verbs = ru ? { added: 'создан', modified: 'изменён', deleted: 'удалён' } : { added: 'created', modified: 'changed', deleted: 'deleted' };
  const rows = [];
  const size = (kind, p) => {
    if (kind === 'deleted') return '';
    const a = sizeOf(after && after.get(p)), b = kind === 'modified' ? sizeOf(before && before.get(p)) : null;
    if (a == null) return '';
    return b != null && b !== a ? ` (${kbN(b)} → ${kbN(a)})` : ` (${kb(after.get(p))})`;
  };
  for (const kind of ['modified', 'added', 'deleted']) {
    for (const p of diff[kind]) rows.push(`- \`${p}\` — ${verbs[kind]}${size(kind, p)}`);
  }
  const shown = rows.slice(0, limit);
  const more = rows.length - shown.length;
  return `📁 **${ru ? 'Файлы, изменённые за время обсуждения' : 'Files changed during the discussion'}:**\n\n${shown.join('\n')}`
    + (more > 0 ? `\n- … ${ru ? 'и ещё' : 'and'} ${more}` : '') + '\n\n';
}

module.exports = { snapshotDir, diffSnapshots, isEmptyDiff, describeChanges, shrunkFiles, describeShrink, IGNORE_DIRS };
