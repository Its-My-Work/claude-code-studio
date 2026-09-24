'use strict';
// Anthropic Messages request -> OpenAI Chat Completions request. Pure: (body, run context,
// dialect) in, upstream body out. No I/O, so every rule here is pinned by
// test/llm-bridge-translate.test.js without a server.
//
// The upstream body is built FROM SCRATCH (never by copying the Anthropic body), so an Anthropic
// field we do not understand can never leak through and 400 an OpenAI validator:
// context_management, container, mcp_servers, service_tier, citations and output_config (after its
// effort is read) are simply never copied.

const { textOf, sha256hex, deepMerge, isPlainObject } = require('./util');
const { upstreamToolName, toolNameReverseMap, upstreamToolId, readSignature } = require('./ids');
const { sanitizeSchema } = require('./schema');
const { effectiveEffort, clampMaxTokens } = require('./models');

class BadRequest extends Error {}

const BILLING_RE = /^\s*x-anthropic-billing-header:/;
const IMAGE_OMITTED = '[image omitted: this model does not accept images]';
const PDF_OMITTED = '[PDF document omitted: this model cannot read PDF files directly. If you need its contents, '
  + 'extract the text from the original file with a shell tool (for example `pdftotext file.pdf -`) and read that.]';
const NO_OUTPUT = '(no output)';
const INTERRUPTED = '(no result: the tool call was interrupted before it returned)';
const QWEN_BUDGET = { low: 2048, medium: 8192, high: 16384, xhigh: 32768 };

// ------------------------------------------------------------------ content --

function makeEnv(ctx, dialect, caps) {
  return {
    dialect, caps,
    providerId: ctx && ctx.provider ? ctx.provider.id : '',
    vision: caps.vision !== false,
    pdf: dialect.fileParts && caps.pdf !== false,
    idStyle: dialect.toolIdStyle,
  };
}

function textPart(text, block, env) {
  const p = { type: 'text', text };
  if (env.dialect.cacheControl && block && block.cache_control) p.cache_control = block.cache_control;
  return p;
}

function imageUrl(block) {
  const src = block && block.source;
  if (!src || typeof src !== 'object') return null;
  if (src.type === 'base64' && src.data) return `data:${src.media_type || 'image/png'};base64,${src.data}`;
  if (src.type === 'url' && src.url) return src.url;
  return null; // Files-API ids and unknown sources cannot be expressed upstream
}

/** An image block -> an image_url part, or a text placeholder when the model cannot see it. */
function imagePart(block, env) {
  const url = imageUrl(block);
  if (!env.vision) return textPart(IMAGE_OMITTED, block, env);
  if (!url) return textPart('[image omitted: unsupported image source]', block, env);
  const p = { type: 'image_url', image_url: { url } };
  if (env.dialect.cacheControl && block.cache_control) p.cache_control = block.cache_control;
  return p;
}

/** A document block -> file part (PDF, when the dialect can), text, or a placeholder. Never a 400. */
function documentPart(block, env) {
  const src = (block && block.source) || {};
  const title = typeof block.title === 'string' && block.title ? `${block.title}\n\n` : '';
  if (src.type === 'text' && typeof src.data === 'string') return textPart(title + src.data, block, env);
  if (src.type === 'content') return textPart(title + textOf(src.content), block, env);
  if (src.type === 'base64' && /pdf/i.test(src.media_type || 'application/pdf') && src.data) {
    if (env.pdf) return { type: 'file', file: { filename: 'document.pdf', file_data: `data:application/pdf;base64,${src.data}` } };
    return textPart(PDF_OMITTED, block, env);
  }
  if (src.type === 'url' && src.url) return textPart(`[document at ${src.url} omitted: fetch it with a tool if you need its contents]`, block, env);
  return textPart('[document omitted: unsupported document source]', block, env);
}

