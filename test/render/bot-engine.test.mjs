import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { loadFn } from './_load.mjs';

// A bot can pin its own engine and model (e.g. the planner on the Claude subscription while the chat is on
// the API). The editor shows them like the new-chat bar does: a row of buttons for the model
// (Haiku / Sonnet / Opus / Fable) and one for the engine (API / Subscription), each with "same as chat".
const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');

const seg = (id) => {
  const m = new RegExp(`<div class="bot-seg" id="${id}"[^>]*>([\\s\\S]*?)</div>`).exec(html);
  assert.ok(m, `${id} exists`);
  return m[1];
};
const values = (block) => [...block.matchAll(/data-v="([^"]*)"/g)].map(m => m[1]);

// ── markup
assert.deepStrictEqual(values(seg('botModelSeg')), ['', 'haiku', 'sonnet', 'opus', 'fable'], 'the same four models as the new-chat bar, "same as chat" first');
assert.deepStrictEqual(values(seg('botEngineSeg')), ['', 'api', 'subscription'], '"same as chat", API, subscription');
assert.ok(/<button type="button" class="bot-seg-btn on" data-v=""/.test(seg('botModelSeg')) && /<button type="button" class="bot-seg-btn on" data-v=""/.test(seg('botEngineSeg')), '"same as chat" starts selected');
for (const m of ['haiku', 'sonnet', 'opus', 'fable']) assert.ok(new RegExp(`data-v="${m}"[^>]*data-i18n-tip="model\\.${m}\\.tip"`).test(seg('botModelSeg')), `${m} has the same tooltip as the toolbar`);
assert.ok(/data-i18n-title="engine\.api\.title"/.test(seg('botEngineSeg')) && /data-i18n-title="engine\.sub\.title"/.test(seg('botEngineSeg')), 'the engine buttons carry the toolbar\'s explanations');
// syncBtn() toggles EVERY `.tb-group .tb-btn` with a matching data-v; reusing those classes would fight the chat toolbar
assert.ok(!/tb-group|tb-btn/.test(seg('botModelSeg') + seg('botEngineSeg')), 'the editor must not use the toolbar classes');
assert.ok(html.indexOf('id="botEngineSeg"') < html.indexOf('id="botModelSeg"'), 'the engine comes first: what the model list offers depends on it');
assert.ok(/<input type="hidden" id="botModel">/.test(html) && /<input type="hidden" id="botEngine">/.test(html), 'the chosen values live in hidden inputs');
assert.ok(/<select id="botModelGw"[^>]*hidden>/.test(html), 'the gateway list starts hidden');

// ── wiring
assert.ok(/\$i\('botEngine'\)\.value = bot\?\.run_engine \|\| '';\s*renderBotEngine\(\);\s*renderBotModel\(bot\?\.model \|\| ''\);/.test(html), 'the form loads the stored engine and model');
assert.ok(/model: \$i\('botModel'\)\.value \|\| null,\s*runEngine: \$i\('botEngine'\)\.value \|\| null,/.test(html), 'saveBot sends both; empty means "as the chat"');
assert.ok(/bot\.run_engine === 'subscription'/.test(html), 'a message from a subscription bot says so in its header');

// ── strings, all five languages
const has = (k) => (html.match(new RegExp(`['"]${k.replace(/\./g, '\\.')}['"]:`, 'g')) || []).length;
for (const k of ['bot.modal.engine.label', 'bot.engine.inherit', 'bot.engine.api', 'bot.engine.subscription', 'bot.modal.engine.hint',
  'bot.model.no_tools', 'bot.modal.model.hint', 'bot.model.gateway.ph']) assert.strictEqual(has(k), 5, `${k} is defined in all five languages`);
assert.strictEqual(has('bot.model.group.claude'), 0, 'no leftover strings from the select-based editor');

// ── the gateway list (API only)
const botModelChoices = loadFn('botModelChoices');
const catalogue = [{ id: 'poolside/laguna-s-2.1:free', name: 'Laguna', tools: true }, { id: 'z-ai/glm-5.2:free', name: 'GLM', tools: false }, { id: 'sonnet', name: 'dup of an alias' }];
const idsOf = (c) => c.gateway.map(g => g.id);
assert.deepStrictEqual(botModelChoices(catalogue, '', '').claude, ['haiku', 'sonnet', 'opus', 'fable']);
assert.deepStrictEqual(idsOf(botModelChoices(catalogue, '', '')), ['poolside/laguna-s-2.1:free', 'z-ai/glm-5.2:free'], 'as-chat and API offer the gateway models; an alias is not listed twice');
assert.deepStrictEqual(botModelChoices(catalogue, 'subscription', ''), { claude: ['haiku', 'sonnet', 'opus', 'fable'], gateway: [], extra: null }, 'the subscription offers Claude models only');
assert.deepStrictEqual(botModelChoices(catalogue, 'api', '').gateway.map(g => g.tools), [true, false], 'a model without tools is flagged');
assert.strictEqual(botModelChoices(catalogue, 'api', 'opus').extra, null, 'an alias in use is not an extra');
assert.strictEqual(botModelChoices(catalogue, 'api', 'old/model:free').extra, 'old/model:free', 'a stored model that is no longer offered stays selectable');
assert.deepStrictEqual(botModelChoices(null, 'api', ''), { claude: ['haiku', 'sonnet', 'opus', 'fable'], gateway: [], extra: null }, 'no catalogue (gateway down): the editor still works');

