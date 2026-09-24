// Pure translation rules of the LLM bridge: Anthropic Messages request -> OpenAI Chat
// Completions request (per dialect), and OpenAI stream/JSON -> Anthropic events/Message.
// No sockets. The golden input is a REAL Claude Code 2.1.281 request captured by
// test/llm-bridge-contract.test.js (CCS_CONTRACT_CAPTURE=1).
//
// Run: node test/llm-bridge-translate.test.js
'use strict';
const assert = require('assert');
const path = require('path');
const { toOpenAI, BadRequest, IMAGE_OMITTED, PDF_OMITTED, NO_OUTPUT, INTERRUPTED } = require('../llm-bridge/translate-request');
const { createTranslator, createAggregator, completionToChunk } = require('../llm-bridge/translate-response');
const { resolveDialect, PRESETS } = require('../llm-bridge/dialects');
const { resolveModel, capsFor, effectiveEffort } = require('../llm-bridge/models');
const { upstreamToolName, TOOL_NAME_RE, makeSignature, readSignature, anthropicToolId, upstreamToolId } = require('../llm-bridge/ids');
const { sanitizeSchema } = require('../llm-bridge/schema');
const { parseToolArguments } = require('../llm-bridge/json-repair');
const { estimateInputTokens, createCalibrator } = require('../llm-bridge/estimate');
const { canonicalizeError, overflowMessage } = require('../llm-bridge/errors');
const { createSseParser, parseEventJson } = require('../llm-bridge/sse');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const clone = (o) => JSON.parse(JSON.stringify(o));

// ------------------------------------------------------------------ helpers --
const CAPS = { tools: true, vision: true, reasoning: true, pdf: true, contextWindow: 128000, maxOutput: 16000 };
function ctxFor(dialect = 'generic', over = {}) {
  return {
    runId: 'run-1', purpose: 'chat',
    provider: { id: over.providerId || 'prov', label: 'Prov', type: 'openai-compatible', baseUrl: 'https://x.example/v1', apiKey: 'k', dialect, options: over.options || {} },
    // 'fake-model' is the model id of the captured real request
    model: 'm1', models: { m1: { ...CAPS, ...(over.caps || {}) }, 'fake-model': { ...CAPS, ...(over.caps || {}) } }, modelMap: over.modelMap || {}, fallbackModel: over.fallbackModel || 'm1',
    effort: over.effort === undefined ? null : over.effort,
  };
}
function translate(body, dialect = 'generic', over = {}) {
  const ctx = ctxFor(dialect, over);
  const upstreamModel = resolveModel(ctx, body.model);
  return toOpenAI(body, { ctx, dialect: resolveDialect(ctx.provider), upstreamModel, caps: capsFor(ctx, upstreamModel) });
}
const simple = (extra = {}) => ({ model: 'm1', max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }], ...extra });

/** Run chunks through the translator; returns [[event, data], …]. */
function runStream(chunks, opts = {}) {
  const events = [];
  const t = createTranslator({ clientModel: 'client-model', providerId: 'prov', toolNames: opts.toolNames || new Map(), stopSequences: opts.stopSequences || [], inputEstimate: 100, emitThinking: opts.emitThinking !== false, sink: (e, d) => events.push([e, d]) });
  t.start();
  for (const c of chunks) {
    const r = t.chunk(c);
    if (r && r.error !== undefined) { t.fail('api_error', String(r.error.message || r.error)); return events; }
  }
  t.end();
  return events;
}
const ch = (delta, extra = {}) => ({ choices: [{ index: 0, delta, ...extra }] });
const fin = (reason, usage) => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }], ...(usage ? { usage } : {}) });

/** The invariants every translated stream must hold. Returns a list of violations. */
function streamProblems(events, { expectError = false } = {}) {
  const p = [];
  const names = events.map((e) => e[0]);
  if (names.filter((n) => n === 'message_start').length !== 1) p.push('exactly one message_start');
  if (names[0] !== 'message_start') p.push('message_start first');
  let open = null;
  let last = -1;
  for (const [n, d] of events) {
    if (n === 'content_block_start') {
      if (open !== null) p.push(`block ${d.index} started while ${open} open`);
      if (!(d.index > last)) p.push(`index ${d.index} not increasing`);
      last = d.index; open = d.index;
    } else if (n === 'content_block_delta') {
      if (d.index !== open) p.push(`delta for ${d.index} while ${open} open`);
    } else if (n === 'content_block_stop') {
      if (d.index !== open) p.push(`stop for ${d.index} while ${open} open`);
      open = null;
    }
  }
  if (open !== null) p.push(`block ${open} never stopped`);
  const stops = names.filter((n) => n === 'message_stop').length;
  if (expectError) {
    if (names[names.length - 1] !== 'error') p.push('error is last');
    if (stops) p.push('no message_stop after an error');
  } else {
    if (stops !== 1 || names[names.length - 1] !== 'message_stop') p.push('exactly one message_stop, last');
    const md = events.filter((e) => e[0] === 'message_delta');
    if (md.length !== 1) p.push('one message_delta');
    else {
      const u = md[0][1].usage || {};
      if (!Number.isInteger(u.input_tokens) || !Number.isInteger(u.output_tokens)) p.push('message_delta carries usage');
    }
    if (names.includes('error')) p.push('no error on success');
  }
  return p;
}
const blocks = (events) => events.filter((e) => e[0] === 'content_block_start').map((e) => e[1].content_block.type);
const stopOf = (events) => { const d = events.find((e) => e[0] === 'message_delta'); return d && d[1].delta.stop_reason; };
const usageOf = (events) => { const d = events.find((e) => e[0] === 'message_delta'); return d && d[1].usage; };
const toolInputs = (events) => {
  const out = [];
  for (const [n, d] of events) {
    if (n === 'content_block_start' && d.content_block.type === 'tool_use') out.push({ id: d.content_block.id, name: d.content_block.name, json: '' });
    if (n === 'content_block_delta' && d.delta.type === 'input_json_delta') out[out.length - 1].json += d.delta.partial_json;
  }
  return out.map((t) => ({ id: t.id, name: t.name, input: JSON.parse(t.json) }));
};