/** A search_result block (tool output of search tools) as plain text. */
function searchResultText(b) {
  const head = [b.title, b.source].filter((s) => typeof s === 'string' && s).join(' — ');
  return [head, textOf(b.content)].filter(Boolean).join('\n');
}

/** Consecutive text-only parts collapse to a string (what every provider accepts). */
function collapse(parts) {
  if (parts.every((p) => p.type === 'text' && !p.cache_control)) return parts.map((p) => p.text).join('\n\n');
  return parts;
}

/**
 * A tool_result block -> { msg: {role:'tool'}, images: [user parts] }. Images cannot go in a tool
 * message (OpenAI tool content is text), so they ride in a user message right after; the reference
 * translator dropped them, which blinded the model on every screenshot tool.
 */
function toolResult(b, env) {
  const texts = [];
  const images = [];
  const c = b.content;
  if (typeof c === 'string') texts.push(c);
  else if (Array.isArray(c)) {
    for (const x of c) {
      if (!x || typeof x !== 'object') continue;
      if (x.type === 'text' && typeof x.text === 'string') texts.push(x.text);
      else if (x.type === 'image') {
        if (env.vision && imageUrl(x)) images.push(imagePart(x, env));
        else texts.push(env.vision ? '[image omitted: unsupported image source]' : IMAGE_OMITTED);
      } else if (x.type === 'document') {
        const d = documentPart(x, env);
        if (d.type === 'text') texts.push(d.text); else images.push(d);
      } else if (x.type === 'search_result') texts.push(searchResultText(x));
      else if (x.type === 'tool_reference' && x.tool_name) texts.push(`[tool loaded: ${x.tool_name}]`);
      else if (typeof x.text === 'string') texts.push(x.text);
    }
  }
  let text = texts.filter(Boolean).join('\n\n');
  if (!text) text = images.length ? '(the output is the image attached in the next message)' : NO_OUTPUT;
  if (b.is_error) text = `[tool error] ${text}`;
  const msg = { role: 'tool', tool_call_id: upstreamToolId(b.tool_use_id, env.idStyle), content: text };
  if (!images.length) return { msg, userParts: [] };
  const kind = images.every((p) => p.type === 'image_url') ? 'image' : 'attachment';
  const label = `[${kind} from tool result${b.tool_use_id ? ` ${b.tool_use_id}` : ''}]`;
  return { msg, userParts: [{ type: 'text', text: label }, ...images] };
}

function convertUser(content, env) {
  if (typeof content === 'string') return content ? [{ role: 'user', content }] : [];
  if (!Array.isArray(content)) return [];
  const toolMsgs = [];
  const toolParts = [];
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') { if (typeof b === 'string' && b) parts.push(textPart(b, null, env)); continue; }
    switch (b.type) {
      case 'text': if (typeof b.text === 'string' && b.text) parts.push(textPart(b.text, b, env)); break;
      case 'image': parts.push(imagePart(b, env)); break;
      case 'document': parts.push(documentPart(b, env)); break;
      case 'tool_result': { const r = toolResult(b, env); toolMsgs.push(r.msg); toolParts.push(...r.userParts); break; }
      case 'search_result': parts.push(textPart(searchResultText(b), b, env)); break;
      case 'thinking': case 'redacted_thinking': break; // never valid in a user turn
      default: if (typeof b.text === 'string' && b.text) parts.push(textPart(b.text, b, env));
    }
  }
  // tool messages must directly follow the assistant's tool_calls, so they go first
  const out = [...toolMsgs];
  const userParts = [...toolParts, ...parts];
  if (userParts.length) out.push({ role: 'user', content: collapse(userParts) });
  return out;
}

