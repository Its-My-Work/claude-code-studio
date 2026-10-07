'use strict';
// Upstream OpenAI-style error -> the Anthropic HTTP error Claude Code knows how to act on.
// The CLI's behaviour hangs on status + type + a few exact phrases, so this is where a provider
// failure becomes the right CLI reaction:
//   "prompt is too long: N tokens > M maximum" (400)  -> the CLI compacts / trims instead of dying
//   credit balance too low (400)                      -> the CLI stops, no retry; the studio sees a usage limit
//   429 / 5xx / 529                                   -> the CLI's own retry-with-backoff
// Every message names the provider, so a failure is never mistaken for Anthropic's own.

const { anthropicError, errorTypeFor } = require('./util');

const OVERFLOW_RE = /context[ _-]?length|maximum context|context window|too many tokens|prompt is too long|reduce the length|input is too long|exceeds? the (?:model'?s? )?(?:maximum )?(?:context|token limit)/i;
const QUOTA_RE = /insufficient[_ ]quota|insufficient[_ ]balance|out of credits|requires more credits|billing|credit balance is too low/i;

const prefix = (label) => `provider "${label}": `;

/** Pull {message, code, status} out of the many error body shapes providers use. */
function parseErrorBody(text) {
  let j = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (Array.isArray(j)) j = j[0]; // Gemini's compat layer answers [{error:{…}}]
  let err = j && typeof j === 'object' ? (j.error !== undefined ? j.error : j) : null;
  let message = '';
  let code = null;
  if (typeof err === 'string') message = err;
  else if (err && typeof err === 'object') {
    message = err.message || err.msg || err.detail || (j && j.message) || '';
    code = err.code != null ? err.code : (err.type || err.status || null);
    // OpenRouter wraps the real provider error: {message:"Provider returned error", metadata:{raw:"…"}}
    const raw = err.metadata && err.metadata.raw;
    if (raw) message = `${message} (${String(typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 600)})`;
  }
  if (!message && typeof text === 'string') message = text.trim().slice(0, 500);
  if (typeof message !== 'string') message = JSON.stringify(message);
  return { message: message.slice(0, 2000), code: code == null ? null : String(code) };
}

const toInt = (s) => Number(String(s).replace(/[,_\s]/g, ''));

/** "prompt is too long: N tokens > M maximum" — numbers from the upstream text when it has them. */
function overflowMessage(message, estimate, contextWindow) {
  let n = null;
  let m = null;
  const pairs = [
    [/(\d[\d,]*)\s*tokens?\s*>\s*(\d[\d,]*)/i, 1, 2],
    [/maximum context length is (\d[\d,]*)[\s\S]*?(?:requested|resulted in|have|contains?) (\d[\d,]*)/i, 2, 1],
    [/(?:requested|input of|input length|prompt has|contains?) (\d[\d,]*)[\s\S]*?(?:maximum|limit|context window|context length)[^\d]{0,30}(\d[\d,]*)/i, 1, 2],
  ];
  for (const [re, ni, mi] of pairs) {
    const x = re.exec(message);
    if (x) { n = toInt(x[ni]); m = toInt(x[mi]); break; }
  }
  if (!(n > 0 && m > 0)) {
    const nums = (message.match(/\d[\d,]{2,}/g) || []).map(toInt).filter((v) => v >= 1000);
    if (nums.length >= 2) { n = Math.max(...nums); m = Math.min(...nums); }
    else {
      m = contextWindow || (nums[0] || null);
      n = estimate || null;
    }
  }
  if (!(m > 0)) m = Math.max(1, (n || 2) - 1);
  if (!(n > m)) n = m + 1; // the CLI computes how much to drop from N - M; it must be positive
  return `prompt is too long: ${n} tokens > ${m} maximum`;
}

/**
 * @param {{status:number, bodyText:string, headers?:object, label:string, contextWindow?:number, estimate?:number}} o
 * @returns {{status:number, body:object, headers:object, errorType:string}}
 */
function canonicalizeError({ status, bodyText, headers = {}, label, contextWindow = null, estimate = null }) {
  const { message, code } = parseErrorBody(bodyText == null ? '' : String(bodyText));
  const msg = message || `HTTP ${status}`;
  const out = (st, type, text, extra = {}) => ({ status: st, body: anthropicError(type, prefix(label) + text), headers: extra, errorType: type });

  if (code === 'context_length_exceeded' || OVERFLOW_RE.test(msg)) {
    return out(400, 'invalid_request_error', overflowMessage(msg, estimate, contextWindow));
  }
  if (status === 402 || QUOTA_RE.test(`${code || ''} ${msg}`)) {
    return out(400, 'invalid_request_error', `Your credit balance is too low (insufficient_quota): ${msg}`);
  }
  const retryAfter = headers['retry-after'];
  switch (status) {
    case 401: return out(401, 'authentication_error', `invalid api key (${msg})`);
    case 403: return out(403, 'permission_error', msg);
    case 404: return out(404, 'not_found_error', msg);
    case 413: return out(413, 'request_too_large', msg);
    case 429: return out(429, 'rate_limit_error', msg, retryAfter ? { 'retry-after': retryAfter } : {});
    case 400: case 422: return out(400, 'invalid_request_error', msg);
    case 500: case 502: case 504: return out(status, 'api_error', msg);
    case 503: case 529: return out(529, 'overloaded_error', msg);
    default:
      if (/overloaded/i.test(`${code || ''} ${msg}`)) return out(529, 'overloaded_error', msg);
      if (status >= 500) return out(500, 'api_error', msg);
      return out(400, 'invalid_request_error', msg);
  }
}

/** Transport failure (refused, reset, DNS, idle timeout) -> 529, which the CLI retries. */
function transportError(err, label) {
  const why = err && err.code ? `${err.code}${err.message && err.message !== err.code ? ` (${err.message})` : ''}` : String((err && err.message) || err);
  return { status: 529, body: anthropicError('overloaded_error', `${prefix(label)}upstream unreachable: ${why}`), headers: {}, errorType: 'overloaded_error' };
}

/** A mid-stream `{"error":…}` chunk -> the same mapping, status from its numeric code when it has one. */
function streamChunkError(errObj, label, opts = {}) {
  const codeNum = errObj && typeof errObj === 'object' ? Number(errObj.code || errObj.status) : NaN;
  const status = Number.isInteger(codeNum) && codeNum >= 400 && codeNum < 600 ? codeNum : 500;
  return canonicalizeError({ status, bodyText: JSON.stringify({ error: errObj }), label, ...opts });
}

module.exports = { canonicalizeError, transportError, streamChunkError, parseErrorBody, overflowMessage, OVERFLOW_RE, QUOTA_RE, errorTypeFor };
