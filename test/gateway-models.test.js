// Pure-logic verification for gateway-models.js. Run: node test/gateway-models.test.js
const assert = require('assert');
const { MODEL_ID_RE, parseModels, createCatalog } = require('../gateway-models');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

console.log('model ids:');
check('a gateway id is valid', MODEL_ID_RE.test('poolside/laguna-s-2.1:free'), true);
check('a Claude alias is valid', MODEL_ID_RE.test('sonnet'), true);
check('spaces, quotes and shell characters are not', ['a b', 'x;rm', 'a"b', '$(id)', '', 'x'.repeat(101)].map(v => MODEL_ID_RE.test(v)), [false, false, false, false, false, false]);

console.log('parsing:');
const raw = { data: [
  { id: 'a/notools:free', name: 'No tools', context_length: 32768, supported_parameters: ['reasoning'], isFree: true },
  { id: 'b/good:free', name: 'Good', context_length: 262144, supported_parameters: ['tools', 'reasoning'], isFree: true },
  { id: 'c/unknown', supported_parameters: null },
  { id: 'b/good:free', name: 'duplicate' },
  { id: 'bad id' }, { name: 'no id' }, null,
] };
const list = parseModels(raw);
check('duplicates and malformed ids are dropped', list.map(m => m.id), ['b/good:free', 'c/unknown', 'a/notools:free']);
check('a model that says it has no tools goes last, the rest keep the gateway order', list.map(m => m.tools), [true, null, false]);
check('fields are normalised', list[0], { id: 'b/good:free', name: 'Good', context: 262144, tools: true, free: true });
check('a missing name falls back to the id, unknown flags stay unknown', list[1], { id: 'c/unknown', name: 'c/unknown', context: null, tools: null, free: false });
check('a bare array is accepted', parseModels([{ id: 'x/y' }]).map(m => m.id), ['x/y']);
check('garbage gives an empty list', [parseModels(null), parseModels({}), parseModels('x'), parseModels({ data: 5 })], [[], [], [], []]);

console.log('catalogue:');
const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });
(async () => {
  {
    let calls = 0, seen = null, t = 1000;
    const cat = createCatalog({ baseUrl: 'https://gw.example/', token: 'secret', now: () => t, ttlMs: 5000,
      fetchImpl: async (url, o) => { calls++; seen = { url, h: o.headers }; return { ok: true, status: 200, json: async () => raw }; } });
    const a = await cat.get();
    check('it reads <base>/v1/models with the server token', [seen.url, seen.h.authorization, seen.h['x-api-key']], ['https://gw.example/v1/models', 'Bearer secret', 'secret']);
    check('the answer carries only ids and labels, never the token', JSON.stringify(a).includes('secret'), false);
    await cat.get(); check('a second read inside the TTL is served from the cache', calls, 1);
    t += 6000; await cat.get(); check('after the TTL it asks again', calls, 2);
    const both = await Promise.all([(t += 6000, cat.get()), cat.get()]);
    check('concurrent readers share one request', [calls, both[0].models.length === both[1].models.length], [3, true]);
  }
  {
    let t = 0, fail1 = false;
    const cat = createCatalog({ baseUrl: 'https://gw.example', token: 't', now: () => t, ttlMs: 10,
      fetchImpl: async () => { if (fail1) throw new Error('boom'); return { ok: true, status: 200, json: async () => raw }; } });
    await cat.get(); t = 100; fail1 = true;
    const s = await cat.get();
    check('a failed refresh answers the last good list, marked stale', [s.models.length, s.stale, s.error], [3, true, 'boom']);
  }
  {
    const cat = createCatalog({ baseUrl: 'https://gw.example', token: 't', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
    check('a refusal with nothing cached is an empty list plus the reason', await cat.get(), { models: [], error: 'HTTP 401' });
  }
  check('no gateway configured is an empty list, not a request', await createCatalog({ fetchImpl: () => { throw new Error('must not be called'); } }).get(), { models: [], error: 'no-gateway' });
  {
    const cat = createCatalog({ baseUrl: 'https://gw.example', token: 't', timeoutMs: 20, fetchImpl: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
    check('a hung gateway times out instead of hanging the editor', await cat.get(), { models: [], error: 'timeout' });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
