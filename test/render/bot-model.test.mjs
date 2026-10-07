import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { loadFn } from './_load.mjs';

// A bot can pin its own model (e.g. the planner on the Claude subscription while the chat is on an API
// provider). There is no engine field: the model's PROVIDER decides the engine (server.js runEngineFor),
// so the editor shows ONE button that opens the toolbar's own model picker, with "same as chat" on top,
// and every provider in that list is marked "subscription" or "API".
const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');

const seg = (id) => {
  const m = new RegExp(`<div class="bot-seg" id="${id}"[^>]*>([\\s\\S]*?)</div>`).exec(html);
  assert.ok(m, `${id} exists`);
  return m[1];
};
const values = (block) => [...block.matchAll(/data-v="([^"]*)"/g)].map(m => m[1]);

// ── markup
assert.ok(!/id="botEngineSeg"|id="botEngine"/.test(html), 'no engine field any more: the model decides it');
assert.ok(!/id="botModelSeg"|id="botModelGw"/.test(html), 'no alias chips and no second select: one button, one list');
assert.ok(/<button type="button" class="bot-mdl-btn" id="botModelBtn" onclick="openBotModelPicker\(this\)" aria-haspopup="dialog"><\/button>/.test(html), 'one button opens the picker');
assert.ok(/<input type="hidden" id="botModel">/.test(html), 'the chosen value lives in a hidden input');
// syncBtn() toggles EVERY `.tb-group .tb-btn` with a matching data-v; reusing those classes would fight the chat toolbar
assert.ok(!/class="[^"]*\btb-btn\b[^"]*" id="botModelBtn"/.test(html), 'the editor must not use the toolbar classes');
assert.ok(!/id="botTemplates"|BOT_TEMPLATES|applyBotTemplate/.test(html), 'no starter-prompt templates: they overwrote the bot\'s own prompt');

// ── file access in a discussion
assert.deepStrictEqual(values(seg('botRoomToolsSeg')), ['', 'read', 'run', 'work'], 'default, read, read + run, read + write');
assert.ok(/<button type="button" class="bot-seg-btn on" data-v=""/.test(seg('botRoomToolsSeg')), 'the default starts selected');
assert.ok(!/tb-group|tb-btn/.test(seg('botRoomToolsSeg')), 'own classes again');
assert.ok(/<input type="hidden" id="botRoomTools">/.test(html), 'a hidden input carries the value');
assert.ok(/\$i\('botRoomTools'\)\.value = bot\?\.room_tools \|\| '';\s*renderBotRoomTools\(\);/.test(html), 'the form loads it');
assert.ok(/roomTools: \$i\('botRoomTools'\)\.value \|\| null,/.test(html), 'saveBot sends it');
{
  const chips = ['', 'read', 'run', 'work'].map(v => { const c = { dataset: { v }, on: false }; c.classList = { toggle: (_, f) => { c.on = !!f; } }; return c; });
  const hid = { value: '' };
  Object.assign(globalThis, { $i: (id) => (id === 'botRoomTools' ? hid : null), document: { querySelectorAll: () => chips } });
  const renderBotRoomTools = loadFn('renderBotRoomTools'); globalThis.renderBotRoomTools = renderBotRoomTools;
  const setBotRoomTools = loadFn('setBotRoomTools');
  const lit = () => chips.filter(c => c.on).map(c => c.dataset.v);
  setBotRoomTools('read'); assert.deepStrictEqual([hid.value, lit()], ['read', ['read']]);
  setBotRoomTools('work'); assert.deepStrictEqual([hid.value, lit()], ['work', ['work']]);
  setBotRoomTools(''); assert.deepStrictEqual([hid.value, lit()], ['', ['']], 'back to the default');
  for (const k of ['$i', 'document', 'renderBotRoomTools']) delete globalThis[k];
}
const has = (k) => (html.match(new RegExp(`['"]${k.replace(/\./g, '\\.')}['"]:`, 'g')) || []).length;
for (const k of ['bot.modal.tools.label', 'bot.tools.default', 'bot.tools.read', 'bot.tools.run', 'bot.tools.work', 'bot.modal.tools.hint']) assert.strictEqual(has(k), 5, `${k} in all five languages`);

// ── wiring
assert.ok(/renderBotModel\(bot\?\.model \|\| ''\);/.test(html), 'the form loads the stored model');
assert.ok(/model: \$i\('botModel'\)\.value \|\| null,\n\s*roomTools:/.test(html), 'saveBot sends the model and no engine; empty means "as the chat"');
assert.ok(/openModelPicker\(anchor, \{ current: \(\$i\('botModel'\) \|\| \{\}\)\.value \|\| '', inherit: true, onPick: setBotModel \}\)/.test(html), 'the button borrows the toolbar\'s picker, with "same as chat"');
assert.ok(/bot\.model \? `<span class="bh-model">\$\{escH\(botModelText\(bot\.model\)\)\}<\/span>`/.test(html), 'a bot\'s message header names its model the way the picker does');

// ── strings, all five languages
for (const k of ['bot.modal.model.label', 'bot.model.inherit', 'bot.modal.model.hint', 'prov.mode.subscription', 'prov.mode.api', 'prov.mode.subscription.tip', 'prov.mode.api.tip'])
  assert.strictEqual(has(k), 5, `${k} is defined in all five languages`);
for (const k of ['bot.modal.engine.label', 'bot.engine.inherit', 'bot.engine.api', 'bot.engine.subscription', 'bot.modal.engine.hint', 'bot.model.gateway.ph', 'bot.model.no_tools', 'bot.tpl.analyst.name'])
  assert.strictEqual(has(k), 0, `no leftover ${k}`);