// ============================================================ the real request --
const fixture = require(path.join(__dirname, 'fixtures', 'llm-bridge', 'claude-2.1.281-request.json'));
const real = fixture.body;

console.log('real Claude Code 2.1.281 request -> generic:');
{
  const r = translate(clone(real), 'generic');
  const b = r.body;
  check('roles: system first, then the conversation with tool turns', b.messages.map((m) => m.role),
    ['system', 'user', 'assistant', 'tool', 'user', 'assistant', 'tool', 'user']);
  const sys = b.messages[0].content;
  check('system is one string', typeof sys, 'string');
  check('the billing header block is gone', /x-anthropic-billing-header/.test(sys), false);
  check('the system prompt text is kept', sys.startsWith(real.system[1].text), true);
  check('the leading system-role entry (environment) is folded into the system prompt', /# Environment/.test(sys), true);
  check('a later system-role entry becomes user text (keeps the prefix cacheable)', b.messages[4].content, '<total_tokens>N tokens left</total_tokens>');
  check('tools become functions in order', b.tools.map((t) => t.function.name), real.tools.map((t) => t.name));
  check('tool schemas lose $schema but keep additionalProperties (basic)', [b.tools.some((t) => '$schema' in t.function.parameters), b.tools[0].function.parameters.additionalProperties], [false, false]);
  check('tool_use -> tool_calls with JSON arguments', b.messages[2].tool_calls, [{ id: 'call_read_1', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: '/WORKDIR/note.txt' }) } }]);
  check('assistant text survives next to the tool call', b.messages[2].content, 'Reading the file.');
  check('tool_result -> role:tool', [b.messages[3].tool_call_id, b.messages[3].content], ['call_read_1', '1\toriginal line\n2\t']);
  check('generic does not echo reasoning', 'reasoning_content' in b.messages[2], false);
  check('max_tokens clamped to caps.maxOutput', b.max_tokens, 16000);
  check('effort from output_config (RunCtx has none)', b.reasoning_effort, 'high');
  check('streams upstream with usage', [b.stream, b.stream_options], [true, { include_usage: true }]);
  check('metadata.user_id -> 32-hex user', /^[0-9a-f]{32}$/.test(b.user), true);
  check('no Anthropic-only field leaks', ['system', 'thinking', 'output_config', 'metadata', 'context_management', 'stop_sequences', 'tool_choice'].filter((k) => k in b), []);
  check('cache_control stripped everywhere', JSON.stringify(b).includes('cache_control'), false);
  check('the client asked for thinking (adaptive)', r.emitThinking, true);
}

console.log('real request -> each dialect:');
{
  const o = translate(clone(real), 'openai').body;
  check('openai: max_completion_tokens, reasoning_effort', [o.max_completion_tokens, 'max_tokens' in o, o.reasoning_effort], [16000, false, 'high']);
  const orr = translate(clone(real), 'openrouter').body;
  check('openrouter: reasoning object, usage.include', [orr.reasoning, orr.usage], [{ effort: 'high' }, { include: true }]);
  check('openrouter: cache_control kept on content parts', JSON.stringify(orr.messages).includes('"cache_control":{"type":"ephemeral"}'), true);
  check('openrouter: system keeps its cache_control parts', Array.isArray(orr.messages[0].content) && orr.messages[0].content.some((p) => p.cache_control), true);
  check('openrouter: echoes its own reasoning? (signature is provider "fake", not ours)', 'reasoning_details' in orr.messages[2], false);
  const ds = translate(clone(real), 'deepseek').body;
  check('deepseek: thinking enabled, no reasoning_effort', [ds.thinking, 'reasoning_effort' in ds], [{ type: 'enabled' }, false]);
  const ds2 = translate(clone(real), 'deepseek', { providerId: 'fake' }).body;
  check('deepseek: echoes reasoning_content of its OWN thinking blocks', [ds2.messages[2].reasoning_content, ds2.messages[5].reasoning_content], ['I should look at the file first.', 'Now change it.']);
  const gm = translate(clone(real), 'gemini').body;
  const readParams = gm.tools.find((t) => t.function.name === 'Read').function.parameters;
  check('gemini: strict schema drops additionalProperties/exclusiveMinimum', [JSON.stringify(gm.tools).includes('additionalProperties'), JSON.stringify(readParams).includes('exclusiveMinimum')], [false, false]);
  check('gemini: reasoning_effort', gm.reasoning_effort, 'high');
  const qw = translate(clone(real), 'qwen').body;
  check('qwen: enable_thinking + budget for high', [qw.enable_thinking, qw.thinking_budget], [true, 16384]);
  const ms = translate(clone(real), 'mistral').body;
  const ids = ms.messages.filter((m) => m.tool_calls).map((m) => m.tool_calls[0].id);
  const tids = ms.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  check('mistral: 9-char alnum tool ids, consistent both ways', [ids.every((i) => /^[A-Za-z0-9]{9}$/.test(i)), ids], [true, tids]);
  check('mistral: deterministic id mapping', upstreamToolId('call_read_1', 'mistral9'), ids[0]);
  check('mistral: no effort param', ['reasoning_effort', 'reasoning', 'thinking'].some((k) => k in ms), false);
  check('mistral: no user message right after a tool message', ms.messages.some((m, i) => m.role === 'user' && ms.messages[i - 1] && ms.messages[i - 1].role === 'tool'), false);
  check('mistral: that text went into the tool message', /<total_tokens>/.test(ms.messages.filter((m) => m.role === 'tool')[0].content), true);
  const ol = translate(clone(real), 'ollama').body;
  check('ollama: no reasoning_effort unless caps say reasoning:true', 'reasoning_effort' in translate(clone(real), 'ollama', { caps: { reasoning: null } }).body, false);
  check('ollama: reasoning_effort when caps.reasoning === true', ol.reasoning_effort, 'high');
}