function convertAssistant(content, env) {
  if (typeof content === 'string') return content ? [{ role: 'assistant', content }] : [];
  if (!Array.isArray(content)) return [];
  const texts = [];
  const toolCalls = [];
  const reasoning = [];
  const details = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string' && b.text) texts.push(b.text);
    else if (b.type === 'tool_use') {
      let args;
      try { args = JSON.stringify(b.input == null ? {} : b.input); } catch { args = '{}'; }
      toolCalls.push({ id: upstreamToolId(b.id, env.idStyle), type: 'function', function: { name: upstreamToolName(b.name), arguments: args } });
    } else if (b.type === 'thinking') {
      // Only reasoning THIS provider produced goes back (its own signature). A real Anthropic
      // signature or another provider's reasoning means nothing here, so it is dropped.
      const sig = readSignature(b.signature);
      if (sig && sig.p === env.providerId) {
        if (typeof b.thinking === 'string' && b.thinking) reasoning.push(b.thinking);
        if (Array.isArray(sig.d)) details.push(...sig.d);
      }
    }
    // redacted_thinking, server_tool_use, web_search_tool_result, …: nothing an OpenAI model can take
  }
  if (!texts.length && !toolCalls.length) return [];
  const msg = { role: 'assistant', content: texts.length ? texts.join('\n\n') : null };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  const echo = env.dialect.reasoningEcho;
  if (echo === 'reasoning_content' && reasoning.length) msg.reasoning_content = reasoning.join('');
  else if (echo === 'reasoning_details' && (details.length || reasoning.length)) {
    msg.reasoning_details = details.length ? details : [{ type: 'reasoning.text', text: reasoning.join(''), index: 0 }];
  }
  return [msg];
}

// ------------------------------------------------------------- history repair --

/**
 * OpenAI rejects a tool message that does not answer the assistant turn right before it, and an
 * assistant tool_call left without an answer. Anthropic histories can have both (an interrupted
 * turn, a compaction that cut between the two), so: answer the unanswered, demote the orphaned.
 */
function repairToolPairs(msgs) {
  const demote = (t) => ({ role: 'user', content: `[result of tool call ${t.tool_call_id}]\n${t.content}` });
  const out = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'tool') { out.push(demote(m)); continue; } // answers nothing before it
    out.push(m);
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    const want = new Set(m.tool_calls.map((t) => t.id));
    const demoted = [];
    let j = i + 1;
    for (; j < msgs.length && msgs[j].role === 'tool'; j++) {
      const t = msgs[j];
      if (want.has(t.tool_call_id)) { want.delete(t.tool_call_id); out.push(t); } else demoted.push(demote(t));
    }
    for (const id of want) out.push({ role: 'tool', tool_call_id: id, content: INTERRUPTED });
    out.push(...demoted); // after the whole tool run, so no user message splits it
    i = j - 1;
  }
  return out;
}

const asParts = (c) => (typeof c === 'string' ? (c ? [{ type: 'text', text: c }] : []) : Array.isArray(c) ? c : []);

/** Merge adjacent same-role user/assistant messages — strict providers require alternation. */
function mergeAdjacent(msgs) {
  const out = [];
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role && m.role === 'user') {
      prev.content = typeof prev.content === 'string' && typeof m.content === 'string'
        ? [prev.content, m.content].filter(Boolean).join('\n\n')
        : collapse([...asParts(prev.content), ...asParts(m.content)]);
      continue;
    }
    if (prev && prev.role === m.role && m.role === 'assistant' && !prev.tool_calls) {
      prev.content = [prev.content, m.content].filter(Boolean).join('\n\n') || null;
      if (m.tool_calls) prev.tool_calls = m.tool_calls;
      if (m.reasoning_content) prev.reasoning_content = (prev.reasoning_content || '') + m.reasoning_content;
      if (m.reasoning_details) prev.reasoning_details = [...(prev.reasoning_details || []), ...m.reasoning_details];
      continue;
    }
    out.push({ ...m });
  }
  return out;
}

/** Mistral: "Unexpected role 'user' after role 'tool'" — fold such text into the last tool message. */
function foldUserAfterTool(msgs) {
  const out = [];
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (prev && prev.role === 'tool' && m.role === 'user' && typeof m.content === 'string') {
      prev.content = `${prev.content}\n\n${m.content}`;
      continue;
    }
    out.push(m);
  }
  return out;
}

