import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFn, loadConst } from './_load.mjs';

// Every section of the left panel starts collapsed. A choice the user made is still saved and
// restored; a section with no saved choice (fresh browser, state saved before the section
// existed) keeps the collapsed default.

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../public/index.html'), 'utf8');

// ── markup: every .sec-body ships collapsed, and its title says so ──────────────────────────
const bodies = [...HTML.matchAll(/<div class="sec-body([^"]*)" id="(\w+Body)">/g)].map(m => ({ cls: m[1], id: m[2] }));
assert.ok(bodies.length >= 11, `expected the left-panel sections, found ${bodies.length}`);
for (const { cls, id } of bodies) {
  assert.ok(/\bcollapsed\b/.test(cls), `${id} must start collapsed in the markup`);
  const key = id.replace(/Body$/, '');
  const title = HTML.match(new RegExp(`<div class="sec-title"[^>]*aria-expanded="(true|false)"[^>]*onclick="toggleSec\\('${key}'\\)"`));
  assert.ok(title, `${id}: title with toggleSec('${key}') not found`);
  assert.strictEqual(title[1], 'false', `${id}: aria-expanded must match the collapsed default`);
}

// ── the shared map covers exactly those bodies (a new section can't be forgotten) ───────────
globalThis.$i = () => null;
const SIDEBAR_SECTIONS = loadConst('SIDEBAR_SECTIONS');
assert.deepStrictEqual(
  Object.values(SIDEBAR_SECTIONS).sort(),
  bodies.map(b => b.id).sort(),
  'SIDEBAR_SECTIONS must list every .sec-body in the left panel');
for (const k of ['activity', 'bots']) assert.ok(k in SIDEBAR_SECTIONS, `${k} is saved too`);
assert.ok(/sections: sidebarSectionsState\(\)/.test(HTML), 'saveUIState must persist via sidebarSectionsState()');
assert.ok(/applySidebarSections\(s\.sections\)/.test(HTML), 'restoreUIState must restore via applySidebarSections()');

// ── behaviour, on a tiny fake DOM ────────────────────────────────────────────────────────────
function fakeDom() {
  const els = {};
  for (const id of Object.values(SIDEBAR_SECTIONS)) {
    const cls = new Set(['sec-body', 'collapsed']);          // as shipped
    const title = { attrs: { 'aria-expanded': 'false' }, setAttribute(k, v) { this.attrs[k] = v; } };
    els[id] = {
      previousElementSibling: title,
      classList: {
        contains: c => cls.has(c),
        toggle(c, force) { const on = force === undefined ? !cls.has(c) : !!force; on ? cls.add(c) : cls.delete(c); return on; },
      },
    };
  }
  globalThis.$i = id => els[id] || null;
  return els;
}
globalThis.SIDEBAR_SECTIONS = SIDEBAR_SECTIONS;
const sidebarSectionsState = loadFn('sidebarSectionsState');
const applySidebarSections = loadFn('applySidebarSections');
const collapsedOf = els => Object.fromEntries(Object.entries(SIDEBAR_SECTIONS).map(([k, id]) => [k, els[id].classList.contains('collapsed')]));

{ // no saved state at all: nothing changes, everything stays collapsed
  const els = fakeDom();
  applySidebarSections(undefined);
  applySidebarSections(null);
  applySidebarSections({});
  assert.ok(Object.values(collapsedOf(els)).every(Boolean), 'no saved choice -> all collapsed');
}
{ // saved choices win, only for the sections they name
  const els = fakeDom();
  applySidebarSections({ mcp: false, hist: false, skills: true });
  const c = collapsedOf(els);
  assert.strictEqual(c.mcp, false); assert.strictEqual(c.hist, false);
  assert.strictEqual(c.skills, true);
  assert.strictEqual(c.proj, true, 'a section not in the saved state keeps the default');
  assert.strictEqual(els.mcpBody.previousElementSibling.attrs['aria-expanded'], 'true', 'aria follows the restored state');
  assert.strictEqual(els.skillsBody.previousElementSibling.attrs['aria-expanded'], 'false');
}
{ // state saved by an older version (no activity / bots keys) leaves those at the default
  const els = fakeDom();
  applySidebarSections({ hist: false, mcp: true, skills: true, cmds: true, agents: true, proj: false, sshHosts: true, tunnel: true, tg: true });
  const c = collapsedOf(els);
  assert.strictEqual(c.activity, true); assert.strictEqual(c.bots, true);
  assert.strictEqual(c.hist, false); assert.strictEqual(c.proj, false);
}
{ // junk in localStorage must not throw or expand anything
  const els = fakeDom();
  applySidebarSections({ mcp: 'yes', hist: 1, proj: null });
  applySidebarSections('nope');
  assert.ok(Object.values(collapsedOf(els)).every(Boolean), 'non-boolean values are ignored');
}
{ // save -> restore round-trips what the user did
  const els = fakeDom();
  els.projBody.classList.toggle('collapsed', false);
  els.botsBody.classList.toggle('collapsed', false);
  const saved = JSON.parse(JSON.stringify(sidebarSectionsState()));
  assert.strictEqual(saved.proj, false); assert.strictEqual(saved.bots, false); assert.strictEqual(saved.mcp, true);
  const fresh = fakeDom();
  applySidebarSections(saved);
  assert.deepStrictEqual(collapsedOf(fresh), saved);
}

// ── the filter button on a collapsed title must open the section it filters ─────────────────
{
  const els = fakeDom();
  const calls = [];
  const filterRow = { style: { display: 'none' } };
  const inp = { value: 'x', focus() { calls.push('focus'); } };
  const btn = { classList: { add() {}, remove() {} } };
  const base = globalThis.$i;
  globalThis.$i = id => ({ projFilterRow: filterRow, projFilterBtn: btn, projFilterInp: inp }[id]) || base(id);
  globalThis.toggleSec = id => { calls.push('toggleSec:' + id); els[id + 'Body'].classList.toggle('collapsed'); };
  globalThis.expandSec = loadFn('expandSec');
  const toggleSecFilter = loadFn('toggleSecFilter');

  toggleSecFilter('proj');
  assert.deepStrictEqual(calls, ['toggleSec:proj', 'focus'], 'expands first, then focuses the input');
  assert.strictEqual(els.projBody.classList.contains('collapsed'), false);
  assert.strictEqual(filterRow.style.display, 'flex');

  calls.length = 0; els.hist = undefined;
  globalThis.expandSec('proj');                                // already open -> no toggle back
  assert.deepStrictEqual(calls, [], 'an open section is left alone');
}

console.log('sidebar-sections: ok');
