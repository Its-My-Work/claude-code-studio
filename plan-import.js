'use strict';
// Reads a planner's plan/ package off disk and turns it into the review object the approval card
// shows. Everything DB-specific (matching against existing Kanban cards, writing new ones) stays in
// server.js, next to the other task-writing code it has to stay consistent with; this module only
// knows about files, so it can be tested against a fake filesystem instead of a real project.

const path = require('path');
const planLib = require('./plan-lib');

/** true where the "no such file/dir" is an ordinary, expected absence — not a real read failure. */
const isMissing = (e) => e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');

/**
 * `plan/tasks/*.md` + `plan/00-overview.md`, plus a best-effort guess at the ТЗ file for the
 * coverage check. `fsImpl` defaults to the real `fs` — tests pass an object with the same
 * `.promises.readdir` / `.promises.readFile` shape backed by an in-memory tree.
 * Never throws: a missing plan/ directory is `{ hasPlanDir: false }`, not an error.
 */
async function readPlanFiles({ workdir, fsImpl = require('fs') }) {
  const planDir = path.join(workdir, 'plan');
  const tasksDir = path.join(planDir, 'tasks');
  let names;
  try {
    names = (await fsImpl.promises.readdir(tasksDir)).filter(f => f.endsWith('.md')).sort();
  } catch (e) {
    if (isMissing(e)) return { hasPlanDir: false, tasks: [], parseErrors: [], overview: null, tzPath: null, tzHeadings: null };
    return { hasPlanDir: false, tasks: [], parseErrors: [`plan/tasks/: ${e.message}`], overview: null, tzPath: null, tzHeadings: null };
  }

  const tasks = [], parseErrors = [];
  for (const name of names) {
    const rel = `plan/tasks/${name}`;
    let content;
    try { content = await fsImpl.promises.readFile(path.join(tasksDir, name), 'utf8'); }
    catch (e) { parseErrors.push(`${rel}: could not be read (${e.message})`); continue; }
    const r = planLib.parseTaskFile(content, rel);
    if (r.ok) tasks.push(r.task); else parseErrors.push(r.error);
  }

  let overview = null;
  try { overview = await fsImpl.promises.readFile(path.join(planDir, '00-overview.md'), 'utf8'); } catch { /* optional */ }

  let tzPath = null, tzHeadings = null;
  try {
    const rootNames = await fsImpl.promises.readdir(workdir);
    const guess = planLib.guessTzFile(rootNames);
    if (guess) {
      tzPath = guess;
      tzHeadings = planLib.extractHeadings(await fsImpl.promises.readFile(path.join(workdir, guess), 'utf8'));
    }
  } catch { /* best-effort only — never blocks the review */ }

  return { hasPlanDir: true, tasks, parseErrors, overview, tzPath, tzHeadings };
}

/**
 * The full review: read + lint, plus each task's card-ready summary (title/description capped to
 * CARD_DESCRIPTION_MAX, the rest kept as `body` for the card's `context`). `existing` = the plan_task_id
 * -> kanban task id map the caller already looked up in the DB (server.js does that part).
 */
async function reviewPlan({ workdir, botIds, existing = {}, fsImpl } = {}) {
  const read = await readPlanFiles({ workdir, fsImpl });
  const lint = planLib.lintPlan({ tasks: read.tasks, parseErrors: read.parseErrors, botIds, tzHeadings: read.tzHeadings });
  const groupByTask = (items) => {
    const m = new Map();
    for (const { taskId, message } of items) { if (taskId) { if (!m.has(taskId)) m.set(taskId, []); m.get(taskId).push(message); } }
    return m;
  };
  const errorsByTask = groupByTask(lint.errors), warningsByTask = groupByTask(lint.warnings);
  const globalErrors = lint.errors.filter(e => !e.taskId).map(e => e.message);
  const globalWarnings = lint.warnings.filter(w => !w.taskId).map(w => w.message);

  const tasks = read.tasks.map(t => ({
    id: t.id, title: t.title, bot: t.bot, depends_on: t.depends_on, covers: t.covers,
    model: t.model, max_turns: t.max_turns, file: t.file,
    description: t.body.length > planLib.CARD_DESCRIPTION_MAX ? t.body.slice(0, planLib.CARD_DESCRIPTION_MAX - 1) + '…' : t.body,
    context: t.body,
    errors: errorsByTask.get(t.id) || [], warnings: warningsByTask.get(t.id) || [],
    existingTaskId: existing[t.id] || null,
  }));

  return {
    workdir, hasPlanDir: read.hasPlanDir, tzPath: read.tzPath,
    overview: read.overview ? (read.overview.length > 4000 ? read.overview.slice(0, 4000) + '…' : read.overview) : null,
    tasks, errors: globalErrors, warnings: globalWarnings, coverage: lint.coverage,
    canApprove: read.hasPlanDir && tasks.length > 0 && lint.errors.length === 0,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { readPlanFiles, reviewPlan, isMissing };