// -------------------------------------------------------------------- tools --

function convertTools(tools, dialect) {
  const out = [];
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!t || typeof t !== 'object' || !t.name) continue;
    if (t.type !== undefined && t.type !== null && t.type !== 'custom') continue; // server tools (web_search_*, bash_*, …)
    out.push({
      type: 'function',
      function: {
        name: upstreamToolName(t.name),
        description: typeof t.description === 'string' ? t.description : '',
        parameters: sanitizeSchema(t.input_schema, dialect.schemaSanitize),
      },
    });
  }
  return out;
}

function convertToolChoice(choice) {
  if (!choice || typeof choice !== 'object') return { choice: undefined, parallel: undefined };
  const parallel = choice.disable_parallel_tool_use === true ? false : undefined;
  switch (choice.type) {
    case 'auto': return { choice: 'auto', parallel };
    case 'any': return { choice: 'required', parallel };
    case 'none': return { choice: 'none', parallel };
    case 'tool': return choice.name ? { choice: { type: 'function', function: { name: upstreamToolName(choice.name) } }, parallel } : { choice: undefined, parallel };
    default: return { choice: undefined, parallel };
  }
}

// ------------------------------------------------------------------- effort --

/** Writes the dialect's effort parameter into `up`. Returns true when reasoning is ON. */
function applyEffort(up, effort, dialect, caps) {
  if (effort == null || caps.reasoning === false) return false;
  if (dialect.effortRequiresCaps && caps.reasoning !== true) return false;
  const v = dialect.effortMap ? dialect.effortMap[effort] : undefined;
  switch (dialect.effortParam) {
    case 'reasoning_effort':
      if (!v) return false;
      up.reasoning_effort = v;
      return v !== 'none';
    case 'reasoning':
      if (effort === 'none' || v === 'none') { up.reasoning = { enabled: false }; return false; }
      if (!v) return false;
      up.reasoning = { effort: v };
      return true;
    case 'thinking':
      up.thinking = { type: effort === 'none' ? 'disabled' : 'enabled' };
      return effort !== 'none';
    case 'enable_thinking':
      if (effort === 'none') { up.enable_thinking = false; return false; }
      up.enable_thinking = true;
      up.thinking_budget = effort === 'max' ? (caps.maxOutput || 32768) : QWEN_BUDGET[effort] || QWEN_BUDGET.medium;
      return true;
    default:
      return false;
  }
}

// --------------------------------------------------------------------- main --

/**
 * @returns {{ body, upstreamStream, toolNames: Map, stopSequences: string[], emitThinking, effort, reasoningOn }}
 * @throws BadRequest on a body that cannot be a Messages request at all
 */