console.log('system handling:');
{
  const b = translate(simple({ system: 'plain system', messages: [{ role: 'user', content: 'a' }, { role: 'system', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }] })).body;
  check('string system + folded system entry', b.messages[0], { role: 'system', content: 'plain system\n\none\n\ntwo' });
  const all = translate(simple({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'system', content: 'late' }, { role: 'user', content: 'c' }] }), 'generic', { options: { systemFold: 'all' } }).body;
  check('systemFold:all folds even late entries', [all.messages[0].content, all.messages.map((m) => m.role)], ['late', ['system', 'user', 'assistant', 'user']]);
  const late = translate(simple({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'system', content: 'late note' }, { role: 'user', content: 'c' }] })).body;
  check('a late plain note is wrapped as a system-reminder and merged into the next user turn', late.messages[2], { role: 'user', content: '<system-reminder>\nlate note\n</system-reminder>\n\nc' });
  check('an unknown role is a 400, naming the index', (() => { try { translate(simple({ messages: [{ role: 'user', content: 'a' }, { role: 'tool', content: 'x' }] })); return null; } catch (e) { return e instanceof BadRequest && /messages\.1\.role/.test(e.message); } })(), true);
  check('no usable content is a 400', (() => { try { translate(simple({ messages: [{ role: 'system', content: 'x' }] })); return null; } catch (e) { return e instanceof BadRequest; } })(), true);
}

console.log('user content:');
{
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const b = translate(simple({ messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, img, { type: 'image', source: { type: 'url', url: 'https://i.example/x.png' } }] }] })).body;
  check('images -> image_url parts (base64 -> data URL, url -> url)', b.messages[0].content, [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'image_url', image_url: { url: 'https://i.example/x.png' } }]);
  const nv = translate(simple({ messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, img] }] }), 'generic', { caps: { vision: false } }).body;
  check('no vision -> placeholder text (and collapses to a string)', nv.messages[0].content, `look\n\n${IMAGE_OMITTED}`);
  check('consecutive text parts collapse to one string', translate(simple({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] })).body.messages[0].content, 'a\n\nb');
  const pdf = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBE' } };
  check('PDF with fileParts (openai) -> file part', translate(simple({ messages: [{ role: 'user', content: [pdf] }] }), 'openai').body.messages[0].content, [{ type: 'file', file: { filename: 'document.pdf', file_data: 'data:application/pdf;base64,JVBE' } }]);
  check('PDF without fileParts -> placeholder, never a 400', translate(simple({ messages: [{ role: 'user', content: [pdf] }] })).body.messages[0].content, PDF_OMITTED);
  check('PDF with caps.pdf false -> placeholder even on openai', translate(simple({ messages: [{ role: 'user', content: [pdf] }] }), 'openai', { caps: { pdf: false } }).body.messages[0].content, PDF_OMITTED);
  check('a plain-text document -> its text', translate(simple({ messages: [{ role: 'user', content: [{ type: 'document', title: 'T', source: { type: 'text', data: 'body' } }] }] })).body.messages[0].content, 'T\n\nbody');
}

console.log('tool results:');
{
  const hist = (result, extra = []) => simple({ messages: [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Shot', input: {} }] },
    { role: 'user', content: [result, ...extra] },
  ] });
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QQ==' } };
  const withImg = translate(hist({ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'captured' }, img] }, [{ type: 'text', text: 'and?' }])).body;
  check('tool result with an image: tool text, then a user message carrying the image', withImg.messages.slice(2), [
    { role: 'tool', tool_call_id: 'toolu_1', content: 'captured' },
    { role: 'user', content: [{ type: 'text', text: '[image from tool result toolu_1]' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QQ==' } }, { type: 'text', text: 'and?' }] },
  ]);
  const noVis = translate(hist({ type: 'tool_result', tool_use_id: 'toolu_1', content: [img] }), 'generic', { caps: { vision: false } }).body;
  check('no vision: placeholder in the tool message, no extra user turn', noVis.messages.slice(2), [{ role: 'tool', tool_call_id: 'toolu_1', content: IMAGE_OMITTED }]);
  check('empty tool result -> "(no output)"', translate(hist({ type: 'tool_result', tool_use_id: 'toolu_1', content: [] })).body.messages[2].content, NO_OUTPUT);
  check('is_error -> "[tool error] " prefix', translate(hist({ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'boom' })).body.messages[2].content, '[tool error] boom');
  const orphan = translate(simple({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gone', content: 'late' }, { type: 'text', text: 'hi' }] }] })).body;
  check('an orphaned tool result is demoted to user text (OpenAI 400s on it)', orphan.messages, [{ role: 'user', content: '[result of tool call gone]\nlate\n\nhi' }]);
  const missing = translate(simple({ messages: [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'X', input: {} }, { type: 'tool_use', id: 'b', name: 'X', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }, { type: 'text', text: 'next' }] },
  ] })).body;
  check('an unanswered tool call gets a synthetic "interrupted" answer', missing.messages.slice(2).map((m) => [m.role, m.tool_call_id || null, m.content]), [['tool', 'a', 'ok'], ['tool', 'b', INTERRUPTED], ['user', null, 'next']]);
  const empty = translate(simple({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 'real-anthropic-sig' }] }, { role: 'user', content: 'b' }] })).body;
  check('an assistant turn that ends up empty is dropped and the users merge', empty.messages, [{ role: 'user', content: 'a\n\nb' }]);
}

