import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { loadFn } from './_load.mjs';

// A bot can pin its own engine (e.g. the planner on the Claude subscription while the chat is on the
// API). The editor is a plain <select>, so the checks are wiring checks: the markup offers exactly
// "as the chat / API / subscription", the editor loads the stored value, and saving sends it.
const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');

const sel = /<select id="botEngine"[^>]*>([\s\S]*?)<\/select>/.exec(html);
assert.ok(sel, 'the engine select exists');
assert.deepStrictEqual([...sel[1].matchAll(/<option value="([^"]*)"/g)].map(m => m[1]), ['', 'api', 'subscription'], '"as the chat" (empty) is the first and default option');
assert.ok(/id="botEngine"/.test(html) && /for="botEngine"/.test(html), 'the label points at the select');
assert.ok(/\$i\('botEngine'\)\.value = bot\?\.run_engine \|\| '';/.test(html), 'the form loads the stored engine, empty for "as the chat"');
assert.ok(/runEngine: \$i\('botEngine'\)\.value \|\| null,/.test(html), 'saveBot sends the choice; empty means "as the chat"');
assert.ok(/bot\.run_engine === 'subscription'/.test(html), 'a message from a subscription bot says so in its header');

// every language carries the new strings (the completeness test only checks keys that exist in English)
const KEYS = ['bot.modal.engine.label', 'bot.engine.inherit', 'bot.engine.api', 'bot.engine.subscription', 'bot.modal.engine.hint'];
for (const k of KEYS) {
  const n = (html.match(new RegExp(`['"]${k.replace(/\./g, '\\.')}['"]:`, 'g')) || []).length;
  assert.strictEqual(n, 5, `${k} is defined in all five languages (found ${n})`);
}
// the model picker: Claude aliases always, gateway models only where they can run (API / as-chat)
const botModelChoices = loadFn('botModelChoices');
const catalogue = [{ id: 'poolside/laguna-s-2.1:free', name: 'Laguna', tools: true }, { id: 'z-ai/glm-5.2:free', name: 'GLM', tools: false }, { id: 'sonnet', name: 'dup of an alias' }];
const idsOf = (c) => c.gateway.map(g => g.id);
assert.deepStrictEqual(botModelChoices(catalogue, '', '').claude, ['haiku', 'sonnet', 'opus', 'fable']);
assert.deepStrictEqual(idsOf(botModelChoices(catalogue, '', '')), ['poolside/laguna-s-2.1:free', 'z-ai/glm-5.2:free'], 'as-chat and API offer the gateway models; an alias is not listed twice');
assert.deepStrictEqual(idsOf(botModelChoices(catalogue, 'api', '')), ['poolside/laguna-s-2.1:free', 'z-ai/glm-5.2:free']);
assert.deepStrictEqual(botModelChoices(catalogue, 'subscription', ''), { claude: ['haiku', 'sonnet', 'opus', 'fable'], gateway: [], extra: null }, 'the subscription offers Claude models only');
assert.deepStrictEqual(botModelChoices(catalogue, 'api', '').gateway.map(g => g.tools), [true, false], 'a model without tools is flagged');
assert.strictEqual(botModelChoices(catalogue, 'api', 'opus').extra, null, 'an alias in use is not an extra');
assert.strictEqual(botModelChoices(catalogue, 'api', 'poolside/laguna-s-2.1:free').extra, null, 'a listed gateway model is not an extra');
assert.strictEqual(botModelChoices(catalogue, 'api', 'old/model:free').extra, 'old/model:free', 'a stored model that is no longer offered stays selectable');
assert.strictEqual(botModelChoices(catalogue, 'subscription', 'poolside/laguna-s-2.1:free').extra, 'poolside/laguna-s-2.1:free', 'switching to the subscription does not silently drop the stored gateway model');
assert.deepStrictEqual(botModelChoices(null, 'api', ''), { claude: ['haiku', 'sonnet', 'opus', 'fable'], gateway: [], extra: null }, 'no catalogue (gateway down): the editor still works with the aliases');
assert.ok(/id="botEngine" onchange="renderBotModel\(\)"/.test(html), 'changing the engine re-renders the model list');
assert.ok(/renderBotModel\(bot\?\.model \|\| ''\)/.test(html), 'opening the editor renders the list for the bot');
for (const k of ['bot.model.group.claude', 'bot.model.group.gateway', 'bot.model.no_tools', 'bot.modal.model.hint']) {
  const n = (html.match(new RegExp(`['"]${k.replace(/\./g, '\\.')}['"]:`, 'g')) || []).length;
  assert.strictEqual(n, 5, `${k} is defined in all five languages (found ${n})`);
}

// renderBotModel on a minimal fake DOM: the structure of the <select>, not the look
{
  const mk = (tag) => ({ tag, children: [], value: '', label: '', attrs: {}, isConnected: true,
    appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; },
    set textContent(v) { if (v === '') this.children = []; else this._t = v; }, get textContent() { return this._t; } });
  const sel = mk('select'), engine = mk('select');
  globalThis.document = { createElement: mk };
  globalThis.$i = (id) => ({ botModel: sel, botEngine: engine })[id];
  globalThis.t = (k) => ({ 'bot.model.inherit': 'Same as chat', 'bot.model.group.claude': 'Claude', 'bot.model.group.gateway': 'Gateway', 'bot.model.no_tools': 'no tools' })[k] || k;
  globalThis._gatewayModels = [{ id: 'poolside/laguna-s-2.1:free', name: 'Laguna', tools: true }, { id: 'z-ai/glm-5.2:free', name: 'GLM', tools: false }];
  globalThis.loadGatewayModels = async () => globalThis._gatewayModels;
  globalThis.botModelChoices = botModelChoices;
  const renderBotModel = loadFn('renderBotModel');
  const shape = () => sel.children.map(c => c.tag === 'optgroup' ? [c.label, c.children.map(o => [o.value, o.textContent])] : [c.value, c.textContent]);

  engine.value = '';
  renderBotModel('');
  assert.deepStrictEqual(shape(), [
    ['', 'Same as chat'],
    ['Claude', [['haiku', 'haiku'], ['sonnet', 'sonnet'], ['opus', 'opus'], ['fable', 'fable']]],
    ['Gateway', [['poolside/laguna-s-2.1:free', 'Laguna'], ['z-ai/glm-5.2:free', 'GLM — no tools']]],
  ], 'as-chat: the inherit option, the Claude group and the gateway group (a model without tools says so)');
  assert.strictEqual(sel.value, '', 'nothing pinned: "as the chat" is selected');

  renderBotModel('poolside/laguna-s-2.1:free');
  assert.strictEqual(sel.value, 'poolside/laguna-s-2.1:free', 'a stored gateway model is selected');

  engine.value = 'subscription';
  renderBotModel();   // what the engine <select> does: no argument, keep the current value
  assert.deepStrictEqual(shape().map(x => x[0]), ['', 'Claude', 'poolside/laguna-s-2.1:free'], 'on the subscription the gateway group is gone, and the stored model stays as an extra');
  assert.strictEqual(sel.value, 'poolside/laguna-s-2.1:free', 'the choice survives the engine switch');

  engine.value = 'api'; renderBotModel('opus');
  assert.strictEqual(sel.value, 'opus', 'an alias is selected on the API engine too');
  for (const k of ['document', '$i', 't', '_gatewayModels', 'loadGatewayModels', 'botModelChoices']) delete globalThis[k];
}
console.log('bot-engine: ok');
