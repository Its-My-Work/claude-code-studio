'use strict';
// Small shared helpers for the LLM bridge. Pure, no I/O.

const crypto = require('crypto');

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** `n` random alphanumerics (ids the CLI shows or stores, never secrets). */
function randomAlnum(n) {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALNUM[bytes[i] % ALNUM.length];
  return s;
}

/** Deterministic alphanumerics derived from `input` (base62 of sha1) — same input, same output. */
function hashAlnum(input, n) {
  let h = crypto.createHash('sha1').update(String(input)).digest();
  let s = '';
  while (s.length < n) {
    for (const b of h) { s += ALNUM[b % ALNUM.length]; if (s.length >= n) break; }
    h = crypto.createHash('sha1').update(h).digest();
  }
  return s;
}

const sha1hex = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep merge for plain objects (arrays and scalars in `src` replace). Returns a new object. */
function deepMerge(dst, src) {
  if (!isPlainObject(src)) return dst;
  const out = isPlainObject(dst) ? { ...dst } : {};
  for (const [k, v] of Object.entries(src)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/** Anthropic HTTP status -> error type (the shape the CLI's SDK understands). */
const STATUS_ERROR_TYPE = {
  400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error',
  404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error',
  500: 'api_error', 502: 'api_error', 503: 'overloaded_error', 504: 'api_error', 529: 'overloaded_error',
};
const errorTypeFor = (status) => STATUS_ERROR_TYPE[status] || (status >= 500 ? 'api_error' : 'invalid_request_error');

/** `{"type":"error","error":{type,message}}` — every error the bridge itself produces has this shape. */
function anthropicError(type, message) {
  return { type: 'error', error: { type, message: String(message) } };
}

/** One SSE frame in the Anthropic event format. */
function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Plain text of a system value / tool_result content / text-block list. Non-text blocks are ignored. */
function textOf(content, sep = '\n\n') {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (typeof b === 'string') parts.push(b);
    else if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.filter(Boolean).join(sep);
}

/** Claude-looking model id — the CLI's own defaults for side calls and subagents look like this. */
const CLAUDE_LIKE_RE = /claude|haiku|sonnet|opus|fable/i;

module.exports = {
  randomAlnum, hashAlnum, sha1hex, sha256hex, isPlainObject, deepMerge,
  STATUS_ERROR_TYPE, errorTypeFor, anthropicError, sseFrame, sleep, textOf, CLAUDE_LIKE_RE,
};