// ── behaviour on a minimal fake DOM
const CHOICES = { defaultProviderId: 'kilo', providers: [
  { id: 'kilo', label: 'kilo', type: 'anthropic-compatible', isDefault: true, models: [
    { ref: 'kilo::sonnet', id: 'sonnet', alias: true }, { ref: 'kilo::gpt-x', id: 'gpt-x', label: 'GPT X', caps: { tools: true } }] },
  { id: 'claude', label: 'Claude', type: 'claude-subscription', builtin: true, isDefault: false, models: [
    { ref: 'claude::opus', id: 'opus', alias: true }] },
] };
const T = { 'bot.model.inherit': 'Same as chat', 'prov.builtin.claude': 'Claude (CLI login)', 'prov.mode.subscription': 'subscription', 'prov.mode.api': 'API', 'prov.default': 'default' };
const btn = { innerHTML: '', title: '', classList: { v: new Set(), toggle(c, f) { f ? this.v.add(c) : this.v.delete(c); } } };
const hid = { value: '', isConnected: true };
Object.assign(globalThis, {
  $i: (id) => ({ botModel: hid, botModelBtn: btn })[id], t: (k) => T[k] || k, _modelChoices: CHOICES,
  _MODEL_ALIASES: ['haiku', 'sonnet', 'opus', 'fable'], _MODEL_ALIAS_LABEL: { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' },
});
for (const n of ['escH', 'modelInfo', 'provModeOf', 'provModeBadge', 'botModelText', 'renderBotModel']) globalThis[n] = loadFn(n);
const setBotModel = loadFn('setBotModel');
const shown = () => btn.innerHTML.replace(/<[^>]+>/g, '|').split('|').filter(Boolean);

renderBotModel('');
assert.deepStrictEqual([shown(), btn.classList.v.has('inherit')], [['Same as chat', '▾'], true], 'nothing pinned: the button says "same as chat"');
setBotModel('claude::opus');
assert.deepStrictEqual([hid.value, shown(), btn.classList.v.has('inherit')], ['claude::opus', ['Opus', 'Claude (CLI login)', 'subscription', '▾'], false],
  'a model of the CLI login names its provider and says "subscription"');
assert.ok(/class="prov-mode subscription"/.test(btn.innerHTML), 'the mark is the shared prov-mode badge');
setBotModel('kilo::gpt-x');
assert.deepStrictEqual(shown(), ['GPT X', 'kilo', 'API', '▾'], 'a model of an API provider says "API"');
setBotModel('sonnet');
assert.deepStrictEqual(shown(), ['Sonnet', 'kilo', 'API', '▾'], 'a bare alias is the default provider\'s');
assert.deepStrictEqual([botModelText('claude::opus'), botModelText('sonnet')], ['Claude (CLI login) · Opus', 'Sonnet'], 'the message header names another provider, not the default one');

// ── the picker a field borrows: "same as chat" on top, the pick goes to the field
{
  const rows = [];
  const mkEl = () => { const e = { className: '', innerHTML: '', dataset: {}, title: '', setAttribute() {}, listeners: {}, addEventListener(n, f) { this.listeners[n] = f; } }; return e; };
  const list = { innerHTML: '', appendChild: (e) => { rows.push(e); return e; } };
  let picked = null, closed = 0;
  Object.assign(globalThis, {
    document: { createElement: mkEl }, curModel: 'kilo::gpt-x', _mdlPickKb: -1, _mdlPickRefs: [],
    _mdlPickOpts: { current: 'claude::opus', inherit: true, onPick: (v) => { picked = v; } },
    modelCapsText: () => '', closeModelPicker: () => { closed++; globalThis._mdlPickOpts = null; },
  });
  globalThis.$i = (id) => ({ mdlPickList: list, mdlPickInp: { value: '' } })[id];
  const renderModelPicker = loadFn('renderModelPicker'), pickModel = loadFn('pickModel');
  renderModelPicker();
  const text = (e) => e.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.strictEqual(text(rows[0]), 'Same as chat', '"same as chat" is the first entry');
  assert.deepStrictEqual(globalThis._mdlPickRefs, ['', 'sonnet', 'kilo::gpt-x', 'claude::opus'], 'then the default provider (its aliases bare), then the others as refs');
  const groups = rows.filter(r => r.className === 'mdl-pick-grp').map(text);
  assert.deepStrictEqual(groups, ['kilo API default', 'Claude (CLI login) subscription'], 'every provider is marked subscription or API');
  const on = rows.filter(r => /\bon\b/.test(r.className)).map(text);
  assert.deepStrictEqual(on, ['Opus'], 'the FIELD\'s value is lit, not the chat\'s');
  pickModel('');
  assert.deepStrictEqual([picked, closed, globalThis.curModel], ['', 1, 'kilo::gpt-x'], '"same as chat" reaches the field and leaves the chat\'s model alone');
  for (const k of ['document', 'curModel', '_mdlPickKb', '_mdlPickRefs', '_mdlPickOpts', 'modelCapsText', 'closeModelPicker']) delete globalThis[k];
}

for (const k of ['$i', 't', '_modelChoices', '_MODEL_ALIASES', '_MODEL_ALIAS_LABEL', 'escH', 'modelInfo', 'provModeOf', 'provModeBadge', 'botModelText', 'renderBotModel']) delete globalThis[k];
console.log('bot-model: ok');