console.log('thinking echo via signatures:');
{
  const ev = runStream([ch({ reasoning_content: 'step one' }), ch({ content: 'answer' }), fin('stop')]);
  const sig = ev.find((e) => e[0] === 'content_block_delta' && e[1].delta.type === 'signature_delta')[1].delta.signature;
  check('our signature is ccsb1: + base64url JSON naming the provider', [sig.startsWith('ccsb1:'), readSignature(sig)], [true, { p: 'prov' }]);
  const history = (signature, thinking = 'step one') => simple({ messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'thinking', thinking, signature }, { type: 'text', text: 'answer' }] }, { role: 'user', content: 'q2' }] });
  check('deepseek echoes its own reasoning as reasoning_content', translate(history(sig), 'deepseek').body.messages[1].reasoning_content, 'step one');
  check('another provider\'s reasoning is dropped', 'reasoning_content' in translate(history(makeSignature('other')), 'deepseek').body.messages[1], false);
  check('a real Anthropic signature is dropped', 'reasoning_content' in translate(history('EqQBCkYIBxgCKkB…'), 'deepseek').body.messages[1], false);
  check('reasoningEcho none drops it', 'reasoning_content' in translate(history(sig), 'generic').body.messages[1], false);
  const det = [{ type: 'reasoning.text', text: 'we', index: 0 }, { type: 'reasoning.text', text: ' think', index: 0, signature: 'sigX' }, { type: 'reasoning.encrypted', data: 'ENC', index: 1 }];
  const ev2 = runStream([ch({ reasoning: 'we', reasoning_details: [det[0]] }), ch({ reasoning: ' think', reasoning_details: [det[1]] }), ch({ reasoning_details: [det[2]] }), ch({ content: 'x' }), fin('stop')]);
  const shown = ev2.filter((e) => e[0] === 'content_block_delta' && e[1].delta.type === 'thinking_delta').map((e) => e[1].delta.thinking).join('');
  check('shown reasoning is the text, encrypted items are not shown', shown, 'we think');
  const sig2 = ev2.find((e) => e[0] === 'content_block_delta' && e[1].delta.type === 'signature_delta')[1].delta.signature;
  const merged = [{ type: 'reasoning.text', text: 'we think', index: 0, signature: 'sigX' }, { type: 'reasoning.encrypted', data: 'ENC', index: 1 }];
  check('streamed details are merged by index and carried in the signature', readSignature(sig2).d, merged);
  check('openrouter echoes the decoded reasoning_details', translate(history(sig2, 'we think'), 'openrouter').body.messages[1].reasoning_details, merged);
}

console.log('tool names:');
{
  const long = 'mcp__my.company-server__do/the:thing_' + 'x'.repeat(60);
  const up = upstreamToolName(long);
  check('an invalid name maps to a valid, deterministic one', [TOOL_NAME_RE.test(up), up === upstreamToolName(long), /^t[0-9a-f]{8}_/.test(up)], [true, true, true]);
  check('a valid name is untouched', upstreamToolName('mcp__srv__tool'), 'mcp__srv__tool');
  const body = simple({ tools: [{ name: long, input_schema: { type: 'object' } }, { name: 'Read', input_schema: { type: 'object' } }], tool_choice: { type: 'tool', name: long } });
  const r = translate(body);
  check('tools keep their order; the invalid one is renamed', r.body.tools.map((t) => t.function.name), [up, 'Read']);
  check('tool_choice follows the rename', r.body.tool_choice, { type: 'function', function: { name: up } });
  const ev = runStream([ch({ tool_calls: [{ index: 0, id: 'call_9', function: { name: up, arguments: '{}' } }] }), fin('tool_calls')], { toolNames: r.toolNames });
  check('the response maps the name back', toolInputs(ev)[0].name, long);
  const hist = translate(simple({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'x1', name: long, input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x1', content: 'r' }] }] }));
  check('history tool_use names map the same way', hist.body.messages[1].tool_calls[0].function.name, up);
  check('server tools are dropped, custom kept', translate(simple({ tools: [{ type: 'web_search_20250305', name: 'web_search' }, { type: 'custom', name: 'A', input_schema: {} }, { name: 'B', input_schema: {} }] })).body.tools.map((t) => t.function.name), ['A', 'B']);
}

console.log('tool_choice / sampling / stops / extraBody:');
{
  const tools = [{ name: 'A', input_schema: { type: 'object' } }];
  check('auto/any/none', ['auto', 'any', 'none'].map((t) => translate(simple({ tools, tool_choice: { type: t } })).body.tool_choice), ['auto', 'required', 'none']);
  check('disable_parallel_tool_use -> parallel_tool_calls:false', translate(simple({ tools, tool_choice: { type: 'auto', disable_parallel_tool_use: true } })).body.parallel_tool_calls, false);
  check('no tools -> no tool_choice', 'tool_choice' in translate(simple({ tool_choice: { type: 'any' } })).body, false);
  check('caps.tools false -> tools not sent', 'tools' in translate(simple({ tools }), 'generic', { caps: { tools: false } }).body, false);
  const s = translate(simple({ temperature: 0.3, top_p: 0.9, top_k: 40, stop_sequences: ['a', 'b', 'c', 'd', 'e'] })).body;
  check('temperature/top_p pass, top_k needs allowTopK, stop capped at 4', [s.temperature, s.top_p, 'top_k' in s, s.stop], [0.3, 0.9, false, ['a', 'b', 'c', 'd']]);
  check('openrouter passes top_k', translate(simple({ top_k: 40 }), 'openrouter').body.top_k, 40);
  const oa = translate(simple({ temperature: 0.3, top_p: 0.9 }), 'openai', { effort: 'high' }).body;
  check('openai drops sampling when reasoning is on', ['temperature' in oa, 'top_p' in oa], [false, false]);
  check('openai keeps sampling when reasoning is off', translate(simple({ temperature: 0.3 }), 'openai', { caps: { reasoning: false }, effort: 'high' }).body.temperature, 0.3);
  const eb = translate(simple(), 'generic', { options: { extraBody: { provider: { order: ['x'] }, stream_options: { extra: 1 } } } }).body;
  check('extraBody deep-merges last', [eb.provider, eb.stream_options], [{ order: ['x'] }, { include_usage: true, extra: 1 }]);
  check('max_tokens below the cap is kept', translate(simple({ max_tokens: 500 })).body.max_tokens, 500);
  check('max_tokens with an unknown cap is kept', translate(simple({ max_tokens: 64000 }), 'generic', { caps: { maxOutput: null } }).body.max_tokens, 64000);
  const js = translate(simple({ output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false } } } })).body;
  check('structured output -> response_format json_schema', js.response_format, { type: 'json_schema', json_schema: { name: 'output', schema: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false } } });
  check('upstreamStream:false -> no stream flag', 'stream' in translate(simple(), 'generic', { options: { upstreamStream: false } }).body, false);
}

