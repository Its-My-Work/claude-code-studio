// The LLM bridge's HTTP server against fake upstream providers (Anthropic passthrough and
// OpenAI-compatible translate): auth, byte-identical passthrough + usage tap + credential swap,
// the error mapping table, retry-before-first-byte (and never after), keep-alive pings, client
// abort propagation, per-provider concurrency, count_tokens, /v1/models, /health, usage records.
// Everything on 127.0.0.1 ephemeral ports; the ping interval and retry delay are injected so
// the suite runs in seconds.
//
// Run: node test/llm-bridge-server.test.js
'use strict';
const assert = require('assert');
const http = require('http');
const { createBridgeServer } = require('../llm-bridge/server');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(15); } return false; }

// ------------------------------------------------------------- fake upstream --
function fakeUpstream() {
  const u = { seen: [], handler: null, active: 0, maxActive: 0 };
  u.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = JSON.parse(raw); } catch { /* keep null */ }
      const rec = { method: req.method, url: req.url, headers: req.headers, body, raw, closedEarly: false };
      u.seen.push(rec);
      u.active++; u.maxActive = Math.max(u.maxActive, u.active);
      res.on('close', () => { u.active--; if (!res.writableFinished) rec.closedEarly = true; });
      try { u.handler(req, res, rec, u.seen.length); } catch (e) { res.writeHead(500); res.end(String(e)); }
    });
  });
  u.reset = (h) => { u.seen = []; u.maxActive = 0; u.handler = h; };
  return u;
}
const sse = (res, events, { end = true } = {}) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(typeof e === 'string' ? e : `data: ${JSON.stringify(e)}\n\n`);
  if (end) res.end();
};
const jsonRes = (res, status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
const oaText = (text, usage = { prompt_tokens: 30, completion_tokens: 4 }) => [
  { choices: [{ index: 0, delta: { role: 'assistant', content: text } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage }, 'data: [DONE]\n\n',
];

// ---------------------------------------------------------------- client --
function call(port, { path = '/v1/messages', method = 'POST', headers = {}, body, token = 'tok-openai', auth = 'x-api-key', raw } = {}) {
  return new Promise((resolve, reject) => {
    const h = { 'content-type': 'application/json', ...headers };
    if (token && auth === 'x-api-key') h['x-api-key'] = token;
    if (token && auth === 'bearer') h.authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* sse or empty */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (raw !== undefined) req.end(raw); else if (body !== undefined) req.end(JSON.stringify(body)); else req.end();
  });
}
function events(text) {
  const out = [];
  for (const block of text.split('\n\n')) {
    const ev = /^event: (.*)$/m.exec(block);
    const data = /^data: (.*)$/m.exec(block);
    if (ev && data) out.push([ev[1], JSON.parse(data[1])]);
  }
  return out;
}
const msg = (extra = {}) => ({ model: 'm1', max_tokens: 1000, messages: [{ role: 'user', content: 'hello there' }], ...extra });

(async () => {
  const up = fakeUpstream();
  await new Promise((r) => up.server.listen(0, '127.0.0.1', r));
  const upBase = `http://127.0.0.1:${up.server.address().port}`;
  const deadPort = await new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

  const caps = { tools: true, vision: true, reasoning: true, pdf: false, contextWindow: 65536, maxOutput: 8192 };
  const provider = (over = {}) => ({ id: 'p1', label: 'Acme', type: 'openai-compatible', baseUrl: `${upBase}/v1`, apiKey: 'sk-provider', authScheme: 'bearer', headers: { 'X-Extra': 'yes' }, dialect: 'generic', options: {}, ...over });
  const runs = new Map();
  const ctx = (token, prov, over = {}) => runs.set(token, { token, runId: `run-${token}`, purpose: 'task', sessionId: 's1', taskId: 't1', botId: null, provider: prov, model: 'm1', models: { m1: caps }, modelMap: {}, fallbackModel: 'm1', effort: null, ...over });
  ctx('tok-openai', provider());
  ctx('tok-anthropic', provider({ id: 'anth', type: 'anthropic', baseUrl: upBase, apiKey: 'sk-ant-real', authScheme: 'x-api-key', headers: {} }),
    { model: 'claude-sonnet-5', models: { 'claude-haiku-4-5-20251001': { ...caps, maxOutput: 4096 } }, modelMap: { 'claude-haiku-4-5': 'claude-haiku-4-5-20251001' } });
  ctx('tok-strip', provider({ id: 'anth2', type: 'anthropic-compatible', baseUrl: `${upBase}/anthropic/v1`, apiKey: 'sk-compat', authScheme: 'both', headers: {}, options: { stripBetas: true } }));
  ctx('tok-dead', provider({ id: 'dead', baseUrl: `http://127.0.0.1:${deadPort}/v1` }));
  ctx('tok-idle', provider({ id: 'idle', options: { timeoutMs: 300 } }));
  ctx('tok-one', provider({ id: 'one', options: { maxConcurrency: 1 } }));

  const usage = [];
  const srv = createBridgeServer({ getRun: (t) => runs.get(t) || null, onUsage: (r) => usage.push(r), pingIntervalMs: 100, retryDelayMs: () => 20 });
  const { port } = await srv.listen(0, '127.0.0.1');
  check('listen() resolves the ephemeral port on 127.0.0.1', [port > 0, srv.address().address], [true, '127.0.0.1']);
  check('listen() refuses a non-loopback host', await createBridgeServer({ getRun: () => null }).listen(0, '0.0.0.0').then(() => 'listened', (e) => /non-loopback/.test(e.message)), true);

  console.log('surface:');
  check('/health needs no auth', (await call(port, { path: '/health', method: 'GET', token: null })).json, { ok: true });
  const unk = await call(port, { body: msg(), token: 'nope' });
  check('unknown token -> 401 Anthropic-shaped', [unk.status, unk.json.type, unk.json.error.type], [401, 'error', 'authentication_error']);
  check('no token -> 401', (await call(port, { body: msg(), token: null })).status, 401);
  check('unknown path -> 404 Anthropic-shaped', [(await call(port, { path: '/v1/complete', body: {} })).json.error.type], ['not_found_error']);
  const models = await call(port, { path: '/v1/models', method: 'GET' });
  check('/v1/models lists the run\'s models', models.json, { data: [{ type: 'model', id: 'm1', display_name: 'm1', created_at: '2025-01-01T00:00:00Z' }], has_more: false, first_id: 'm1', last_id: 'm1' });
  check('/v1/models/<id>', (await call(port, { path: '/v1/models/m1', method: 'GET' })).json.id, 'm1');
  up.reset((req, res) => sse(res, oaText('hi')));
  check('Bearer auth and a path prefix + query are accepted', (await call(port, { path: '/some/prefix/v1/messages?beta=true', body: msg(), auth: 'bearer' })).status, 200);
  check('invalid JSON -> 400', (await call(port, { raw: '{nope' })).json.error.type, 'invalid_request_error');
  const badRole = await call(port, { body: msg({ messages: [{ role: 'tool', content: 'x' }] }) });
  check('an untranslatable body -> 400 naming the problem', [badRole.status, /messages\.0\.role/.test(badRole.json.error.message)], [400, true]);
  {
    const small = createBridgeServer({ getRun: (t) => runs.get(t) || null, maxBodyBytes: 1000 });
    const s = await small.listen(0);
    const big = await call(s.port, { body: msg({ messages: [{ role: 'user', content: 'x'.repeat(5000) }] }) });
    check('body over the limit -> 413 request_too_large', [big.status, big.json.error.type], [413, 'request_too_large']);
    await small.close();
  }

  console.log('translate: stream, non-stream, what went upstream:');
  up.reset((req, res) => sse(res, [
    { choices: [{ index: 0, delta: { reasoning_content: 'hmm' } }] },
    { choices: [{ index: 0, delta: { content: 'Hello' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"file_path":"/a"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 600 }, completion_tokens_details: { reasoning_tokens: 9 } } },
    'data: [DONE]\n\n',
  ]));
  usage.length = 0;
  const s1 = await call(port, { body: msg({ stream: true, thinking: { type: 'adaptive' }, tools: [{ name: 'Read', input_schema: { type: 'object' } }] }), headers: { 'x-claude-code-session-id': 'cli-sess-1', 'anthropic-beta': 'x' } });
  const ev = events(s1.text);
  check('stream: 200 text/event-stream', [s1.status, /text\/event-stream/.test(s1.headers['content-type'])], [200, true]);
  check('stream: event sequence', ev.map((e) => e[0] === 'content_block_start' ? `start:${e[1].content_block.type}` : e[0]).filter((n) => n !== 'content_block_delta'),
    ['message_start', 'ping', 'start:thinking', 'content_block_stop', 'start:text', 'content_block_stop', 'start:tool_use', 'content_block_stop', 'message_delta', 'message_stop']);
  check('stream: usage in message_delta', ev.find((e) => e[0] === 'message_delta')[1].usage, { input_tokens: 400, output_tokens: 50, cache_read_input_tokens: 600, cache_creation_input_tokens: 0 });
  const seen = up.seen[0];
  check('upstream URL and credentials (provider key, extra header, never the run token)', [seen.url, seen.headers.authorization, seen.headers['x-extra'], JSON.stringify(seen.headers).includes('tok-openai')], ['/v1/chat/completions', 'Bearer sk-provider', 'yes', false]);
  check('upstream body is OpenAI-shaped and streamed', [seen.body.model, seen.body.stream, seen.body.messages[0], seen.body.max_tokens], ['m1', true, { role: 'user', content: 'hello there' }, 1000]);
  check('anthropic-beta is not forwarded in translate mode', 'anthropic-beta' in seen.headers, false);
  const rec = usage[0];
  check('usage record: every field', {
    ...rec, ts: typeof rec.ts, latencyMs: typeof rec.latencyMs, firstByteMs: typeof rec.firstByteMs,
  }, {
    ts: 'number', runId: 'run-tok-openai', purpose: 'task', sessionId: 's1', taskId: 't1', botId: null, providerId: 'p1', model: 'm1', requestedModel: 'm1',
    inputTokens: 400, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 0, reasoningTokens: 9, latencyMs: 'number', firstByteMs: 'number', stream: true,
    status: 'ok', httpStatus: 200, errorType: null, cliSessionId: 'cli-sess-1',
  });
  const ns = await call(port, { body: msg({ thinking: { type: 'adaptive' } }) });
  check('non-stream client: Anthropic Message JSON from the same stream', [ns.status, ns.json.type, ns.json.content.map((b) => b.type), ns.json.stop_reason], [200, 'message', ['thinking', 'text', 'tool_use'], 'tool_use']);
  up.reset((req, res) => jsonRes(res, 200, { id: 'x', choices: [{ message: { role: 'assistant', content: 'plain json' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
  const js = await call(port, { body: msg({ stream: true }) });
  check('an upstream that answers JSON despite stream:true still translates', events(js.text).filter((e) => e[0] === 'content_block_delta').map((e) => e[1].delta.text), ['plain json']);

  console.log('error mapping (translate):');
  const table = [
    ['context overflow', 400, { error: { code: 'context_length_exceeded', message: "This model's maximum context length is 65536 tokens. However, you requested 70000 tokens." } }, {}, 400, 'invalid_request_error', 'provider "Acme": prompt is too long: 70000 tokens > 65536 maximum'],
    ['401', 401, { error: { message: 'Incorrect API key provided' } }, {}, 401, 'authentication_error', 'provider "Acme": invalid api key (Incorrect API key provided)'],
    ['403', 403, { error: { message: 'region blocked' } }, {}, 403, 'permission_error', 'provider "Acme": region blocked'],
    ['402', 402, { error: { message: 'Payment required' } }, {}, 400, 'invalid_request_error', 'provider "Acme": Your credit balance is too low (insufficient_quota): Payment required'],
    ['insufficient balance', 400, { error: { message: 'Insufficient Balance' } }, {}, 400, 'invalid_request_error', 'provider "Acme": Your credit balance is too low (insufficient_quota): Insufficient Balance'],
    ['404', 404, { error: { message: 'model not found' } }, {}, 404, 'not_found_error', 'provider "Acme": model not found'],
    ['413', 413, { error: { message: 'too big' } }, {}, 413, 'request_too_large', 'provider "Acme": too big'],
    ['429', 429, { error: { message: 'slow down' } }, { 'retry-after': '7' }, 429, 'rate_limit_error', 'provider "Acme": slow down'],
    ['422', 422, { detail: 'bad field' }, {}, 400, 'invalid_request_error', 'provider "Acme": bad field'],
    ['500', 500, { error: { message: 'boom' } }, {}, 500, 'api_error', 'provider "Acme": boom'],
    ['502 (after retries)', 502, { error: { message: 'bad gateway' } }, {}, 502, 'api_error', 'provider "Acme": bad gateway'],
    ['503 (after retries)', 503, { error: { message: 'busy' } }, {}, 529, 'overloaded_error', 'provider "Acme": busy'],
    ['529', 529, { error: { message: 'Overloaded' } }, {}, 529, 'overloaded_error', 'provider "Acme": Overloaded'],
  ];
  for (const [name, st, body, hdrs, wantStatus, wantType, wantMsg] of table) {
    up.reset((req, res) => jsonRes(res, st, body, hdrs));
    const r = await call(port, { body: msg({ stream: true }) });
    check(`${name} -> ${wantStatus} ${wantType}`, [r.status, r.json && r.json.error.type, r.json && r.json.error.message], [wantStatus, wantType, wantMsg]);
    if (st === 429) check('429 keeps retry-after', r.headers['retry-after'], '7');
  }
  up.reset((req, res) => jsonRes(res, 503, { error: { message: 'busy' } }));
  await call(port, { body: msg() });
  check('503 is retried twice before it is reported (3 upstream calls)', up.seen.length, 3);
  up.reset((req, res) => jsonRes(res, 400, { error: { message: 'bad' } }));
  await call(port, { body: msg() });
  check('a 400 is never retried', up.seen.length, 1);
  const dead = await call(port, { body: msg({ stream: true }), token: 'tok-dead' });
  check('transport failure -> 529 overloaded "upstream unreachable"', [dead.status, dead.json.error.type, /provider "Acme": upstream unreachable: ECONNREFUSED/.test(dead.json.error.message)], [529, 'overloaded_error', true]);

  console.log('retries only before the first client byte:');
  up.reset((req, res, rec, n) => (n === 1 ? jsonRes(res, 503, { error: { message: 'warming up' } }) : sse(res, oaText('second try'))));
  const rr = await call(port, { body: msg({ stream: true }) });
  check('503 then 200 -> the client only sees the 200', [rr.status, up.seen.length, events(rr.text).some((e) => e[0] === 'content_block_delta' && e[1].delta.text === 'second try')], [200, 2, true]);
  up.reset((req, res, rec, n) => { if (n === 1) { req.socket.destroy(); return; } sse(res, oaText('after reset')); });
  check('a connection reset before headers is retried', [(await call(port, { body: msg() })).json.content[0].text, up.seen.length], ['after reset', 2]);
  up.reset((req, res) => { sse(res, [{ choices: [{ index: 0, delta: { content: 'partial' } }] }], { end: false }); setTimeout(() => res.socket.destroy(), 50); });
  usage.length = 0;
  const cut = await call(port, { body: msg({ stream: true }) });
  const cutEv = events(cut.text);
  check('a failure after headers is NOT retried', up.seen.length, 1);
  check('…the client gets an error event (block closed, no message_stop)', [cutEv[cutEv.length - 1][0], cutEv[cutEv.length - 1][1].error.type, cutEv.some((e) => e[0] === 'message_stop'), cutEv.filter((e) => e[0] === 'content_block_start').length === cutEv.filter((e) => e[0] === 'content_block_stop').length], ['error', 'overloaded_error', false, true]);
  check('…and the usage record says error', [usage[0].status, usage[0].errorType], ['error', 'overloaded_error']);
  up.reset((req, res) => sse(res, [{ choices: [{ index: 0, delta: { content: 'x' } }] }, { error: { message: 'Overloaded', code: 529 } }]));
  const mid = events((await call(port, { body: msg({ stream: true }) })).text);
  check('a mid-stream {"error"} chunk -> event: error with the mapped type', [mid[mid.length - 1][1].error.type, mid.some((e) => e[0] === 'message_stop')], ['overloaded_error', false]);
  up.reset((req, res) => sse(res, [{ error: { message: 'rate limited', code: 429 } }]));
  const midNs = await call(port, { body: msg() });
  check('…for a non-stream client it is a real HTTP status', [midNs.status, midNs.json.error.type], [429, 'rate_limit_error']);
  up.reset((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); });
  const empty = await call(port, { body: msg() });
  check('an empty 200 -> 529 (retryable), not a blank answer', [empty.status, empty.json.error.type], [529, 'overloaded_error']);

  console.log('keep-alive pings and the idle watchdog:');
  // headers go out at once (as real providers do), then the model "thinks" silently
  up.reset((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); setTimeout(() => { for (const e of oaText('late')) res.write(typeof e === 'string' ? e : `data: ${JSON.stringify(e)}\n\n`); res.end(); }, 700); });
  const pinged = events((await call(port, { body: msg({ stream: true }) })).text);
  const firstDelta = pinged.findIndex((e) => e[0] === 'content_block_start');
  const pings = pinged.slice(0, firstDelta).filter((e) => e[0] === 'ping').length;
  check('a silent upstream gets a ping per interval (1 + ~6 in 700 ms at 100 ms)', pings >= 5, true);
  check('…and the stream still completes', pinged[pinged.length - 1][0], 'message_stop');
  up.reset((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); /* then silence */ });
  const idle = events((await call(port, { body: msg({ stream: true }), token: 'tok-idle' })).text);
  check('idle upstream past options.timeoutMs -> error event naming it', [idle[idle.length - 1][0], /EIDLE/.test(idle[idle.length - 1][1].error.message)], ['error', true]);
  const idleNs = await call(port, { body: msg(), token: 'tok-idle' });
  check('…non-stream: 529', [idleNs.status, idleNs.json.error.type], [529, 'overloaded_error']);
  up.reset(() => { /* never answers, not even headers */ });
  const noHdr = await call(port, { body: msg({ stream: true }), token: 'tok-idle' });
  check('no response headers within timeoutMs -> a real 529 (the CLI retries it)', [noHdr.status, noHdr.json.error.type, /EIDLE/.test(noHdr.json.error.message)], [529, 'overloaded_error', true]);

  console.log('client abort:');
  up.reset((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'x' } }] })}\n\n`); });
  await sleep(50); // let the previous test's never-answered upstream request be torn down
  usage.length = 0;
  await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages', headers: { 'x-api-key': 'tok-openai', 'content-type': 'application/json' } }, (res) => {
      res.once('data', () => { req.destroy(); resolve(); });
    });
    req.on('error', () => {});
    req.end(JSON.stringify(msg({ stream: true })));
  });
  check('client disconnect aborts the upstream request', await until(() => up.seen[0] && up.seen[0].closedEarly), true);
  check('…and is recorded as aborted', await until(() => usage.length === 1 && usage[0].status === 'aborted'), true);

  console.log('per-provider concurrency:');
  up.reset((req, res) => setTimeout(() => sse(res, oaText(`reply ${req.headers['x-order'] || ''}`)), 120));
  const order = [];
  const jobs = [1, 2, 3].map((i) => sleep(i * 15).then(() => call(port, { body: msg({ messages: [{ role: 'user', content: `q${i}` }] }), token: 'tok-one' })).then((r) => { order.push(r.json.content[0].text); return r.status; }));
  const statuses = await Promise.all(jobs);
  check('maxConcurrency 1: all succeed, never two in flight upstream', [statuses, up.maxActive], [[200, 200, 200], 1]);
  check('…FIFO', up.seen.map((s) => s.body.messages[0].content), ['q1', 'q2', 'q3']);

  console.log('count_tokens:');
  const ct = await call(port, { path: '/v1/messages/count_tokens', body: msg() });
  check('openai-compatible: an estimate, never an upstream call', [ct.status, Number.isInteger(ct.json.input_tokens) && ct.json.input_tokens > 0], [200, true]);

  console.log('passthrough (anthropic):');
  const anthEvents = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-haiku-4-5-20251001","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":20,"cache_read_input_tokens":5,"cache_creation_input_tokens":3,"output_tokens":1}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi — é"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":42}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  up.reset((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_abc' });
    let i = 0;
    const next = () => { if (i < anthEvents.length) { res.write(anthEvents[i++]); setTimeout(next, 20); } else res.end(); };
    next();
  });
  usage.length = 0;
  const pt = await call(port, { path: '/v1/messages?beta=true', token: 'tok-anthropic', body: msg({ model: 'claude-haiku-4-5', max_tokens: 32000, stream: true }), headers: { 'anthropic-beta': 'claude-code-20250219,effort-2025-11-24', 'anthropic-version': '2023-06-01', 'x-claude-code-session-id': 'sess-pt' } });
  check('the stream is byte-identical to the provider\'s', pt.text, anthEvents.join(''));
  check('request-id is kept', pt.headers['request-id'], 'req_abc');
  const pseen = up.seen[0];
  check('upstream URL: <base>/v1/messages + the query', pseen.url, '/v1/messages?beta=true');
  check('credential swap: provider key in x-api-key, no Authorization, run token nowhere', [pseen.headers['x-api-key'], 'authorization' in pseen.headers, JSON.stringify(pseen.headers).includes('tok-anthropic')], ['sk-ant-real', false, false]);
  check('anthropic-version/-beta and x-claude-code-* forwarded', [pseen.headers['anthropic-version'], pseen.headers['anthropic-beta'], pseen.headers['x-claude-code-session-id']], ['2023-06-01', 'claude-code-20250219,effort-2025-11-24', 'sess-pt']);
  check('model mapped (modelMap) and max_tokens clamped to caps', [pseen.body.model, pseen.body.max_tokens], ['claude-haiku-4-5-20251001', 4096]);
  check('usage tapped from message_start + message_delta', [usage[0].inputTokens, usage[0].outputTokens, usage[0].cacheReadTokens, usage[0].cacheWriteTokens, usage[0].model, usage[0].requestedModel, usage[0].cliSessionId], [20, 42, 5, 3, 'claude-haiku-4-5-20251001', 'claude-haiku-4-5', 'sess-pt']);
  up.reset((req, res) => jsonRes(res, 200, { id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 7 } }));
  usage.length = 0;
  const unchanged = JSON.stringify(msg({ model: 'claude-sonnet-5', max_tokens: 100 }));
  const ptj = await call(port, { token: 'tok-anthropic', raw: unchanged });
  check('non-stream JSON passes through, usage tapped', [ptj.json.content[0].text, usage[0].inputTokens, usage[0].outputTokens], ['ok', 11, 7]);
  check('a body that needed no change is forwarded byte-for-byte', up.seen[0].raw, unchanged);
  const mixed = msg({ model: 'claude-sonnet-5', messages: [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'from deepseek', signature: 'ccsb1:eyJwIjoiZHMifQ' }, { type: 'text', text: 'a1' }] },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'from claude', signature: 'EqQBCkYIBxgCKkB-real' }, { type: 'text', text: 'a2' }] },
    { role: 'user', content: 'q3' },
  ] });
  up.reset((req, res) => jsonRes(res, 200, { id: 'msg_3', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  await call(port, { token: 'tok-anthropic', body: mixed });
  const sentAsst = up.seen[0].body.messages.filter((m) => m.role === 'assistant').map((m) => m.content.map((b) => b.type + (b.signature ? `:${b.signature.slice(0, 6)}` : '')));
  check('passthrough drops thinking signed by this bridge (Anthropic would 400), keeps real ones', sentAsst, [['text'], ['thinking:EqQBCk', 'text']]);
  up.reset((req, res) => jsonRes(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit' } }, { 'retry-after': '12', 'request-id': 'req_429' }));
  const pt429 = await call(port, { token: 'tok-anthropic', body: msg({ model: 'claude-sonnet-5', stream: true }) });
  check('upstream non-2xx: status, body and retry headers pass through', [pt429.status, pt429.json.error.type, pt429.headers['retry-after'], pt429.headers['request-id']], [429, 'rate_limit_error', '12', 'req_429']);
  up.reset((req, res) => jsonRes(res, 200, { input_tokens: 1234 }));
  const ptc = await call(port, { path: '/v1/messages/count_tokens?beta=true', token: 'tok-anthropic', body: msg({ model: 'claude-sonnet-5' }) });
  check('count_tokens is forwarded for anthropic', [ptc.json, up.seen[0].url], [{ input_tokens: 1234 }, '/v1/messages/count_tokens?beta=true']);
  up.reset((req, res) => sse(res, anthEvents));
  const strip = await call(port, { path: '/v1/messages?beta=true', token: 'tok-strip', body: msg({ stream: true }), headers: { 'anthropic-beta': 'claude-code-20250219' } });
  check('stripBetas: no anthropic-beta header, no ?beta=true', [strip.status, 'anthropic-beta' in up.seen[0].headers, up.seen[0].url], [200, false, '/anthropic/v1/messages']);
  check('authScheme both: Bearer + x-api-key', [up.seen[0].headers.authorization, up.seen[0].headers['x-api-key']], ['Bearer sk-compat', 'sk-compat']);
  up.reset((req, res) => jsonRes(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'no count_tokens here' } }));
  const ctc = await call(port, { path: '/v1/messages/count_tokens', token: 'tok-strip', body: msg() });
  check('anthropic-compatible without count_tokens -> our estimate', [ctc.status, ctc.json.input_tokens > 0], [200, true]);
  up.reset((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(anthEvents[0]); setTimeout(() => res.socket.destroy(), 30); });
  const ptCut = await call(port, { token: 'tok-anthropic', body: msg({ model: 'claude-sonnet-5', stream: true }) });
  check('passthrough cut at an event boundary -> an error event is appended', /event: error\ndata: .*overloaded_error/.test(ptCut.text), true);
  up.reset((req, res) => jsonRes(res, 503, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }));
  await call(port, { token: 'tok-anthropic', body: msg({ model: 'claude-sonnet-5' }) });
  check('passthrough 503 is retried too (before any client byte)', up.seen.length, 3);

  console.log('the request log:');
  up.reset((req, res) => sse(res, oaText('fine')));
  await call(port, { body: msg({ messages: [{ role: 'user', content: 'TOP-SECRET-PROMPT-CONTENT' }] }) });
  const lg = srv.recentLog();
  check('entries exist, newest last, with ids/sizes/status', [lg.length > 10, lg[lg.length - 1].route, lg[lg.length - 1].status, typeof lg[lg.length - 1].bytesIn], [true, 'messages', 'ok', 'number']);
  check('prompt content is never in the log', JSON.stringify(lg).includes('TOP-SECRET'), false);
  check('provider keys are never in the log', /sk-provider|sk-ant-real/.test(JSON.stringify(lg)), false);
  check('the log keeps at most 200 entries', await (async () => { for (let i = 0; i < 200; i++) await call(port, { path: '/v1/messages/count_tokens', body: msg() }); return srv.recentLog().length; })(), 200);

  await srv.close();
  up.server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
