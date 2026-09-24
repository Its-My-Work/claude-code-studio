'use strict';
// OpenAI Chat Completions output -> Anthropic Messages events. ONE state machine serves both
// client modes: a streaming client gets the events as SSE frames, a non-streaming client gets
// the Message JSON the aggregator builds from the very same events — so the two paths cannot
// disagree about content, stop reason or usage.
//
// Invariants (pinned by the stream checker in test/llm-bridge-translate.test.js):
//   exactly one message_start; block indexes strictly increasing; at most one block open;
//   every content_block_start has its content_block_stop; a successful stream ends with
//   message_delta (carrying usage) + message_stop; a failed one ends with `error` and no stop.

const { randomAlnum } = require('./util');
const { anthropicToolId, makeSignature } = require('./ids');
const { parseToolArguments } = require('./json-repair');
const { estimateTextTokens } = require('./estimate');

const int = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.max(0, Math.round(Number(v))) : null);
const TAIL = 256;

/** Merge streamed reasoning_details items by (type, index): text/summary/data concatenate, the rest overwrites. */
function mergeDetails(into, items) {
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const key = `${it.type || ''}#${it.index != null ? it.index : into.length}`;
    const prev = into.find((x) => x.__k === key);
    if (!prev) { into.push({ ...it, __k: key }); continue; }
    for (const [k, v] of Object.entries(it)) {
      if ((k === 'text' || k === 'summary' || k === 'data') && typeof v === 'string' && typeof prev[k] === 'string') prev[k] += v;
      else if (v !== undefined && v !== null) prev[k] = v;
    }
  }
}
const cleanDetails = (arr) => arr.map(({ __k, ...rest }) => rest);

/** The shown reasoning text of a delta/message: reasoning_content, reasoning, or the details' text. */
function reasoningOf(d) {
  if (typeof d.reasoning_content === 'string' && d.reasoning_content) return d.reasoning_content;
  if (typeof d.reasoning === 'string' && d.reasoning) return d.reasoning;
  if (!Array.isArray(d.reasoning_details)) return '';
  let s = '';
  for (const x of d.reasoning_details) {
    if (!x || typeof x !== 'object') continue;
    if ((x.type == null || x.type === 'reasoning.text') && typeof x.text === 'string') s += x.text;
    else if (x.type === 'reasoning.summary' && typeof x.summary === 'string') s += x.summary;
    // reasoning.encrypted: never shown, only carried in the signature for the echo
  }
  return s;
}

/**
 * @param {object} o
 * @param {string} o.clientModel      the model name the CLI sent (echoed back, as Anthropic does)
 * @param {string} o.providerId       stamped into thinking signatures
 * @param {Map}    o.toolNames        upstream tool name -> original
 * @param {string[]} o.stopSequences
 * @param {number} o.inputEstimate    calibrated estimate for message_start / missing usage
 * @param {boolean} o.emitThinking    the client asked for thinking
 * @param {(event:string, data:object)=>void} o.sink
 */