console.log('effort, every source and dialect:');
{
  const E = (ctxEffort, body) => effectiveEffort({ effort: ctxEffort }, body);
  check('RunCtx wins over output_config and thinking', E('low', { output_config: { effort: 'max' }, thinking: { type: 'enabled', budget_tokens: 30000 } }), 'low');
  check('output_config next', E(null, { output_config: { effort: 'max' }, thinking: { type: 'disabled' } }), 'max');
  check('thinking budgets bucket: <2500 low, <8000 medium, else high', [1024, 2499, 2500, 7999, 8000, 31999].map((b) => E(null, { thinking: { type: 'enabled', budget_tokens: b } })), ['low', 'low', 'medium', 'medium', 'high', 'high']);
  check('enabled without a budget -> medium; adaptive -> provider default; disabled -> none; absent -> none sent',
    [E(null, { thinking: { type: 'enabled' } }), E(null, { thinking: { type: 'adaptive' } }), E(null, { thinking: { type: 'disabled' } }), E(null, {})], ['medium', null, 'none', null]);
  const eff = (dialect, effort, caps) => { const b = translate(simple(), dialect, { effort, caps }).body; return ['reasoning_effort', 'reasoning', 'thinking', 'enable_thinking', 'thinking_budget'].filter((k) => k in b).map((k) => [k, b[k]]); };
  check('generic: low..max (xhigh/max -> high), none omitted', ['low', 'medium', 'high', 'xhigh', 'max', 'none'].map((e) => eff('generic', e)), [[['reasoning_effort', 'low']], [['reasoning_effort', 'medium']], [['reasoning_effort', 'high']], [['reasoning_effort', 'high']], [['reasoning_effort', 'high']], []]);
  check('openai: none -> "none"', eff('openai', 'none'), [['reasoning_effort', 'none']]);
  check('gemini: max -> high', eff('gemini', 'max'), [['reasoning_effort', 'high']]);
  check('openrouter: effort object; none -> enabled:false', [eff('openrouter', 'medium'), eff('openrouter', 'none')], [[['reasoning', { effort: 'medium' }]], [['reasoning', { enabled: false }]]]);
  check('deepseek: thinking enabled/disabled', [eff('deepseek', 'low'), eff('deepseek', 'none')], [[['thinking', { type: 'enabled' }]], [['thinking', { type: 'disabled' }]]]);
  check('qwen: budgets per effort, max = caps.maxOutput', ['low', 'medium', 'high', 'xhigh', 'max', 'none'].map((e) => eff('qwen', e)),
    [[['enable_thinking', true], ['thinking_budget', 2048]], [['enable_thinking', true], ['thinking_budget', 8192]], [['enable_thinking', true], ['thinking_budget', 16384]], [['enable_thinking', true], ['thinking_budget', 32768]], [['enable_thinking', true], ['thinking_budget', 16000]], [['enable_thinking', false]]]);
  check('mistral: never', eff('mistral', 'high'), []);
  check('ollama: only with caps.reasoning true', [eff('ollama', 'high', { reasoning: null }), eff('ollama', 'high', { reasoning: true })], [[], [['reasoning_effort', 'high']]]);
  check('caps.reasoning false: nothing, for every dialect', Object.keys(PRESETS).map((d) => eff(d, 'high', { reasoning: false }).length), Object.keys(PRESETS).map(() => 0));
  check('RunCtx effort beats the request\'s output_config in the upstream body', translate(simple({ output_config: { effort: 'low' } }), 'generic', { effort: 'xhigh' }).body.reasoning_effort, 'high');
  check('dialect overrides via provider.options', translate(simple(), 'generic', { effort: 'high', options: { effortParam: 'thinking' } }).body.thinking, { type: 'enabled' });
}

console.log('model resolution:');
{
  const ctx = ctxFor('generic', { modelMap: { 'claude-haiku-4-5': 'fast-1', haiku: 'fast-2' }, fallbackModel: 'fb' });
  check('modelMap exact match first', resolveModel(ctx, 'claude-haiku-4-5'), 'fast-1');
  check('family alias covers dated ids', resolveModel(ctx, 'claude-haiku-4-5-20251001'), 'fast-2');
  check('a run model passes', resolveModel(ctx, 'm1'), 'm1');
  check('an unknown Claude-looking id -> fallbackModel', resolveModel(ctx, 'claude-sonnet-5'), 'fb');
  check('an unknown non-Claude id passes unchanged', resolveModel(ctx, 'vendor/x'), 'vendor/x');
  check('anthropic keeps Claude ids', resolveModel({ ...ctx, provider: { type: 'anthropic' } }, 'claude-sonnet-5'), 'claude-sonnet-5');
  check('anthropic-compatible: unknown Claude id -> fallbackModel (DeepSeek & co. do not serve Claude names)', resolveModel({ ...ctx, provider: { type: 'anthropic-compatible' } }, 'claude-sonnet-5'), 'fb');
  check('anthropic-compatible without a fallbackModel keeps the id (a Claude proxy)', resolveModel({ ...ctx, fallbackModel: null, provider: { type: 'anthropic-compatible' } }, 'claude-sonnet-5'), 'claude-sonnet-5');
  check('anthropic-compatible: its own model ids pass', resolveModel({ ...ctx, provider: { type: 'anthropic-compatible' } }, 'm1'), 'm1');
  check('no model in the request -> the run model', resolveModel(ctx, undefined), 'm1');
}

