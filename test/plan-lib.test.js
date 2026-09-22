// Pure-logic verification for plan-lib.js. Run: node test/plan-lib.test.js
'use strict';
const assert = require('assert');
const {
  parseScalar, parseTaskFile, extractHeadings, headingCovered,
  lintPlan, buildImportPlan, pickReady, PLAN_TASK_ID_RE, stampImported,
} = require('../plan-lib');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

console.log('parseScalar:');
check('a bare word', parseScalar('kolya-prohramist'), 'kolya-prohramist');
check('an inline list', parseScalar('[ТЗ §3.2, ТЗ §5]'), ['ТЗ §3.2', 'ТЗ §5']);
check('an empty list', parseScalar('[]'), []);
check('surrounding whitespace is trimmed', parseScalar('  sonnet  '), 'sonnet');
check('missing / empty', [parseScalar(undefined), parseScalar('')], ['', '']);

console.log('parseTaskFile:');
const T1 = `---
id: T-001
title: Инициализация репозитория
bot: kolya-prohramist
depends_on: []
model: sonnet
max_turns: 20
covers: [ТЗ §1, ТЗ §2 Хранение]
status: backlog
---
Создать структуру репозитория.

## Контекст
Монорепо, backend + frontend.

## Что сделать
- Создать пакеты.

## Критерии приёмки
- Репозиторий собирается.

## Проверка
\`npm run build\`
`;
{
  const r = parseTaskFile(T1, 'plan/tasks/T-001-init.md');
  check('parses ok', r.ok, true);
  check('id / title / bot', [r.task.id, r.task.title, r.task.bot], ['T-001', 'Инициализация репозитория', 'kolya-prohramist']);
  check('depends_on empty list, not the string "[]"', r.task.depends_on, []);
  check('covers, two entries', r.task.covers, ['ТЗ §1', 'ТЗ §2 Хранение']);
  check('model / max_turns are typed', [r.task.model, r.task.max_turns], ['sonnet', 20]);
  check('status defaults are not silently overwritten by a real value', r.task.status, 'backlog');
  check('body is everything after the closing ---, trimmed', r.task.body.startsWith('Создать структуру') && r.task.body.includes('## Критерии приёмки'), true);
  check('file path travels through', r.task.file, 'plan/tasks/T-001-init.md');
}
{
  const r = parseTaskFile('no front matter here', 'x.md');
  check('no --- block: a reported error, not a throw', [r.ok, /no `---` front matter/.test(r.error)], [false, true]);
}
check('missing id', parseTaskFile('---\ntitle: x\n---\nbody', 'x.md').ok, false);
check('a malformed id is rejected (would break a card badge / the depends_on graph)',
  ['T 001', 'T-001!', 'a'.repeat(40), ''].map(id => parseTaskFile(`---\nid: ${id || '""'}\ntitle: x\n---\n`, 'x.md').ok), [false, false, false, false]);
check('a single-char and a max-length id are fine', ['t', 'A' + 'b'.repeat(31)].map(id => parseTaskFile(`---\nid: ${id}\ntitle: x\n---\n`, 'x.md').ok), [true, true]);
{
  const r = parseTaskFile('---\nid: T-002\ntitle: x\ndepends_on: T-001\ncovers: solo\n---\nbody', 'x.md');
  check('a single non-list value for depends_on/covers is still an array', [r.task.depends_on, r.task.covers], [['T-001'], ['solo']]);
}
check('missing model/max_turns/covers/depends_on are safe defaults, not crashes',
  parseTaskFile('---\nid: T-003\ntitle: x\nbot: kolya-prohramist\n---\n', 'x.md').task,
  { id: 'T-003', title: 'x', bot: 'kolya-prohramist', depends_on: [], covers: [], model: null, max_turns: null, status: 'backlog', body: '', file: 'x.md' });
check('CRLF line endings do not break the front-matter boundary', parseTaskFile('---\r\nid: T-004\r\ntitle: x\r\n---\r\nbody\r\n', 'x.md').ok, true);
check('a comment line inside the front matter is skipped, not treated as a field', parseTaskFile('---\n# a note\nid: T-005\ntitle: x\n---\n', 'x.md').task.id, 'T-005');