// ── behaviour on a minimal fake DOM
const mk = (tag, dataV) => ({ tag, dataset: { v: dataV }, children: [], value: '', hidden: false, isConnected: true, on: false,
  classList: null, appendChild(c) { this.children.push(c); return c; }, set textContent(v) { if (v === '') this.children = []; else this._t = v; }, get textContent() { return this._t; } });
const chip = (v) => { const c = mk('button', v); c.classList = { toggle: (_, f) => { c.on = !!f; } }; return c; };
const modelChips = ['', 'haiku', 'sonnet', 'opus', 'fable'].map(chip), engineChips = ['', 'api', 'subscription'].map(chip);
const els = { botModel: mk('input'), botEngine: mk('input'), botModelGw: mk('select') };
Object.assign(globalThis, {
  document: { createElement: (t) => mk(t), querySelectorAll: (q) => (q.startsWith('#botModelSeg') ? modelChips : engineChips) },
  $i: (id) => els[id], t: (k) => ({ 'bot.model.gateway.ph': 'Another…', 'bot.model.no_tools': 'no tools' })[k] || k,
  _gatewayModels: [{ id: 'poolside/laguna-s-2.1:free', name: 'Laguna', tools: true }, { id: 'z-ai/glm-5.2:free', name: 'GLM', tools: false }],
  loadGatewayModels: async () => globalThis._gatewayModels, botModelChoices,
});
const renderBotModel = loadFn('renderBotModel'), renderBotEngine = loadFn('renderBotEngine');
Object.assign(globalThis, { renderBotModel, renderBotEngine });
const setBotModel = loadFn('setBotModel'), setBotEngine = loadFn('setBotEngine');
const lit = (chips) => chips.filter(c => c.on).map(c => c.dataset.v);
const gwShape = () => els.botModelGw.children.map(o => [o.value, o.textContent]);

renderBotModel('');
assert.deepStrictEqual(lit(modelChips), [''], 'nothing pinned: "same as chat" is lit');
assert.strictEqual(els.botModelGw.hidden, false, 'as-chat may run on the API, so the gateway list is offered');
assert.deepStrictEqual(gwShape(), [['', 'Another…'], ['poolside/laguna-s-2.1:free', 'Laguna'], ['z-ai/glm-5.2:free', 'GLM — no tools']]);
assert.strictEqual(els.botModelGw.value, '', 'no gateway model selected while a chip (or nothing) is');

setBotModel('opus');
assert.deepStrictEqual([els.botModel.value, lit(modelChips), els.botModelGw.value], ['opus', ['opus'], ''], 'a chip sets the model and lights alone');

setBotModel('poolside/laguna-s-2.1:free');
assert.deepStrictEqual([els.botModel.value, lit(modelChips), els.botModelGw.value], ['poolside/laguna-s-2.1:free', [], 'poolside/laguna-s-2.1:free'], 'a gateway model unlights the chips');

setBotEngine('subscription');
assert.deepStrictEqual([els.botEngine.value, lit(engineChips), els.botModel.value, lit(modelChips), els.botModelGw.hidden], ['subscription', ['subscription'], '', [''], true],
  'switching to the subscription drops a gateway model visibly, back to "same as chat", and hides the gateway list');

setBotModel('fable'); setBotEngine('api');
assert.deepStrictEqual([els.botModel.value, lit(modelChips), lit(engineChips)], ['fable', ['fable'], ['api']], 'an alias survives an engine switch');
els.botModel.value = 'claude-opus-4-8'; setBotEngine('subscription');
assert.strictEqual(els.botModel.value, 'claude-opus-4-8', 'a full Claude id is valid on the subscription and stays');
assert.strictEqual(els.botModelGw.hidden, false, '...and stays visible (in the list) rather than being a hidden choice');
setBotEngine('');
assert.deepStrictEqual(lit(engineChips), [''], '"same as chat" for the engine lights the first button');

for (const k of ['document', '$i', 't', '_gatewayModels', 'loadGatewayModels', 'botModelChoices', 'renderBotModel', 'renderBotEngine']) delete globalThis[k];
console.log('bot-engine: ok');
