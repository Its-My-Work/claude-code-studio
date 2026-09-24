'use strict';
// Names and ids that have to survive a round trip through a provider with stricter rules than
// Anthropic's. Every mapping here is DETERMINISTIC (a pure function of its input), so the bridge
// keeps no state between requests: the same history maps the same way every time, which also
// keeps provider-side prefix caches valid.

const { hashAlnum, sha1hex, randomAlnum } = require('./util');

// ---------------------------------------------------------------- tool names --
// OpenAI function names: ^[a-zA-Z0-9_-]{1,64}$. MCP tools (`mcp__server__tool.name`, long server
// names) break that; they are renamed `t<8 hex>_<sanitized>` and renamed back on the response.
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function upstreamToolName(name) {
  const n = String(name == null ? '' : name);
  if (TOOL_NAME_RE.test(n)) return n;
  const clean = n.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 54);
  return `t${sha1hex(n).slice(0, 8)}_${clean}`;
}

/** Reverse map (upstream name -> original) for every name in the request's tools and history. */
function toolNameReverseMap(body) {
  const rev = new Map();
  const add = (n) => { if (typeof n === 'string' && n) rev.set(upstreamToolName(n), n); };
  for (const t of (body && Array.isArray(body.tools) ? body.tools : [])) add(t && t.name);
  for (const m of (body && Array.isArray(body.messages) ? body.messages : [])) {
    if (m && Array.isArray(m.content)) for (const b of m.content) if (b && b.type === 'tool_use') add(b.name);
  }
  return rev;
}

// ------------------------------------------------------------------ tool ids --
// Anthropic tool_use ids the CLI accepts; anything else (a provider's `call_…|with/slashes`) is
// hashed so the same upstream id always gives the same Anthropic id.
const TOOL_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function anthropicToolId(upstreamId) {
  if (typeof upstreamId === 'string' && TOOL_ID_RE.test(upstreamId)) return upstreamId;
  if (typeof upstreamId === 'string' && upstreamId) return `toolu_${sha1hex(upstreamId).slice(0, 24)}`;
  return `toolu_${randomAlnum(24)}`;
}

/** History tool ids -> upstream, per dialect.toolIdStyle ('mistral9': exactly 9 alnum chars). */
function upstreamToolId(id, style) {
  const s = String(id == null ? '' : id);
  if (style === 'mistral9') return /^[A-Za-z0-9]{9}$/.test(s) ? s : hashAlnum(s, 9);
  return s;
}

// ---------------------------------------------------------- thinking signature --
// An Anthropic thinking block must carry a signature; the CLI stores it and sends the block back.
// Ours says WHICH provider produced the reasoning (only that provider may see it again) and
// carries the provider's opaque reasoning_details (encrypted items included) for the echo.
const SIG_PREFIX = 'ccsb1:';

function makeSignature(providerId, details) {
  const o = { p: String(providerId || '') };
  if (Array.isArray(details) && details.length) o.d = details;
  return SIG_PREFIX + Buffer.from(JSON.stringify(o)).toString('base64url');
}

/** -> {p, d?} for one of our signatures, null for anything else (real Anthropic ones, junk). */
function readSignature(sig) {
  if (typeof sig !== 'string' || !sig.startsWith(SIG_PREFIX)) return null;
  try {
    const o = JSON.parse(Buffer.from(sig.slice(SIG_PREFIX.length), 'base64url').toString('utf8'));
    return o && typeof o.p === 'string' ? o : null;
  } catch { return null; }
}

module.exports = {
  TOOL_NAME_RE, TOOL_ID_RE, SIG_PREFIX,
  upstreamToolName, toolNameReverseMap, anthropicToolId, upstreamToolId, makeSignature, readSignature,
};