console.log('schema sanitize:');
{
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false, required: [],
    properties: { default: { type: 'string', format: 'uri', default: 'x' }, n: { type: 'integer', exclusiveMinimum: 0, examples: [1] }, e: { const: 'k' }, when: { type: 'string', format: 'date-time' },
      list: { type: 'array', items: { type: 'object', $schema: 'x', additionalProperties: { type: 'string' }, properties: { format: { type: 'string' } } } } } };
  check('basic: $schema and empty required gone, the rest kept', sanitizeSchema(schema, 'basic'), { type: 'object', additionalProperties: false,
    properties: { default: { type: 'string', format: 'uri', default: 'x' }, n: { type: 'integer', exclusiveMinimum: 0, examples: [1] }, e: { const: 'k' }, when: { type: 'string', format: 'date-time' },
      list: { type: 'array', items: { type: 'object', additionalProperties: { type: 'string' }, properties: { format: { type: 'string' } } } } } });
  check('strict: unsupported keywords removed recursively; parameters NAMED default/format survive', sanitizeSchema(schema, 'strict'), { type: 'object',
    properties: { default: { type: 'string' }, n: { type: 'integer' }, e: { enum: ['k'] }, when: { type: 'string', format: 'date-time' },
      list: { type: 'array', items: { type: 'object', properties: { format: { type: 'string' } } } } } });
  check('none: untouched', sanitizeSchema(schema, 'none'), schema);
  check('missing schema -> empty object schema', sanitizeSchema(undefined), { type: 'object', properties: {} });
}

console.log('tool arguments:');
{
  check('valid', parseToolArguments('{"a":1}'), { value: { a: 1 }, repaired: false, invalid: false });
  check('empty -> {}', parseToolArguments(''), { value: {}, repaired: false, invalid: false });
  check('trailing comma repaired', parseToolArguments('{"a":1,}').value, { a: 1 });
  check('truncated object closed', parseToolArguments('{"a":"b","c":[1,2').value, { a: 'b', c: [1, 2] });
  check('JSON inside a JSON string unwrapped', parseToolArguments(JSON.stringify(JSON.stringify({ a: 1 }))).value, { a: 1 });
  check('object sent twice -> first', parseToolArguments('{"a":1}{"a":1}').value, { a: 1 });
  check('code fence stripped', parseToolArguments('```json\n{"a":1}\n```').value, { a: 1 });
  check('unrepairable -> __invalid_arguments (truncated raw)', parseToolArguments('not json at all'), { value: { __invalid_arguments: 'not json at all' }, repaired: false, invalid: true });
  check('an array is not a tool input', parseToolArguments('[1,2]').invalid, true);
  check('raw is truncated to 2000 chars', parseToolArguments('x'.repeat(5000)).value.__invalid_arguments.length, 2000);
}

// ================================================================== streams --
console.log('stream: text only:');
{
  const ev = runStream([ch({ role: 'assistant', content: 'Hel' }), ch({ content: 'lo' }), fin('stop', { prompt_tokens: 50, completion_tokens: 2 })]);
  check('invariants', streamProblems(ev), []);
  check('one text block', blocks(ev), ['text']);
  check('message_start: client model name, estimate, output 1', [ev[0][1].message.model, ev[0][1].message.usage], ['client-model', { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }]);
  check('ping right after message_start', ev[1][0], 'ping');
  check('end_turn + real usage', [stopOf(ev), usageOf(ev)], ['end_turn', { input_tokens: 50, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }]);
  check('message id shape', /^msg_[A-Za-z0-9]{24}$/.test(ev[0][1].message.id), true);
}

console.log('stream: reasoning, text, two tool calls:');
{
  const ev = runStream([
    ch({ reasoning_content: 'think ' }), ch({ reasoning_content: 'more' }), ch({ content: 'Let me look.' }),
    ch({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'Read', arguments: '' } }] }),
    ch({ tool_calls: [{ index: 0, function: { arguments: '{"file_path":' } }] }),
    ch({ tool_calls: [{ index: 0, function: { arguments: '"/a"}' } }] }),
    ch({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/b"}' } }] }),
    fin('tool_calls'), { choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 7 } } },
  ]);
  check('invariants', streamProblems(ev), []);
  check('thinking, text, tool_use, tool_use', blocks(ev), ['thinking', 'text', 'tool_use', 'tool_use']);
  check('tool calls complete, in order, one input_json_delta each', [toolInputs(ev), ev.filter((e) => e[0] === 'content_block_delta' && e[1].delta.type === 'input_json_delta').length],
    [[{ id: 'call_a', name: 'Read', input: { file_path: '/a' } }, { id: 'call_b', name: 'Read', input: { file_path: '/b' } }], 2]);
  check('stop_reason tool_use', stopOf(ev), 'tool_use');
  check('thinking block closes with our signature', ev.some((e) => e[0] === 'content_block_delta' && e[1].delta.type === 'signature_delta' && e[1].delta.signature.startsWith('ccsb1:')), true);
}

console.log('stream: interleaved parallel tool calls, missing index, odd ids:');
{
  const ev = runStream([
    ch({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'A', arguments: '{"x"' } }, { index: 1, id: 'c2', function: { name: 'B', arguments: '{"y"' } }] }),
    ch({ tool_calls: [{ index: 1, function: { arguments: ':2}' } }] }),
    ch({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }),
    fin('tool_calls'),
  ]);
  check('interleaved deltas are assembled per call', toolInputs(ev), [{ id: 'c1', name: 'A', input: { x: 1 } }, { id: 'c2', name: 'B', input: { y: 2 } }]);
  check('invariants', streamProblems(ev), []);
  const noIdx = runStream([
    ch({ tool_calls: [{ id: 'g1', function: { name: 'A', arguments: '{"a":1}' } }] }),
    ch({ tool_calls: [{ id: 'g2', function: { name: 'B', arguments: '{"b":' } }] }),
    ch({ tool_calls: [{ function: { arguments: '2}' } }] }),
    fin('stop'),
  ]);
  check('index missing: keyed by id, continuation joins the last call', toolInputs(noIdx), [{ id: 'g1', name: 'A', input: { a: 1 } }, { id: 'g2', name: 'B', input: { b: 2 } }]);
  check('any emitted tool call -> tool_use even with finish "stop"', stopOf(noIdx), 'tool_use');
  const reused = runStream([
    ch({ tool_calls: [{ index: 0, id: 'first', function: { name: 'A', arguments: '{}' } }] }),
    ch({ tool_calls: [{ index: 0, id: 'second', function: { name: 'B', arguments: '{}' } }] }),
    fin('tool_calls'),
  ]);
  check('an index reused with a new id is a new call', toolInputs(reused).map((t) => t.id), ['first', 'second']);
  const odd = runStream([ch({ tool_calls: [{ index: 0, id: 'call|with/slashes', function: { name: 'A', arguments: '{}' } }, { index: 1, function: { name: 'B', arguments: '{}' } }] }), fin('tool_calls')]);
  const ids = toolInputs(odd).map((t) => t.id);
  check('invalid upstream ids are hashed deterministically; missing ones generated', [ids[0], anthropicToolId('call|with/slashes'), /^toolu_[A-Za-z0-9]{24}$/.test(ids[1])], [anthropicToolId('call|with/slashes'), ids[0], true]);
  const repeatName = runStream([ch({ tool_calls: [{ index: 0, id: 'r', function: { name: 'Read', arguments: '{"a":' } }] }), ch({ tool_calls: [{ index: 0, function: { name: 'Read', arguments: '1}' } }] }), fin('tool_calls')]);
  check('a name repeated on every chunk is not doubled', toolInputs(repeatName)[0].name, 'Read');
}