console.log('headings and coverage:');
check('## and ### headings, not deeper, in order', extractHeadings('# H0\n## 1. Цель\ntext\n### 1.1 Деталь\n#### too deep\n## 2. Хранение'),
  ['H0', '1. Цель', '1.1 Деталь', '2. Хранение']);
check('a heading matched by shared words', headingCovered('2. Хранение данных', [['ТЗ §2 хранение и бэкапы']]), true);
check('an unrelated heading is not', headingCovered('9. Совсем другое', [['ТЗ §2 хранение']]), false);
check('a short/empty heading is never falsely "uncovered"', [headingCovered('', [[]]), headingCovered('AB', [[]])], [true, true]);
check('no covers anywhere', headingCovered('2. Хранение', []), false);

console.log('lintPlan — errors:');
const BOTS = ['kolya-prohramist', 'taras-qa', 'planner'];
const task = (over) => ({ id: 'T-001', title: 't', bot: 'kolya-prohramist', depends_on: [], covers: ['x'], model: null, max_turns: null, status: 'backlog', body: '## Критерии приёмки\nx\n## Проверка\ny', file: 'f.md', ...over });
check('a clean task set has no errors', lintPlan({ tasks: [task()], botIds: BOTS }).errors, []);
check('a parse error becomes a plan-level error', lintPlan({ tasks: [], parseErrors: ['bad.md: no id'], botIds: BOTS }).errors, [{ taskId: null, message: 'bad.md: no id' }]);
check('duplicate ids', lintPlan({ tasks: [task(), task({ file: 'g.md' })], botIds: BOTS }).errors.some(e => /duplicate id "T-001"/.test(e.message)), true);
check('an unknown bot', lintPlan({ tasks: [task({ bot: 'nobody' })], botIds: BOTS }).errors.some(e => /unknown bot "nobody"/.test(e.message)), true);
check('a deleted-but-still-named bot is the same as unknown (botIds is the LIVE roster)', lintPlan({ tasks: [task({ bot: 'ex-bot' })], botIds: BOTS }).errors.length > 0, true);
check('a missing bot', lintPlan({ tasks: [task({ bot: '' })], botIds: BOTS }).errors.some(e => e.message === 'missing bot'), true);
check('a missing title', lintPlan({ tasks: [task({ title: '' })], botIds: BOTS }).errors.some(e => e.message === 'missing title'), true);
check('depends_on itself', lintPlan({ tasks: [task({ depends_on: ['T-001'] })], botIds: BOTS }).errors.some(e => e.message === 'depends on itself'), true);
check('depends_on a ghost id', lintPlan({ tasks: [task({ depends_on: ['T-999'] })], botIds: BOTS }).errors.some(e => /depends on "T-999"/.test(e.message)), true);
{
  const cyc = lintPlan({ tasks: [task({ id: 'A', depends_on: ['B'] }), task({ id: 'B', depends_on: ['A'] })], botIds: BOTS }).errors;
  check('a 2-cycle: both named, not a crash', cyc.filter(e => e.message === 'part of a dependency cycle').map(e => e.taskId).sort(), ['A', 'B']);
}
{
  const ok = lintPlan({ tasks: [task({ id: 'A' }), task({ id: 'B', depends_on: ['A'] }), task({ id: 'C', depends_on: ['A', 'B'] })], botIds: BOTS }).errors;
  check('a real (non-cyclic) chain raises no cycle error', ok.filter(e => e.message === 'part of a dependency cycle'), []);
}

console.log('lintPlan — warnings (do not block):');
check('no acceptance section', lintPlan({ tasks: [task({ body: '## Проверка\nx' })], botIds: BOTS }).warnings.some(w => /acceptance/.test(w.message)), true);
check('no verification section', lintPlan({ tasks: [task({ body: '## Критерии приёмки\nx' })], botIds: BOTS }).warnings.some(w => /verification/.test(w.message)), true);
check('no covers at all', lintPlan({ tasks: [task({ covers: [] })], botIds: BOTS }).warnings.some(w => w.message === 'covers no ТЗ section'), true);
check('warnings never appear in errors', lintPlan({ tasks: [task({ covers: [] })], botIds: BOTS }).errors, []);

