// plan-import.js against a fake in-memory filesystem — no real project directory needed.
// Run: node test/plan-import.test.js
'use strict';
const assert = require('assert');
const path = require('path');
const { readPlanFiles, reviewPlan, archivePlanFiles } = require('../plan-import');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
async function checkAsync(label, promise, expected) { check(label, await promise, expected); }

/** A minimal fs.promises stand-in over a flat { 'abs/path': 'content' } map, `dirs`: which
 *  paths are directories (readdir lists their immediate children). */
function fakeFs(files) {
  const dirs = new Map(); // dirPath -> Set(childName)
  for (const p of Object.keys(files)) {
    let d = path.dirname(p);
    let child = path.basename(p);
    while (true) {
      if (!dirs.has(d)) dirs.set(d, new Set());
      dirs.get(d).add(child);
      const parent = path.dirname(d);
      if (parent === d) break;
      child = path.basename(d); d = parent;
    }
  }
  const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  return {
    files, dirs,
    promises: {
      async readFile(p) { if (!(p in files)) throw enoent(p); return files[p]; },
      async readdir(p) { if (!dirs.has(p)) throw enoent(p); return [...dirs.get(p)]; },
      async mkdir(p) { let d = p; while (!dirs.has(d)) { dirs.set(d, new Set()); const parent = path.dirname(d); if (parent === d) break; dirs.get(parent).add(path.basename(d)); d = parent; } },
      async writeFile(p, content) { files[p] = content; const d = path.dirname(p); if (!dirs.has(d)) dirs.set(d, new Set()); dirs.get(d).add(path.basename(p)); },
      async unlink(p) { if (!(p in files)) throw enoent(p); delete files[p]; },
    },
  };
}

const T1 = `---
id: T-001
title: Init
bot: kolya-prohramist
depends_on: []
covers: [1. Цель]
---
## Критерии приёмки
x
## Проверка
y
`;
const T2 = `---
id: T-002
title: Tests
bot: taras-qa
depends_on: [T-001]
covers: [2. Хранение]
---
## Критерии приёмки
x
## Проверка
y
`;

