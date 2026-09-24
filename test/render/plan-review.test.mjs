import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { loadFn } from './_load.mjs';

// The plan-review card (planner's plan/ package -> Kanban approval). planReviewCardHtml is pure
// (given the global selection state it reads); the DOM-driving functions around it are checked by
// wiring assertions against the source, same as bot-model.test.mjs does for that editor.
const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');

const T = (id, over = {}) => ({ id, title: `Task ${id}`, bot: 'kolya-prohramist', depends_on: [], covers: [], model: null, max_turns: null, file: `plan/tasks/${id}.md`, description: 'd', context: 'c', errors: [], warnings: [], existingTaskId: null, ...over });
const REVIEW = (over = {}) => ({ workdir: '/wd', hasPlanDir: true, tzPath: null, overview: null, tasks: [T('T-001'), T('T-002', { depends_on: ['T-001'] })], errors: [], warnings: [], coverage: null, canApprove: true, generatedAt: '2026-01-01T00:00:00Z', ...over });

Object.assign(globalThis, {
  escH: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  t: (k) => ({
    'plan.review.title': 'Обзор плана', 'plan.review.sub': '{n} задач', 'plan.review.sub_tz': '{n} задач, по {tz}',
    'plan.errors.title': 'Нельзя утвердить:', 'plan.warnings.title': 'Стоит знать:', 'plan.deps': 'Зависит от:',
    'plan.will_update': 'обновит карточку', 'plan.empty': 'Нет задач.', 'plan.selected.count': '{n} из {total} выбрано',
    'plan.approve.btn': 'Утвердить ({n})', 'plan.approve.none': 'Ничего не выбрано', 'plan.approving': 'Импортирую…',
    'plan.approve.retry': 'Повторить', 'plan.imported.title': 'План импортирован', 'plan.imported.done': 'Импортировано',
    'plan.imported.detail': 'создано {c}, обновлено {u}, пропущено {s}', 'plan.import.err': 'Ошибка',
  })[k] || k,
  _planSelections: {}, _planReviews: {},
});
const planReviewCardHtml = loadFn('planReviewCardHtml');

