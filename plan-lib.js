'use strict';
// Turning a planner's plan/ package into Kanban cards — the part that must never guess.
//
// A room rewrote the user's ТЗ from 25.9 KB to 13.8 KB and a plan claimed "~70 lines" when it was
// 341 (see docs/room-guardrails.md); the model that writes the plan is not the model that gets to
// decide it is correct. This module is the check: pure functions, no fs, no LLM call, so a plan
// package is validated the same way every time and the check itself has its own tests.
//
// Format `plan/tasks/T-001-slug.md` writes (see the `planner` bot's own prompt):
//   ---
//   id: T-001
//   title: short title
//   bot: kolya-prohramist
//   depends_on: []
//   model: sonnet
//   max_turns: 30
//   covers: [ТЗ §3.2, ТЗ §5]
//   status: backlog
//   ---
//   body...
// `plan/00-overview.md` is prose with `## N. ...`-style headings; those headings, matched loosely
// against every task's `covers`, are the coverage check.

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const CARD_DESCRIPTION_MAX = 2000; // tasks.description column cap (server.js saveBot has the analogous BOT_DESC_MAX)
const PLAN_TASK_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/; // short, so it reads on a card badge

/** One `key: value` front-matter line into a JS value. Only what the planner's own format uses:
 *  a bare scalar, or `[a, b, c]` (no nested structures, no quoting rules beyond trim). */
function parseScalar(raw) {
  const v = String(raw ?? '').trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    return inner ? inner.split(',').map(s => s.trim()).filter(Boolean) : [];
  }
  return v;
}

/**
 * One `plan/tasks/*.md` file's text -> { ok, task, error }. Never throws: a file that does not
 * parse is reported as an error tied to its path, not a crash of the whole import.
 */
function parseTaskFile(content, filePath) {
  const m = FRONT_MATTER_RE.exec(String(content ?? ''));
  if (!m) return { ok: false, error: `${filePath}: no \`---\` front matter block found` };
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i === -1) continue; // a continuation line of a multi-line value we do not support — ignored, not fatal
    fields[line.slice(0, i).trim()] = parseScalar(line.slice(i + 1));
  }
  const body = m[2].replace(/^\r?\n/, '');
  const id = typeof fields.id === 'string' ? fields.id.trim() : '';
  if (!id) return { ok: false, error: `${filePath}: missing \`id\`` };
  if (!PLAN_TASK_ID_RE.test(id)) return { ok: false, error: `${filePath}: id "${id}" is not 1-32 characters of a-z, 0-9, _ or -, starting with a letter` };
  const title = typeof fields.title === 'string' ? fields.title.trim() : '';
  const bot = typeof fields.bot === 'string' ? fields.bot.trim().toLowerCase() : '';
  const dependsOn = Array.isArray(fields.depends_on) ? fields.depends_on.filter(Boolean) : (fields.depends_on ? [String(fields.depends_on).trim()] : []);
  const covers = Array.isArray(fields.covers) ? fields.covers : (fields.covers ? [String(fields.covers).trim()] : []);
  const maxTurns = Number.parseInt(fields.max_turns, 10);
  return {
    ok: true,
    task: {
      id, title, bot, depends_on: dependsOn, covers,
      model: typeof fields.model === 'string' && fields.model.trim() ? fields.model.trim() : null,
      max_turns: Number.isInteger(maxTurns) && maxTurns > 0 ? maxTurns : null,
      status: typeof fields.status === 'string' && fields.status.trim() ? fields.status.trim() : 'backlog',
      body: body.trim(),
      file: filePath,
    },
  };
}

/** `## 1. Something` / `## Something` headings from the overview or the ТЗ, for the coverage check.
 *  Loose on purpose: this cross-references free text a bot wrote, not a schema. */