console.log('stream: tool arguments that are not JSON:');
{
  const ev = runStream([ch({ tool_calls: [{ index: 0, id: 'c', function: { name: 'A', arguments: '{"a":1,}' } }] }), fin('tool_calls')]);
  check('repairable -> repaired input', toolInputs(ev)[0].input, { a: 1 });
  const bad = runStream([ch({ tool_calls: [{ index: 0, id: 'c', function: { name: 'A', arguments: 'rm -rf please' } }] }), fin('tool_calls')]);
  check('unrepairable -> __invalid_arguments (never a silent {})', toolInputs(bad)[0].input, { __invalid_arguments: 'rm -rf please' });
  const cut = runStream([ch({ content: 'writing' }), ch({ tool_calls: [{ index: 0, id: 'c', function: { name: 'Write', arguments: '{"content": "abc' } }] }), fin('length')]);
  check('a call cut off by max_tokens: repaired when possible', [toolInputs(cut)[0] && toolInputs(cut)[0].input, stopOf(cut)], [{ content: 'abc' }, 'tool_use']);
  const cut2 = runStream([ch({ content: 'writing' }), ch({ tool_calls: [{ index: 0, id: 'c', function: { name: 'Write', arguments: '{"content": "abc" "' } }] }), fin('length')]);
  check('…and dropped when not, so the CLI sees max_tokens', [blocks(cut2), stopOf(cut2)], [['text'], 'max_tokens']);
}

console.log('stream: stop reasons:');
{
  check('content_filter -> refusal', stopOf(runStream([ch({ content: 'no' }), fin('content_filter')])), 'refusal');
  check('length -> max_tokens', stopOf(runStream([ch({ content: 'long' }), fin('length')])), 'max_tokens');
  const ss = runStream([ch({ content: 'a b END' }), fin('stop')], { stopSequences: ['END'] });
  const sd = ss.find((e) => e[0] === 'message_delta')[1].delta;
  check('output ending in a stop sequence -> stop_sequence', [sd.stop_reason, sd.stop_sequence], ['stop_sequence', 'END']);
  const vs = runStream([ch({ content: 'a b' }), { choices: [{ index: 0, delta: {}, finish_reason: 'stop', stop_reason: 'HALT' }] }], { stopSequences: ['HALT'] });
  check('a server-reported matched stop (vLLM stop_reason) -> stop_sequence', vs.find((e) => e[0] === 'message_delta')[1].delta, { stop_reason: 'stop_sequence', stop_sequence: 'HALT' });
  check('plain stop -> end_turn', stopOf(runStream([ch({ content: 'x' }), fin('stop')], { stopSequences: ['END'] })), 'end_turn');
  check('an OpenAI refusal field -> text + refusal', [blocks(runStream([ch({ refusal: 'I cannot' }), fin('stop')])), stopOf(runStream([ch({ refusal: 'I cannot' }), fin('stop')]))], [['text'], 'refusal']);
}

console.log('stream: usage shapes:');
{
  check('OpenAI cached tokens', usageOf(runStream([ch({ content: 'x' }), fin('stop', { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 800 } })])),
    { input_tokens: 200, output_tokens: 10, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 });
  check('DeepSeek prompt_cache_hit_tokens', usageOf(runStream([ch({ content: 'x' }), fin('stop', { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 })])),
    { input_tokens: 400, output_tokens: 10, cache_read_input_tokens: 600, cache_creation_input_tokens: 0 });
  check('usage in a trailing chunk with empty choices', usageOf(runStream([ch({ content: 'x' }), fin('stop'), { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } }])).input_tokens, 5);
  const est = usageOf(runStream([ch({ content: 'x'.repeat(36) }), fin('stop')]));
  check('no upstream usage -> estimates (input = message_start estimate)', [est.input_tokens, est.output_tokens], [100, 10]);
}

console.log('stream: reasoning placement and client choice:');
{
  const late = runStream([ch({ reasoning_content: 'a' }), ch({ content: 'answer' }), ch({ reasoning_content: 'late thought' }), ch({ content: 'more' }), fin('stop')]);
  check('reasoning after text opens a NEW thinking block (not dropped)', blocks(late), ['thinking', 'text', 'thinking', 'text']);
  check('invariants', streamProblems(late), []);
  check('both in one chunk: thinking first', blocks(runStream([ch({ reasoning_content: 'hm', content: 'Hi' }), fin('stop')])), ['thinking', 'text']);
  check('client did not ask for thinking -> no thinking blocks', blocks(runStream([ch({ reasoning_content: 'hidden' }), ch({ content: 'ok' }), fin('stop')], { emitThinking: false })), ['text']);
  check('reasoning_details only (OpenRouter)', blocks(runStream([ch({ reasoning_details: [{ type: 'reasoning.summary', summary: 'sum', index: 0 }] }), ch({ content: 'ok' }), fin('stop')])), ['thinking', 'text']);
  const empty = runStream([ch({ reasoning_content: '' }), ch({ content: '' }), fin('stop')]);
  check('empty deltas open nothing', [blocks(empty), streamProblems(empty)], [[], []]);
  const onlyThink = runStream([ch({ reasoning_content: 'all budget spent' }), fin('length')]);
  check('reasoning-only stream is closed properly', [blocks(onlyThink), stopOf(onlyThink), streamProblems(onlyThink)], [['thinking'], 'max_tokens', []]);
}