// ── not yet imported: checkboxes, both tasks, approve button enabled and counted
{
  globalThis._planSelections['m1'] = new Set(['T-001', 'T-002']);
  const out = planReviewCardHtml(REVIEW(), 'm1', null);
  assert.ok(out.includes('data-message-id="m1"'), 'card carries the message id (for later updates)');
  assert.strictEqual((out.match(/data-task-id="T-00/g) || []).length, 2, 'one checkbox per task');
  assert.ok(out.includes('checked'), 'selected tasks start checked');
  assert.ok(!/prc-approve-btn"[^>]*disabled/.test(out), 'approve is enabled with everything selected and no lint errors');
  assert.ok(out.includes('Утвердить (2)'), 'the button counts the current selection');
  assert.ok(out.includes('Обзор плана') && !out.includes('План импортирован'), 'review title, not the imported one');
  assert.ok(out.includes('T-001') && out.includes('kolya-prohramist'), 'task id and bot are shown');
  assert.ok(out.includes('Зависит от:') && out.includes('T-001'), "T-002's dependency on T-001 is shown");
}

// ── restored from the DB: no pre-seeded selection (this is the real bug — a page reload renders
// the card with _planSelections[messageId] never set, and checkboxes drew as checked while the
// count and the button both read 0, because they defaulted an unset Set two different ways)
{
  delete globalThis._planSelections['m1b'];
  const out = planReviewCardHtml(REVIEW(), 'm1b', null);
  const checkedBoxes = (out.match(/data-task-id="[^"]*"\s+checked/g) || []).length;
  assert.strictEqual(checkedBoxes, 2, 'both checkboxes are drawn checked, same as the "N selected" count below');
  assert.ok(out.includes('2 из 2 выбрано') || out.includes('Утвердить (2)'), 'the count and the button agree with the checkboxes, not stuck at 0');
  assert.ok(!/prc-approve-btn"[^>]*disabled/.test(out), 'approve is enabled, not disabled by an empty default selection');
  assert.deepStrictEqual(globalThis._planSelections['m1b'], new Set(['T-001', 'T-002']), 'rendering it also populated the selection Set (self-healing), so a click right after works');
}
{
  // and the click itself: on a card that was only ever rendered via the restore path (no _prRender
  // call), _prTogglePlanTask must not silently no-op for lack of a Set to mutate. This is exactly
  // the DB-restore call site's own job (set _planReviews[id] before rendering) — done here by hand
  // to isolate the check to _prTogglePlanTask/_prDepMap themselves.
  delete globalThis._planSelections['m1c'];
  // independent tasks here — the cascade-to-dependents behaviour is a separate concern, not what
  // this check is isolating (REVIEW()'s default T-002 depends on T-001, which would also unselect)
  const review = REVIEW({ tasks: [T('T-001'), T('T-002')] });
  globalThis._planReviews['m1c'] = review;
  planReviewCardHtml(review, 'm1c', null);
  globalThis._prDepMap = loadFn('_prDepMap');
  globalThis._prTogglePlanTask = loadFn('_prTogglePlanTask');
  globalThis._prRerenderTasks = () => {}; // the DOM half is exercised in the live-Chrome check, not here
  globalThis._prTogglePlanTask('m1c', 'T-001', false);
  assert.deepStrictEqual(globalThis._planSelections['m1c'], new Set(['T-002']), 'unchecking one task actually changes the Set after a DB-restored render');
  delete globalThis._prDepMap; delete globalThis._prTogglePlanTask; delete globalThis._prRerenderTasks;
}

// ── errors block the whole approval; a task with its own error is disabled and unchecked
{
  const withErr = REVIEW({ errors: ['duplicate id "T-001"'], canApprove: false, tasks: [T('T-001', { errors: ['duplicate id "T-001"'] }), T('T-002')] });
  globalThis._planSelections['m2'] = new Set(['T-002']);
  const out = planReviewCardHtml(withErr, 'm2', null);
  assert.ok(/prc-approve-btn"[^>]*disabled/.test(out), 'a plan-level error disables approval');
  assert.ok(out.includes('Нельзя утвердить:') && out.includes('duplicate id'), 'the error is shown, named');
  assert.ok(/data-task-id="T-001"[^>]*disabled/.test(out), "a task WITH its own error can't be checked");
  assert.ok(out.includes('prc-task-err'), 'that row is visually flagged');
}

// ── warnings show but do not disable
{
  const withWarn = REVIEW({ warnings: ['1 of 2 ТЗ sections not covered'] });
  globalThis._planSelections['m3'] = new Set(['T-001', 'T-002']);
  const out = planReviewCardHtml(withWarn, 'm3', null);
  assert.ok(out.includes('Стоит знать:') && out.includes('not covered'), 'warnings are shown');
  assert.ok(!/prc-approve-btn"[^>]*disabled/.test(out), 'a warning alone does not disable approval');
}

// ── the ТЗ file name, when known, is in the subtitle
{
  globalThis._planSelections['m4'] = new Set(['T-001', 'T-002']);
  const out = planReviewCardHtml(REVIEW({ tzPath: 'TZ-project.md' }), 'm4', null);
  assert.ok(out.includes('TZ-project.md'), 'the guessed ТЗ file is named');
}

// ── a task already imported once is marked, without a checkbox re-creating a duplicate concern
{
  globalThis._planSelections['m5'] = new Set(['T-001', 'T-002']);
  const out = planReviewCardHtml(REVIEW({ tasks: [T('T-001', { existingTaskId: 'kanban-1' }), T('T-002')] }), 'm5', null);
  assert.ok(out.includes('обновит карточку'), 'an already-imported task says it will update, not duplicate');
}

// ── no tasks at all: a plain message, not a broken empty table
{
  const out = planReviewCardHtml(REVIEW({ tasks: [], canApprove: false }), 'm6', null);
  assert.ok(out.includes('Нет задач.'), 'an empty plan says so');
}

// ── the imported (done) state: no checkboxes, no approve button, counts shown
{
  const out = planReviewCardHtml(REVIEW(), 'm7', { created: 2, updated: 1, skipped: [{ id: 'X', reason: 'not selected' }] });
  assert.ok(!out.includes('type="checkbox"') && !out.includes('prc-approve-btn'), 'no interactive controls once imported');
  assert.ok(out.includes('План импортирован') && out.includes('Импортировано'), 'the done title and line are shown');
  assert.ok(out.includes('создано 2, обновлено 1, пропущено 1'), 'the counts are substituted in');
}

// ── wiring: WS cases, DB-restore path, ingestion-loop branch, exclusions, saveBot-style hidden state
assert.ok(/case 'plan_review':[\s\S]{0,120}_prRender\(d\.review, d\.messageId\)/.test(html), "the WS 'plan_review' frame renders the live card");
{
  const m = /_planReviews\[String\(m\.id\)\] = review;[\s\S]{0,200}?planReviewCardHtml\(review, String\(m\.id\)/.exec(html);
  assert.ok(m, '_planReviews is set BEFORE the DB-restore render, not after (the bug: a click on a restored card found nothing to toggle)');
}
{
  // Reported live, with a screenshot: a reloaded chat showed the card AND, right under it, the
  // raw JSON it was built from as a second message. Cause: the card was inserted with .before()
  // in front of the message bubble instead of replacing its content, same as agent_plan already
  // does one branch up — so the bubble kept rendering the JSON as markdown text.
  const restoreStart = html.indexOf("else if (m.role === 'assistant' && m.type === 'plan_review')");
  assert.notStrictEqual(restoreStart, -1, 'plan_review is its own branch in the same if/else chain agent_plan uses (so a plain assistant bubble is never built for it first)');
  const restore = html.slice(restoreStart, html.indexOf("} else if (m.role === 'assistant') {", restoreStart));
  assert.ok(!restore.includes('.before('), 'the plan_review branch no longer inserts the card next to a raw-JSON bubble');
  assert.ok(restore.includes("w.querySelector('.msg').innerHTML = planReviewCardHtml(review, String(m.id)"), 'the card REPLACES the message body, exactly like the agent_plan branch above it');
  assert.ok(restore.includes("w.querySelector('.msg').innerHTML = renderMd(m.content);"), 'a malformed row falls back to plain rendering instead of an empty bubble');
}
assert.ok(/case 'plan_import_result':[\s\S]{0,60}_prShowResult\(d\)/.test(html), "the WS 'plan_import_result' frame updates it");
assert.ok(/m\.role === 'assistant' && m\.type === 'plan_review'/.test(html), 'a reloaded session restores the card from its DB row');
assert.ok(/m\.type === 'plan_review'\) \{ _allMsgs\.push\(m\); continue; \}/.test(html), 'the ingestion loop keeps plan_review rows for the restore pass');
assert.ok(/m\.type !== 'agent_plan' && m\.type !== 'plan_review'/.test(html), 'no stray "Done" footer glued under the card');
assert.ok(/m\.type === 'agent_plan' \|\| m\.type === 'plan_review'\) continue;/.test(html), 'markdown export skips the raw JSON row, not just agent_plan\'s');
assert.ok(/type: 'approve_plan', sessionId: currentSessionId, workdir: curWorkdir \|\| undefined, selected: \[\.\.\.sel\], messageId, tabId: activeTabId/.test(html), 'approving sends the exact selection, not "everything"');

console.log('plan-review: ok');
