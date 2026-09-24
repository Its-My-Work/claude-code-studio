'use strict';
// Tool-call arguments from OpenAI-style models are a JSON STRING the model typed, and weaker
// models get it wrong: trailing commas, a stream cut short, JSON wrapped in a JSON string, the
// whole object sent twice. Silently turning that into {} (what the reference translator did)
// runs the tool with no arguments; the CLI then reports a confusing failure, or worse, succeeds
// at the wrong thing. We repair what is unambiguous and otherwise hand the CLI an input that
// fails its schema validation — the model then sees a clear error and retries.

const MAX_RAW = 2000;

function tryParse(s) {
  try { return { ok: true, v: JSON.parse(s) }; } catch { return { ok: false }; }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Index just past the first balanced top-level {...} in `s`, or -1. */
function firstObjectEnd(s) {
  let depth = 0, inStr = false, esc = false, started = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') { depth++; started = true; }
    else if (c === '}' || c === ']') { depth--; if (started && depth === 0) return i + 1; }
  }
  return -1;
}

/** Close unterminated strings/objects/arrays (a truncated stream) and drop dangling commas. */
function closeUnbalanced(s) {
  const stack = [];
  let inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') { if (stack[stack.length - 1] === c) stack.pop(); }
  }
  let out = s;
  if (inStr) out += esc ? '\\"' : '"';
  out = out.replace(/[\s,]+$/, '').replace(/:\s*$/, ': null');
  while (stack.length) out += stack.pop();
  return out;
}

const stripTrailingCommas = (s) => s.replace(/,(\s*[}\]])/g, '$1');

/**
 * -> { value: object, repaired: bool, invalid: bool }. `value` is always a plain object; an
 * unrepairable input becomes {"__invalid_arguments": "<raw, truncated>"}.
 */
function parseToolArguments(raw) {
  if (isObj(raw)) return { value: raw, repaired: false, invalid: false };
  const s0 = raw == null ? '' : String(raw).trim();
  if (!s0) return { value: {}, repaired: false, invalid: false }; // a tool with no parameters

  let p = tryParse(s0);
  if (p.ok && isObj(p.v)) return { value: p.v, repaired: false, invalid: false };
  // JSON inside a JSON string: "{\"a\":1}"
  if (p.ok && typeof p.v === 'string') {
    const inner = tryParse(p.v.trim());
    if (inner.ok && isObj(inner.v)) return { value: inner.v, repaired: true, invalid: false };
  }

  const candidates = [];
  let s = s0.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  candidates.push(s);
  // The same object twice ("{..}{..}") or an object followed by junk: keep the first object.
  const end = firstObjectEnd(s);
  if (end > 0 && end < s.length) candidates.push(s.slice(0, end));
  candidates.push(stripTrailingCommas(s));
  candidates.push(stripTrailingCommas(closeUnbalanced(s)));
  for (const c of candidates) {
    p = tryParse(c);
    if (p.ok && isObj(p.v)) return { value: p.v, repaired: true, invalid: false };
  }
  return { value: { __invalid_arguments: s0.slice(0, MAX_RAW) }, repaired: false, invalid: true };
}

module.exports = { parseToolArguments };