function toOpenAI(body, { ctx, dialect, upstreamModel, caps }) {
  if (!isPlainObject(body)) throw new BadRequest('request body must be a JSON object');
  if (!Array.isArray(body.messages)) throw new BadRequest('messages: field required (a list)');
  const env = makeEnv(ctx, dialect, caps);

  // system: top-level (string or text blocks) minus the per-request billing header, which varies
  // on every call and would defeat the provider's prefix cache from byte one
  let sysBlocks = typeof body.system === 'string'
    ? [{ type: 'text', text: body.system }]
    : (Array.isArray(body.system) ? body.system : []).filter((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text);
  if (sysBlocks.length && BILLING_RE.test(sysBlocks[0].text)) sysBlocks = sysBlocks.slice(1);

  const msgs = [];
  let seenAssistant = false;
  for (let i = 0; i < body.messages.length; i++) {
    const m = body.messages[i];
    if (!m || typeof m !== 'object') throw new BadRequest(`messages.${i}: must be an object`);
    if (m.role === 'system') {
      // CLI 2.1.197+ puts context (environment, token budget) in system-role entries INSIDE messages
      const t = textOf(m.content);
      if (!t) continue;
      if (dialect.systemFold === 'all' || !seenAssistant) sysBlocks.push({ type: 'text', text: t });
      else msgs.push({ role: 'user', content: /^\s*</.test(t) ? t : `<system-reminder>\n${t}\n</system-reminder>` });
      continue;
    }
    if (m.role === 'assistant') { seenAssistant = true; msgs.push(...convertAssistant(m.content, env)); continue; }
    if (m.role === 'user') { msgs.push(...convertUser(m.content, env)); continue; }
    throw new BadRequest(`messages.${i}.role: must be 'user', 'assistant' or 'system' (got ${JSON.stringify(m.role)})`);
  }

  let history = mergeAdjacent(repairToolPairs(msgs));
  if (dialect.noUserAfterTool) history = foldUserAfterTool(history);
  const messages = [];
  if (sysBlocks.length) {
    const cached = dialect.cacheControl && sysBlocks.some((b) => b.cache_control);
    messages.push({
      role: 'system',
      content: cached ? sysBlocks.map((b) => textPart(b.text, b, env)) : sysBlocks.map((b) => b.text).join('\n\n'),
    });
  }
  messages.push(...history);
  if (!history.length) throw new BadRequest('messages: no usable content');

  const up = { model: upstreamModel, messages };

  const maxTokens = clampMaxTokens(body.max_tokens, caps);
  if (maxTokens) up[dialect.maxTokensField] = maxTokens;

  const effort = effectiveEffort(ctx, body);
  const reasoningOn = applyEffort(up, effort, dialect, caps);

  const dropSampling = reasoningOn && dialect.dropSamplingWithReasoning;
  if (typeof body.temperature === 'number' && !dropSampling) up.temperature = body.temperature;
  if (typeof body.top_p === 'number' && !dropSampling) up.top_p = body.top_p;
  if (dialect.allowTopK && Number.isInteger(body.top_k)) up.top_k = body.top_k;
  const stopSequences = Array.isArray(body.stop_sequences) ? body.stop_sequences.filter((s) => typeof s === 'string' && s).slice(0, 4) : [];
  if (stopSequences.length) up.stop = stopSequences;

  const tools = caps.tools === false ? [] : convertTools(body.tools, dialect);
  if (tools.length) {
    up.tools = tools;
    const { choice, parallel } = convertToolChoice(body.tool_choice);
    if (choice !== undefined) up.tool_choice = choice;
    if (parallel !== undefined) up.parallel_tool_calls = parallel;
  }

  const uid = body.metadata && body.metadata.user_id;
  if (dialect.sendUser && typeof uid === 'string' && uid) up.user = sha256hex(uid).slice(0, 32);

  // structured output (`--json-schema`): Anthropic output_config.format -> OpenAI response_format
  const fmt = body.output_config && body.output_config.format;
  if (fmt && fmt.type === 'json_schema' && isPlainObject(fmt.schema)) {
    up.response_format = { type: 'json_schema', json_schema: { name: 'output', schema: sanitizeSchema(fmt.schema, dialect.schemaSanitize) } };
  }

  const upstreamStream = dialect.upstreamStream !== false;
  if (upstreamStream) {
    up.stream = true;
    if (dialect.streamUsage) up.stream_options = { include_usage: true };
  }
  if (dialect.usageInclude) up.usage = { include: true };

  const extra = ctx && ctx.provider && ctx.provider.options && ctx.provider.options.extraBody;
  const final = isPlainObject(extra) ? deepMerge(up, extra) : up;

  const t = body.thinking;
  return {
    body: final,
    upstreamStream,
    toolNames: toolNameReverseMap(body),
    stopSequences,
    emitThinking: !!(t && (t.type === 'enabled' || t.type === 'adaptive')),
    effort,
    reasoningOn,
  };
}

module.exports = { toOpenAI, BadRequest, applyEffort, convertTools, IMAGE_OMITTED, PDF_OMITTED, NO_OUTPUT, INTERRUPTED };