function extractHeadings(markdown) {
  return [...String(markdown ?? '').matchAll(/^#{1,3}[ \t]+(.+?)[ \t]*$/gm)].map(m => m[1].trim()).filter(Boolean);
}

/** Does any task's `covers` mention this heading? Matched by shared words (3+ letters/digits), not
 *  exact text — "ТЗ §3.2 Аутентификация" covering "3.2 Аутентификация и сессии" is the normal case. */
function headingCovered(heading, coversByTask) {
  const words = (s) => new Set((String(s).toLowerCase().match(/[a-zа-яё0-9]{3,}/gi) || []));
  const hw = words(heading);
  if (!hw.size) return true; // nothing to match against — do not manufacture a false "uncovered"
  // A short heading ("Хранение") is one meaningful word; requiring 2 shared words would never match
  // it against anything. Half the heading's own words, floor 1, is enough to call it the same topic.
  const need = Math.max(1, Math.ceil(hw.size / 2));
  for (const covers of coversByTask) {
    for (const c of covers) {
      const cw = words(c);
      let shared = 0;
      for (const w of cw) if (hw.has(w)) shared++;
      if (shared >= need) return true;
    }
  }
  return false;
}

const DEP_CYCLE_LIMIT = 500; // guards a pathological plan; a real one is a few dozen tasks at most

/** The tasks whose dependencies are all satisfied, given `done` (a Set of ids already placed). */
function pickReady(remaining, done) {
  return remaining.filter(t => t.depends_on.every(d => done.has(d)));
}

/**
 * Lint a parsed set of task files against the real bot roster and (optionally) the ТЗ's headings.
 * -> { errors: [{taskId, message}], warnings: [{taskId, message}], coverage: {total, covered, uncovered} }
 * `errors` block approval; `warnings` do not. `botIds` is the live, non-deleted roster — a plan
 * naming a bot that does not exist, or one that was deleted since, is an error either way.
 */
function lintPlan({ tasks, parseErrors = [], botIds = [], tzHeadings = null } = {}) {
  const errors = parseErrors.map(message => ({ taskId: null, message }));
  const warnings = [];
  const bots = new Set(botIds);
  const seen = new Map(); // id -> file, for duplicate detection

  for (const t of tasks) {
    if (seen.has(t.id)) errors.push({ taskId: t.id, message: `duplicate id "${t.id}" (${seen.get(t.id)} and ${t.file})` });
    else seen.set(t.id, t.file);
  }
  const ids = new Set(tasks.map(t => t.id));
  for (const t of tasks) {
    if (!t.title) errors.push({ taskId: t.id, message: 'missing title' });
    if (!t.bot) errors.push({ taskId: t.id, message: 'missing bot' });
    else if (!bots.has(t.bot)) errors.push({ taskId: t.id, message: `unknown bot "${t.bot}"` });
    for (const d of t.depends_on) {
      if (d === t.id) errors.push({ taskId: t.id, message: 'depends on itself' });
      else if (!ids.has(d)) errors.push({ taskId: t.id, message: `depends on "${d}", which does not exist in this plan` });
    }
    if (!/##\s*Критерии приёмки|##\s*Acceptance/i.test(t.body)) warnings.push({ taskId: t.id, message: 'no acceptance-criteria section' });
    if (!/##\s*Проверка|##\s*Verif/i.test(t.body)) warnings.push({ taskId: t.id, message: 'no verification section' });
    if (!t.covers.length) warnings.push({ taskId: t.id, message: 'covers no ТЗ section' });
  }

  // Cycle detection: repeat "place everything that is ready" until nothing more can go. What is
  // left over is exactly the cycle (or a dependency this loop already reported as missing above).
  {
    const byId = new Map(tasks.filter(t => ids.has(t.id) && t.depends_on.every(d => ids.has(d) || d === t.id)).map(t => [t.id, t]));
    const remaining = [...byId.values()];
    const done = new Set();
    let guard = 0;
    while (remaining.length && guard++ < DEP_CYCLE_LIMIT) {
      const ready = pickReady(remaining, done);
      if (!ready.length) break;
      for (const t of ready) { done.add(t.id); remaining.splice(remaining.indexOf(t), 1); }
    }
    for (const t of remaining) errors.push({ taskId: t.id, message: 'part of a dependency cycle' });
  }

  let coverage = null;
  if (tzHeadings) {
    const coversByTask = tasks.map(t => t.covers);
    const uncovered = tzHeadings.filter(h => !headingCovered(h, coversByTask));
    coverage = { total: tzHeadings.length, covered: tzHeadings.length - uncovered.length, uncovered };
    if (uncovered.length) warnings.push({ taskId: null, message: `${uncovered.length} of ${tzHeadings.length} ТЗ section(s) not covered by any task: ${uncovered.slice(0, 8).join('; ')}${uncovered.length > 8 ? '…' : ''}` });
  }

  return { errors, warnings, coverage };
}

/**
 * The board-import plan for one selection: which plan tasks become a NEW Kanban card, which
 * UPDATE an existing one (matched by `existing`: plan task id -> kanban task id, already imported
 * once), and which are skipped with a reason (not selected, or depends on something not selected).
 * Pure: no DB, no fs. `selected` = null means "everything the linter did not block".
 */
function buildImportPlan({ tasks, errors, existing = {}, selected = null }) {
  if (errors.length) return { toCreate: [], toUpdate: [], toSkip: tasks.map(t => ({ id: t.id, reason: 'plan has lint errors' })) };
  const want = selected === null ? new Set(tasks.map(t => t.id)) : new Set(selected);
  const toCreate = [], toUpdate = [], toSkip = [];
  for (const t of tasks) {
    if (!want.has(t.id)) { toSkip.push({ id: t.id, reason: 'not selected' }); continue; }
    const missingDep = t.depends_on.find(d => !want.has(d));
    if (missingDep) { toSkip.push({ id: t.id, reason: `depends on "${missingDep}", which was not selected` }); continue; }
    (existing[t.id] ? toUpdate : toCreate).push(t);
  }
  return { toCreate, toUpdate, toSkip };
}

// Which root-level file is "the ТЗ", for the coverage check — a guess, not a contract: the planner's
// prompt does not fix a filename (in the one project this shipped against it is TZ-easypanel-hub.md).
// Deliberately narrow (word "tz"/"тз" or "спец") rather than e.g. matching "spec" or "readme", which
// would as happily match an unrelated file and produce a coverage report that means nothing.
const TZ_NAME_RE = /(^|[^a-zа-яё])(tz|тз|спец)([^a-zа-яё]|$)/i;
function guessTzFile(names) {
  const hit = (names || []).filter(n => /\.md$/i.test(n) && TZ_NAME_RE.test(n)).sort();
  return hit[0] || null;
}

module.exports = {
  CARD_DESCRIPTION_MAX, PLAN_TASK_ID_RE, FRONT_MATTER_RE,
  parseScalar, parseTaskFile, extractHeadings, headingCovered, guessTzFile,
  lintPlan, buildImportPlan, pickReady,
};
