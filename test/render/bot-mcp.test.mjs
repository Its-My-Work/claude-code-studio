import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { loadFn } from './_load.mjs';

// The bot editor lists the config's MCP servers as checkboxes and saves the ticked ids as the bot's
// `activeMcp`. Before this a bot's MCP list could only be edited through the API, and was never
// read when a bot ran, so a bot only ever had what the whole chat had switched on.
const botMcpChoices = loadFn('botMcpChoices');

const cfg = {
  web: { label: 'Web search', description: 'web_search and web_fetch', builtin: true },
  itsmywork: { description: 'Easypanel', url: 'http://x/mcp' },
  off: { label: 'Disabled one', enabled: false },
  _ccs_notify: { label: 'internal' },
  broken: null,
};
const ids = (a) => a.map(c => c.id);

// every configured server is offered, the built-in `web` one included; internals, disabled and null entries are not
assert.deepStrictEqual(ids(botMcpChoices(cfg, '[]')), ['web', 'itsmywork']);
// the label falls back to the id, the description is carried for the hint under the name
assert.deepStrictEqual(botMcpChoices(cfg, '[]').map(c => [c.label, c.description]), [['Web search', 'web_search and web_fetch'], ['itsmywork', 'Easypanel']]);
// ticked = present in the bot's stored JSON list
assert.deepStrictEqual(botMcpChoices(cfg, '["web"]').map(c => c.checked), [true, false]);
assert.deepStrictEqual(botMcpChoices(cfg, '["web","itsmywork"]').map(c => c.checked), [true, true]);
// an id that no longer exists in the config is simply not shown (and so not saved back)
assert.deepStrictEqual(ids(botMcpChoices(cfg, '["gone","web"]')), ['web', 'itsmywork']);
// stored value missing, empty, corrupt or not a list: nothing is ticked, nothing throws
for (const bad of [undefined, null, '', 'not json', '{"a":1}', '"web"', '5']) {
  assert.deepStrictEqual(botMcpChoices(cfg, bad).map(c => c.checked), [false, false], `stored ${JSON.stringify(bad)}`);
}
// no servers at all
assert.deepStrictEqual(botMcpChoices({}, '[]'), []);
assert.deepStrictEqual(botMcpChoices(undefined, '[]'), []);

// wiring: the editor loads it, saves it, and has the markup
const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
assert.ok(/renderBotMcp\(bot\?\.active_mcp\)/.test(html), 'openBotForm renders the list from the bot');
assert.ok(/activeMcp: \[\.\.\.document\.querySelectorAll\('#botMcpList input:checked'\)\]\.map\(i => i\.value\)/.test(html), 'saveBot sends the ticked ids');
assert.ok(/id="botMcpList"/.test(html), 'the list container exists');

console.log('bot-mcp: ok');