function createTranslator(o) {
  const sink = o.sink;
  const toolNames = o.toolNames || new Map();
  const stops = o.stopSequences || [];
  const st = {
    id: `msg_${randomAlnum(24)}`,
    started: false, ended: false, failed: false,
    next: 0, open: null,
    tools: [], byIndex: new Map(), byId: new Map(), lastTool: null,
    emittedTools: 0, invalidArgs: 0, repairedArgs: 0, droppedTools: 0,
    finish: null, matchedStop: null, refusal: false,
    usage: null, tail: '', outChars: 0, sawChunk: false,
  };

  const emit = (event, data) => sink(event, data);

  function start() {
    if (st.started) return;
    st.started = true;
    emit('message_start', {
      type: 'message_start',
      message: {
        id: st.id, type: 'message', role: 'assistant', model: o.clientModel, content: [],
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: o.inputEstimate || 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    emit('ping', { type: 'ping' });
  }

  function closeOpen() {
    if (!st.open) return;
    const { kind, index, details } = st.open;
    if (kind === 'thinking') {
      emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: makeSignature(o.providerId, cleanDetails(details)) } });
    }
    emit('content_block_stop', { type: 'content_block_stop', index });
    st.open = null;
  }

  function openBlock(kind, block) {
    closeOpen();
    const index = st.next++;
    st.open = { kind, index, details: [] };
    emit('content_block_start', { type: 'content_block_start', index, content_block: block });
    return index;
  }

  function thinking(text, details) {
    if (!o.emitThinking) return;
    start();
    // reasoning after the answer began opens a NEW thinking block (interleaved thinking) —
    // dropping it (the reference translator did) loses the model's reasoning about tool results
    if (!st.open || st.open.kind !== 'thinking') openBlock('thinking', { type: 'thinking', thinking: '', signature: '' });
    if (details && details.length) mergeDetails(st.open.details, details);
    if (text) {
      st.outChars += text.length;
      emit('content_block_delta', { type: 'content_block_delta', index: st.open.index, delta: { type: 'thinking_delta', thinking: text } });
    }
  }

  function text(t) {
    start();
    if (!st.open || st.open.kind !== 'text') openBlock('text', { type: 'text', text: '' });
    st.outChars += t.length;
    st.tail = (st.tail + t).slice(-TAIL);
    emit('content_block_delta', { type: 'content_block_delta', index: st.open.index, delta: { type: 'text_delta', text: t } });
  }

  /** Accumulate a streamed tool call. Keyed by index, and by id when the index is missing or reused. */
  function toolDelta(tc) {
    if (!tc || typeof tc !== 'object') return;
    start();
    const idx = Number.isInteger(tc.index) ? tc.index : null;
    const id = typeof tc.id === 'string' && tc.id ? tc.id : null;
    let e = null;
    if (idx !== null) {
      e = st.byIndex.get(idx) || null;
      if (e && id && e.id && e.id !== id) e = null;          // index reused for a new call
      if (!e && id) e = st.byId.get(id) || null;
    } else if (id) {
      e = st.byId.get(id) || null;
    } else {
      e = st.lastTool;                                         // no index, no id: continuation
    }
    if (!e || e.flushed) {
      e = { id: null, name: '', args: '', order: st.tools.length, flushed: false };
      st.tools.push(e);
    }
    if (idx !== null) st.byIndex.set(idx, e);
    if (id && !e.id) { e.id = id; st.byId.set(id, e); }
    const fn = tc.function || {};
    if (typeof fn.name === 'string' && fn.name) {
      // some servers repeat the full name on every chunk; only a longer spelling replaces it
      if (!e.name || (fn.name.length > e.name.length && fn.name.startsWith(e.name))) e.name = fn.name;
    }
    if (typeof fn.arguments === 'string') e.args += fn.arguments;
    else if (fn.arguments && typeof fn.arguments === 'object') e.args = JSON.stringify(fn.arguments);
    st.lastTool = e;
  }

  /** Emit every accumulated tool call as ONE complete block (never partial JSON). */
  function flushTools() {
    const pending = st.tools.filter((t) => !t.flushed);
    if (!pending.length) return;
    closeOpen();
    for (const t of pending) {
      t.flushed = true;
      const parsed = parseToolArguments(t.args);
      if (parsed.invalid && st.finish === 'length') { st.droppedTools++; continue; } // cut off by max_tokens
      if (parsed.invalid) st.invalidArgs++;
      if (parsed.repaired) st.repairedArgs++;
      const index = st.next++;
      const name = toolNames.get(t.name) || t.name || 'unknown_tool';
      emit('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: anthropicToolId(t.id), name, input: {} } });
      emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(parsed.value) } });
      emit('content_block_stop', { type: 'content_block_stop', index });
      st.emittedTools++;
    }
  }

  /** Feed one parsed upstream chunk. Returns {error} for an in-band error chunk (the caller decides how to fail). */
  function chunk(c) {
    if (st.ended || st.failed || !c || typeof c !== 'object') return null;
    st.sawChunk = true;
    // OpenRouter's mid-stream failure carries BOTH `error` and a choice with finish_reason
    // "error"; either one alone means the answer is incomplete and must not end as end_turn.
    if (c.error !== undefined && c.error !== null && c.error !== '') return { error: c.error };
    if (c.usage && typeof c.usage === 'object') st.usage = c.usage;
    const ch = Array.isArray(c.choices) ? c.choices[0] : null;
    if (!ch || typeof ch !== 'object') return null;
    if (ch.finish_reason === 'error') return { error: { message: 'upstream stream ended with finish_reason "error"' } };
    const d = ch.delta || ch.message || {};
    const r = reasoningOf(d);
    const det = Array.isArray(d.reasoning_details) ? d.reasoning_details : null;
    if (r || (det && det.length)) thinking(r, det);
    let content = d.content;
    if (Array.isArray(content)) content = content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
    if (typeof content === 'string' && content) text(content);
    if (typeof d.refusal === 'string' && d.refusal) { text(d.refusal); st.refusal = true; }
    if (Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) toolDelta(tc);
    if (d.function_call && typeof d.function_call === 'object') toolDelta({ index: 0, function: d.function_call });
    if (ch.finish_reason) {
      st.finish = ch.finish_reason;
      const ms = typeof ch.stop_reason === 'string' ? ch.stop_reason : typeof ch.matched_stop === 'string' ? ch.matched_stop : null;
      if (ms) st.matchedStop = ms;
      flushTools();
    }
    return null;
  }

  function stopReason() {
    if (st.emittedTools > 0) return { reason: 'tool_use', seq: null };
    if (st.finish === 'length') return { reason: 'max_tokens', seq: null };
    if (st.finish === 'content_filter' || st.refusal) return { reason: 'refusal', seq: null };
    if (stops.length && (st.finish === 'stop' || st.finish == null)) {
      if (st.matchedStop && stops.includes(st.matchedStop)) return { reason: 'stop_sequence', seq: st.matchedStop };
      const hit = stops.find((s) => st.tail.endsWith(s));
      if (hit) return { reason: 'stop_sequence', seq: hit };
    }
    return { reason: 'end_turn', seq: null };
  }

  /** Usage in Anthropic terms, plus what the usage record needs. Estimates fill what the upstream omitted. */
  function usage() {
    const u = st.usage || {};
    const ptd = u.prompt_tokens_details || {};
    const prompt = int(u.prompt_tokens != null ? u.prompt_tokens : u.input_tokens);
    const cached = int(ptd.cached_tokens != null ? ptd.cached_tokens : u.prompt_cache_hit_tokens != null ? u.prompt_cache_hit_tokens : u.cache_read_input_tokens) || 0;
    const cacheWrite = int(ptd.cache_write_tokens != null ? ptd.cache_write_tokens : u.cache_creation_input_tokens) || 0;
    const completion = int(u.completion_tokens != null ? u.completion_tokens : u.output_tokens);
    const ctd = u.completion_tokens_details || {};
    const reasoning = int(ctd.reasoning_tokens != null ? ctd.reasoning_tokens : u.reasoning_tokens) || 0;
    const estimatedInput = prompt == null;
    const totalIn = estimatedInput ? (o.inputEstimate || 1) : prompt;
    return {
      input: Math.max(0, totalIn - cached - cacheWrite),
      output: completion == null ? estimateTextTokens(st.outChars + st.tools.reduce((n, t) => n + t.args.length, 0)) : completion,
      cacheRead: cached, cacheWrite, reasoning,
      promptTotal: estimatedInput ? null : prompt,
      estimated: estimatedInput || completion == null,
    };
  }

  /** The upstream finished normally: flush, close, message_delta + message_stop. */
  function end() {
    if (st.ended || st.failed) return;
    start();
    flushTools();
    closeOpen();
    st.ended = true;
    const u = usage();
    const sr = stopReason();
    emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: sr.reason, stop_sequence: sr.seq },
      usage: { input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheWrite },
    });
    emit('message_stop', { type: 'message_stop' });
  }

  /** The stream failed after it started: close the open block, `error`, and no message_stop. */
  function fail(type, message) {
    if (st.ended || st.failed) return;
    st.failed = true;
    if (st.started) closeOpen();
    emit('error', { type: 'error', error: { type, message } });
  }

  return {
    start, chunk, end, fail, usage,
    stopReason: () => stopReason().reason,
    get started() { return st.started; },
    get finished() { return st.ended || st.failed; },
    get sawChunk() { return st.sawChunk; },
    stats: () => ({ tools: st.emittedTools, invalidArgs: st.invalidArgs, repairedArgs: st.repairedArgs, droppedTools: st.droppedTools, finish: st.finish }),
  };
}