console.log('readPlanFiles:');
(async () => {
  {
    const fs = fakeFs({ '/wd/plan/tasks/T-001.md': T1, '/wd/plan/tasks/T-002.md': T2, '/wd/plan/00-overview.md': 'overview text', '/wd/TZ-project.md': '## 1. Цель\ntext\n## 2. Хранение\ntext' });
    const r = await readPlanFiles({ workdir: '/wd', fsImpl: fs });
    check('finds both task files, parsed', [r.hasPlanDir, r.tasks.map(t => t.id), r.parseErrors], [true, ['T-001', 'T-002'], []]);
    check('reads the overview', r.overview, 'overview text');
    check('guesses the ТЗ file from the root, by name', r.tzPath, 'TZ-project.md');
    check('...and extracts its headings for coverage', r.tzHeadings, ['1. Цель', '2. Хранение']);
  }
  {
    const fs = fakeFs({ '/wd/README.md': 'x' }); // no plan/ at all
    await checkAsync('no plan/ directory: reported, not thrown', readPlanFiles({ workdir: '/wd', fsImpl: fs }),
      { hasPlanDir: false, tasks: [], parseErrors: [], overview: null, tzPath: null, tzHeadings: null });
  }
  {
    const fs = fakeFs({ '/wd/plan/tasks/T-001.md': T1, '/wd/plan/tasks/broken.md': 'no front matter' });
    const r = await readPlanFiles({ workdir: '/wd', fsImpl: fs });
    check('a malformed file is a parse error, the good one still parses', [r.tasks.map(t => t.id), r.parseErrors.length], [['T-001'], 1]);
  }
  {
    const fs = fakeFs({ '/wd/plan/tasks/T-001.md': T1 }); // no root .md file at all
    const r = await readPlanFiles({ workdir: '/wd', fsImpl: fs });
    check('no ТЗ-looking file: no crash, coverage simply unavailable', [r.tzPath, r.tzHeadings], [null, null]);
  }
  {
    const fs = fakeFs({ '/wd/plan/tasks/T-001.md': T1, '/wd/spec.md': 'x', '/wd/other.md': 'y' });
    check('an unrelated .md file is not mistaken for the ТЗ', (await readPlanFiles({ workdir: '/wd', fsImpl: fs })).tzPath, null);
  }
  {
    // a read error on the tasks dir that is NOT "missing" (e.g. permissions) is surfaced, not swallowed
    const fs = { promises: { readdir: async () => { throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }); }, readFile: async () => { throw new Error('n/a'); } } };
    const r = await readPlanFiles({ workdir: '/wd', fsImpl: fs });
    check('a real read failure is reported as a parse error, plan/ is not silently "absent"', [r.hasPlanDir, r.parseErrors.length > 0], [false, true]);
  }

  console.log('reviewPlan:');
  {
    const fs = fakeFs({ '/wd/plan/tasks/T-001.md': T1, '/wd/plan/tasks/T-002.md': T2, '/wd/TZ.md': '## 1. Цель\nx\n## 2. Хранение\nx\n## 3. Безопасность\nx' });
    const bots = ['kolya-prohramist', 'taras-qa', 'planner'];
    const r = await reviewPlan({ workdir: '/wd', botIds: bots, fsImpl: fs });
    check('two clean tasks, no errors, can approve', [r.tasks.length, r.errors, r.canApprove], [2, [], true]);
    check('a task carries its per-task errors/warnings (empty here) and existingTaskId', r.tasks[0].errors, []);
    check('no card is pre-marked as already imported when `existing` is empty', r.tasks.every(t => t.existingTaskId === null), true);
    check('coverage: 2 of 3 ТЗ sections, one uncovered', r.coverage, { total: 3, covered: 2, uncovered: ['3. Безопасность'] });
    check('uncovered section is also a plan-level warning', r.warnings.some(w => w.includes('3. Безопасность')), true);
    check('a card description is capped and matches the body when short', [r.tasks[0].description.length <= 2000, r.tasks[0].description], [true, r.tasks[0].context]);
  }
  {
    const fs = fakeFs({});
    const r = await reviewPlan({ workdir: '/wd', botIds: ['x'], fsImpl: fs });
    check('no plan/ at all: cannot approve, no tasks, no crash', [r.hasPlanDir, r.tasks, r.canApprove], [false, [], false]);
  }
  {
    const fs = fakeFs({ '/wd/plan/tasks/T-001.md': T1.replace('bot: kolya-prohramist', 'bot: nobody') });
    const r = await reviewPlan({ workdir: '/wd', botIds: ['kolya-prohramist'], fsImpl: fs });
    check('an unknown bot blocks approval and is named on the task', [r.canApprove, r.tasks[0].errors], [false, ['unknown bot "nobody"']]);
  }
  {
    const fs = fakeFs({ '/wd/plan/tasks/T-001.md': T1, '/wd/plan/tasks/T-002.md': T2 });
    const r = await reviewPlan({ workdir: '/wd', botIds: ['kolya-prohramist', 'taras-qa'], existing: { 'T-001': 'kanban-abc' }, fsImpl: fs });
    check('a task already imported once carries the kanban id it maps to', [r.tasks.find(t => t.id === 'T-001').existingTaskId, r.tasks.find(t => t.id === 'T-002').existingTaskId], ['kanban-abc', null]);
  }
  {
    const fs = fakeFs({ '/wd/plan/tasks/T-001.md': T1 });
    const r = await reviewPlan({ workdir: '/wd', botIds: ['kolya-prohramist'], fsImpl: fs });
    check('overview.md missing is fine', r.overview, null);
    check('generatedAt is a real timestamp', typeof r.generatedAt === 'string' && !Number.isNaN(Date.parse(r.generatedAt)), true);
  }
  {
    const long = T1.replace('## Критерии приёмки\nx\n## Проверка\ny\n', '## Критерии приёмки\n' + 'x'.repeat(2500));
    const fs = fakeFs({ '/wd/plan/tasks/T-001.md': long });
    const r = await reviewPlan({ workdir: '/wd', botIds: ['kolya-prohramist'], fsImpl: fs });
    check('a long task body is capped for the card description, the full text stays in context', [r.tasks[0].description.length <= 2000, r.tasks[0].context.length > 2000], [true, true]);
  }


console.log('archivePlanFiles:');
  {
    const fs = fakeFs({ '/wd/plan/tasks/T-001.md': T1, '/wd/plan/tasks/T-002.md': T2 });
    const r = await archivePlanFiles({ workdir: '/wd', entries: [{ file: 'plan/tasks/T-001.md', taskId: 'T-001', cardId: 'card-1' }], fsImpl: fs });
    check('the file moved, none left behind', [r.moved, r.errors, '/wd/plan/tasks/T-001.md' in fs.files, '/wd/plan/imported/T-001.md' in fs.files], [['T-001'], [], false, true]);
    check('the moved file is stamped', fs.files['/wd/plan/imported/T-001.md'].includes('imported_card: card-1'), true);
    check('T-002 was never touched', '/wd/plan/tasks/T-002.md' in fs.files, true);
  }
  {
    const fs = fakeFs({ '/wd/plan/tasks/T-001.md': T1 });
    const r = await archivePlanFiles({ workdir: '/wd', entries: [{ file: 'plan/tasks/T-001.md', taskId: 'T-001', cardId: 'card-1' }, { file: 'plan/tasks/GONE.md', taskId: 'T-999', cardId: 'card-2' }], fsImpl: fs });
    check('one missing file is reported by id, the other still archives', [r.moved, r.errors.map(e => e.taskId)], [['T-001'], ['T-999']]);
  }
  {
    const r = await archivePlanFiles({ workdir: '/wd', entries: [], fsImpl: fakeFs({}) });
    check('nothing to archive: no crash, empty result', r, { moved: [], errors: [] });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
