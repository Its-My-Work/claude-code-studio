'use strict';
// Input-token estimate for requests to providers we cannot tokenize for: message_start's
// input_tokens (the CLI's context meter reads it), count_tokens, and usage when the upstream
// never reports any. chars/3.6 is a middle ground between English prose (~4) and code/JSON (~3).
// A per-session EMA of real/estimated then corrects it once real usage has been seen.

const CHARS_PER_TOKEN = 3.6;
const IMAGE_TOKENS = 1600;
const PER_MESSAGE = 3;

function charsOfBlock(b) {
  if (!b || typeof b !== 'object') return typeof b === 'string' ? b.length : 0;
  switch (b.type) {
    case 'text': return (b.text || '').length;
    case 'thinking': return (b.thinking || '').length;
    case 'tool_use': return (b.name || '').length + JSON.stringify(b.input || {}).length;
    case 'tool_result': return charsOfContent(b.content);
    case 'image': case 'document': return 0; // counted as images below
    default: return JSON.stringify(b).length;
  }
}

function charsOfContent(c) {
  if (typeof c === 'string') return c.length;
  if (!Array.isArray(c)) return 0;
  let n = 0;
  for (const b of c) n += charsOfBlock(b);
  return n;
}

function imagesOf(c) {
  if (!Array.isArray(c)) return 0;
  let n = 0;
  for (const b of c) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'image' || b.type === 'document') n++;
    else if (b.type === 'tool_result') n += imagesOf(b.content);
  }
  return n;
}

/** Raw (uncalibrated) estimate of an Anthropic Messages request body. */
function estimateInputTokens(body) {
  if (!body || typeof body !== 'object') return 1;
  let chars = 0, images = 0;
  const sys = body.system;
  if (typeof sys === 'string') chars += sys.length;
  else if (Array.isArray(sys)) chars += charsOfContent(sys);
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    chars += charsOfContent(m.content);
    images += imagesOf(m.content);
  }
  if (Array.isArray(body.tools)) for (const t of body.tools) chars += JSON.stringify(t || {}).length;
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS + PER_MESSAGE * msgs.length);
}

/** Output-token estimate from produced text (used only when the upstream reports no usage). */
const estimateTextTokens = (chars) => Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));

/**
 * Per-key calibration. `key` is the CLI session id (x-claude-code-session-id) or the run id, so the
 * correction learned on one conversation's real usage applies to its next request.
 */
function createCalibrator({ max = 500, alpha = 0.3 } = {}) {
  const ratios = new Map();
  return {
    apply(key, raw) {
      const r = key != null ? ratios.get(key) : undefined;
      return Math.max(1, Math.round(r ? raw * r : raw));
    },
    observe(key, raw, real) {
      if (key == null || !(raw > 0) || !(real > 0)) return;
      const ratio = Math.min(3, Math.max(0.3, real / raw));
      const prev = ratios.get(key);
      ratios.delete(key); // re-insert = most recently used at the end
      ratios.set(key, prev ? prev * (1 - alpha) + ratio * alpha : ratio);
      if (ratios.size > max) ratios.delete(ratios.keys().next().value);
    },
    ratio: (key) => ratios.get(key) || null,
  };
}

module.exports = { estimateInputTokens, estimateTextTokens, createCalibrator, CHARS_PER_TOKEN, IMAGE_TOKENS };