console.log('stream: mid-stream error:');
{
  const ev = runStream([ch({ content: 'partial' }), { error: { message: 'upstream exploded', code: 502 } }, ch({ content: 'never' })]);
  check('open block closed, error event last, no message_stop', streamProblems(ev, { expectError: true }), []);
  check('the error event is Anthropic-shaped', ev[ev.length - 1][1], { type: 'error', error: { type: 'api_error', message: 'upstream exploded' } });
  const t = createTranslator({ clientModel: 'm', providerId: 'p', sink: () => {} });
  t.start(); t.fail('overloaded_error', 'x');
  check('after fail(), end() and chunk() do nothing', [t.chunk(ch({ content: 'x' })), t.finished], [null, true]);
}

console.log('non-stream: the same state machine builds the Message:');
{
  const agg = createAggregator();
  const t = createTranslator({ clientModel: 'claude-x', providerId: 'prov', toolNames: new Map(), inputEstimate: 9, emitThinking: true, sink: agg.event });
  t.chunk(completionToChunk({ id: 'x', choices: [{ message: { role: 'assistant', content: 'result', reasoning_content: 'why', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"p":1}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 7, completion_tokens: 40 } }));
  t.end();
  const m = agg.message();
  check('Message JSON shape', [m.type, m.role, m.model, m.stop_reason, m.stop_sequence, /^msg_/.test(m.id)], ['message', 'assistant', 'claude-x', 'tool_use', null, true]);
  check('content: thinking (signed), text, tool_use with parsed input', m.content.map((b) => b.type === 'tool_use' ? [b.type, b.id, b.name, b.input] : b.type === 'thinking' ? [b.type, b.thinking, readSignature(b.signature)] : [b.type, b.text]),
    [['thinking', 'why', { p: 'prov' }], ['text', 'result'], ['tool_use', 'call_1', 'Read', { p: 1 }]]);
  check('usage', m.usage, { input_tokens: 7, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
}

console.log('SSE parser:');
{
  const got = [];
  const p = createSseParser((e) => got.push(e));
  const raw = 'event: a\r\ndata: {"x":1}\r\n\r\n: comment\n\ndata: {"y":\ndata: 2}\n\ndata: [DONE]\n\n';
  const buf = Buffer.from(raw + 'data: {"z":"é"}\n\n');
  for (let i = 0; i < buf.length; i += 3) p.feed(buf.subarray(i, i + 3)); // split everywhere, incl. inside UTF-8
  p.end();
  check('events across arbitrary splits, CRLF, comments, multi-line data, UTF-8', got, [{ event: 'a', data: '{"x":1}' }, { event: 'message', data: '{"y":\n2}' }, { event: 'message', data: '[DONE]' }, { event: 'message', data: '{"z":"é"}' }]);
  check('non-compliant "several JSON lines in one event" still parses', parseEventJson('{"a":1}\n{"b":2}'), [{ a: 1 }, { b: 2 }]);
}

console.log('estimates:');
{
  const e1 = estimateInputTokens({ system: 'x'.repeat(360), messages: [{ role: 'user', content: [{ type: 'text', text: 'y'.repeat(360) }, { type: 'image', source: {} }] }] });
  check('chars/3.6 + 1600 per image + 3 per message', e1, 200 + 1600 + 3);
  const cal = createCalibrator();
  cal.observe('s', 1000, 1500);
  check('calibration learns real/estimated per session', [cal.apply('s', 1000), cal.apply('other', 1000)], [1500, 1000]);
  cal.observe('s', 1000, 1000);
  check('…as an EMA', cal.apply('s', 1000), 1350);
}

console.log('error canonicalization (pure):');
{
  const E = (status, body, headers) => { const m = canonicalizeError({ status, bodyText: typeof body === 'string' ? body : JSON.stringify(body), headers, label: 'Acme', contextWindow: 65536, estimate: 70000 }); return [m.status, m.body.error.type, m.body.error.message]; };
  check('context_length_exceeded with numbers', E(400, { error: { code: 'context_length_exceeded', message: "This model's maximum context length is 65536 tokens. However, you requested 70123 tokens (60000 in the messages, 10123 in the completion)." } }),
    [400, 'invalid_request_error', 'provider "Acme": prompt is too long: 70123 tokens > 65536 maximum']);
  check('overflow without numbers -> estimate vs contextWindow', E(400, { error: { message: 'Please reduce the length of the messages.' } }), [400, 'invalid_request_error', 'provider "Acme": prompt is too long: 70000 tokens > 65536 maximum']);
  check('overflow message builder never yields N <= M', overflowMessage('too many tokens', 10, 100), 'prompt is too long: 101 tokens > 100 maximum');
  check('402 -> credit balance (not retried)', E(402, { error: { message: 'Payment required' } }), [400, 'invalid_request_error', 'provider "Acme": Your credit balance is too low (insufficient_quota): Payment required']);
  check('429 insufficient_quota -> credit balance, not a rate limit', E(429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.' } })[1], 'invalid_request_error');
  check('Gemini array body', E(429, [{ error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } }]), [429, 'rate_limit_error', 'provider "Acme": Resource has been exhausted']);
  check('OpenRouter metadata.raw is surfaced', E(502, { error: { message: 'Provider returned error', code: 502, metadata: { raw: 'backend down' } } })[2], 'provider "Acme": Provider returned error (backend down)');
  check('non-JSON body', E(500, '<html>oops</html>'), [500, 'api_error', 'provider "Acme": <html>oops</html>']);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