/** A non-stream OpenAI response -> one synthetic chunk the translator understands. */
function completionToChunk(json) {
  const ch = (json && Array.isArray(json.choices) && json.choices[0]) || {};
  const m = ch.message || {};
  return {
    choices: [{
      delta: {
        content: m.content, reasoning_content: m.reasoning_content, reasoning: m.reasoning,
        reasoning_details: m.reasoning_details, refusal: m.refusal, function_call: m.function_call,
        tool_calls: Array.isArray(m.tool_calls) ? m.tool_calls.map((t, i) => ({ ...t, index: i })) : undefined,
      },
      finish_reason: ch.finish_reason || 'stop',
      stop_reason: ch.stop_reason, matched_stop: ch.matched_stop,
    }],
    usage: json && json.usage,
  };
}

/** Builds the Anthropic Message JSON from the event sequence (the non-stream client path). */
function createAggregator() {
  const msg = { id: null, type: 'message', role: 'assistant', model: null, content: [], stop_reason: null, stop_sequence: null, usage: {} };
  const blocks = new Map();
  let error = null;
  return {
    event(name, d) {
      switch (name) {
        case 'message_start':
          msg.id = d.message.id; msg.model = d.message.model; msg.usage = { ...d.message.usage };
          break;
        case 'content_block_start': {
          const b = { ...d.content_block };
          if (b.type === 'tool_use') b.__json = '';
          blocks.set(d.index, b);
          break;
        }
        case 'content_block_delta': {
          const b = blocks.get(d.index);
          if (!b) break;
          const x = d.delta;
          if (x.type === 'text_delta') b.text += x.text;
          else if (x.type === 'thinking_delta') b.thinking += x.thinking;
          else if (x.type === 'signature_delta') b.signature = x.signature;
          else if (x.type === 'input_json_delta') b.__json += x.partial_json;
          break;
        }
        case 'content_block_stop': {
          const b = blocks.get(d.index);
          if (b && b.type === 'tool_use') {
            try { b.input = b.__json ? JSON.parse(b.__json) : {}; } catch { b.input = {}; }
            delete b.__json;
          }
          break;
        }
        case 'message_delta':
          msg.stop_reason = d.delta.stop_reason; msg.stop_sequence = d.delta.stop_sequence;
          msg.usage = { ...msg.usage, ...d.usage };
          break;
        case 'error': error = d.error; break;
        default: break;
      }
    },
    get error() { return error; },
    message() {
      msg.content = [...blocks.keys()].sort((a, b) => a - b).map((k) => blocks.get(k));
      return msg;
    },
  };
}

module.exports = { createTranslator, createAggregator, completionToChunk, reasoningOf, mergeDetails };