console.log('lintPlan — coverage:');
{
  const tz = ['1. Цель', '2. Хранение', '3. Безопасность'];
  const r = lintPlan({ tasks: [task({ covers: ['1. Цель'] }), task({ id: 'T-002', covers: ['2. Хранение'] })], botIds: BOTS, tzHeadings: tz });
  check('covered / uncovered are counted', r.coverage, { total: 3, covered: 2, uncovered: ['3. Безопасность'] });
  check('an uncovered section is also a warning, named', r.warnings.some(w => w.taskId === null && w.message.includes('3. Безопасность')), true);
}
check('no tzHeadings given: no coverage object, no crash', lintPlan({ tasks: [task()], botIds: BOTS }).coverage, null);
check('every section covered: no warning about it', lintPlan({ tasks: [task({ covers: ['x'] })], botIds: BOTS, tzHeadings: ['x'] }).warnings.some(w => /not covered/.test(w.message)), false);

console.log('pickReady:');
{
  const A = { id: 'A', depends_on: [] }, B = { id: 'B', depends_on: ['A'] }, C = { id: 'C', depends_on: ['A', 'B'] };
  check('only A is ready at the start', pickReady([A, B, C], new Set()).map(t => t.id), ['A']);
  check('B becomes ready once A is done', pickReady([B, C], new Set(['A'])).map(t => t.id), ['B']);
  check('C needs both', pickReady([C], new Set(['A'])).map(t => t.id), []);
}

console.log('buildImportPlan:');
{
  const tasks = [task({ id: 'A' }), task({ id: 'B', depends_on: ['A'] }), task({ id: 'C', depends_on: ['A'] })];
  const all = buildImportPlan({ tasks, errors: [] });
  check('selected=null (default): everything creates, nothing skipped', [all.toCreate.map(t => t.id), all.toUpdate, all.toSkip], [['A', 'B', 'C'], [], []]);
  const some = buildImportPlan({ tasks, errors: [], selected: ['A', 'B'] });
  check('C (not selected) is skipped, named', some.toSkip, [{ id: 'C', reason: 'not selected' }]);
  check('A and B still create', some.toCreate.map(t => t.id), ['A', 'B']);
  const brokenDep = buildImportPlan({ tasks, errors: [], selected: ['B'] });
  check('B alone: its dependency A was not selected, so B is skipped too — never a dangling depends_on',
    brokenDep.toSkip, [{ id: 'A', reason: 'not selected' }, { id: 'B', reason: 'depends on "A", which was not selected' }, { id: 'C', reason: 'not selected' }]);
  const existing = buildImportPlan({ tasks, errors: [], existing: { A: 'kanban-id-1' } });
  check('a plan id already imported updates instead of creating a duplicate', [existing.toUpdate.map(t => t.id), existing.toCreate.map(t => t.id)], [['A'], ['B', 'C']]);
  check('lint errors refuse the whole import, every task named with a reason', buildImportPlan({ tasks, errors: [{ taskId: 'A', message: 'x' }] }),
    { toCreate: [], toUpdate: [], toSkip: [{ id: 'A', reason: 'plan has lint errors' }, { id: 'B', reason: 'plan has lint errors' }, { id: 'C', reason: 'plan has lint errors' }] });
}

console.log('stampImported:');
{
  const src = '---\nid: T-001\ntitle: x\nbot: kolya-prohramist\n---\nbody text\n';
  const out = stampImported(src, { cardId: 'mucabc123', at: '2026-09-22T10:00:00.000Z' });
  check('the two new lines are inside the front matter, before its closing ---', out,
    '---\nid: T-001\ntitle: x\nbot: kolya-prohramist\nimported_card: mucabc123\nimported_at: 2026-09-22T10:00:00.000Z\n---\nbody text\n');
  check('the body is untouched', out.endsWith('---\nbody text\n'), true);
  check('re-parsing the stamped file still works and still gets the original fields', parseTaskFile(out, 'x.md').task.id, 'T-001');
  check('a file with no front matter is returned unchanged, not corrupted', stampImported('no front matter', { cardId: 'x', at: 'y' }), 'no front matter');
  check('empty input does not throw', stampImported('', { cardId: 'x', at: 'y' }), '');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
