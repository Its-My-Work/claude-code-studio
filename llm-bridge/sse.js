'use strict';
// Incremental Server-Sent-Events parser, for both directions we read: OpenAI chunks (translate
// mode) and Anthropic events (the passthrough usage tap). Byte chunks may split anywhere — inside
// a UTF-8 sequence, inside a line, between \r and \n — so it buffers until a full line.

const { StringDecoder } = require('string_decoder');

/** onEvent({event, data}) per complete event. feed(Buffer|string); end() flushes a trailing event. */
function createSseParser(onEvent) {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  let event = null;
  let data = [];

  function dispatch() {
    if (data.length || event) onEvent({ event: event || 'message', data: data.join('\n') });
    event = null;
    data = [];
  }

  function line(l) {
    if (l.endsWith('\r')) l = l.slice(0, -1);
    if (l === '') { dispatch(); return; }
    if (l[0] === ':') return; // comment / keep-alive (": OPENROUTER PROCESSING")
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    let v = i < 0 ? '' : l.slice(i + 1);
    if (v[0] === ' ') v = v.slice(1);
    if (field === 'event') event = v;
    else if (field === 'data') data.push(v);
  }

  return {
    feed(chunk) {
      buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        line(l);
      }
    },
    end() {
      buf += decoder.end();
      if (buf) { line(buf); buf = ''; }
      dispatch();
    },
  };
}

/**
 * JSON payloads of one event's data. Non-compliant servers put several `data:` lines of complete
 * JSON in one event (no blank line between); the spec joins them with \n, which is not JSON, so
 * fall back to parsing each line on its own.
 */
function parseEventJson(data) {
  if (!data) return [];
  try { return [JSON.parse(data)]; } catch { /* fall through */ }
  const out = [];
  for (const l of data.split('\n')) {
    const t = l.trim();
    if (!t || t === '[DONE]') continue;
    try { out.push(JSON.parse(t)); } catch { /* junk line: skip */ }
  }
  return out;
}

module.exports = { createSseParser, parseEventJson };
