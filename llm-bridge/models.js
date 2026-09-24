'use strict';
// Which upstream model a request goes to, what that model can do, and how hard it should think.

const { CLAUDE_LIKE_RE } = require('./util');

const FAMILY_RE = /^(haiku|sonnet|opus|fable)$/i;
const NO_CAPS = Object.freeze({ tools: null, vision: null, reasoning: null, pdf: null, contextWindow: null, maxOutput: null });

/**
 * The upstream model id for a model name the CLI sent.
 *  1. modelMap exact match;
 *  2. modelMap family alias ('haiku' / 'sonnet' / …) contained in the name — the CLI sends dated
 *     ids like `claude-haiku-4-5-20251001` for its side calls, and nobody can list every date;
 *  3. type 'anthropic': unchanged (the provider knows every Claude id);
 *  4. otherwise a model of this run → itself; a Claude-looking unknown id → fallbackModel (an
 *     OpenAI-style provider would only 404 on it, and so would most anthropic-COMPATIBLE ones —
 *     DeepSeek/Kimi/GLM speak the protocol, not the model names); anything else → unchanged.
 *     An anthropic-compatible provider without a fallbackModel keeps the id (a proxy that does
 *     serve Claude models).
 */
function resolveModel(ctx, requested) {
  const req = typeof requested === 'string' ? requested : '';
  const map = (ctx && ctx.modelMap) || {};
  if (req && Object.prototype.hasOwnProperty.call(map, req) && map[req]) return map[req];
  const lower = req.toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (v && FAMILY_RE.test(k) && lower.includes(k.toLowerCase())) return v;
  }
  const type = ctx && ctx.provider && ctx.provider.type;
  if (!req) return ctx.model;
  if (type === 'anthropic') return req;
  if (ctx.models && ctx.models[req]) return req;
  if (CLAUDE_LIKE_RE.test(req)) return type === 'anthropic-compatible' ? (ctx.fallbackModel || req) : (ctx.fallbackModel || ctx.model);
  return req;
}

/** Caps of an upstream model id; unknown fields stay null (= "do not assume"). */
function capsFor(ctx, upstreamModel) {
  const c = ctx && ctx.models && ctx.models[upstreamModel];
  return c ? { ...NO_CAPS, ...c } : { ...NO_CAPS };
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'none']);

/**
 * The reasoning effort for this request: RunCtx.effort (the studio's choice — the CLI may drop
 * --effort for a model id it does not know) ?? output_config.effort ?? the thinking config
 * (enabled budget → bucket; adaptive → provider default; disabled → 'none'). null = send nothing.
 */
function effectiveEffort(ctx, body) {
  if (ctx && ctx.effort && EFFORTS.has(ctx.effort)) return ctx.effort;
  const oc = body && body.output_config;
  if (oc && typeof oc.effort === 'string' && EFFORTS.has(oc.effort)) return oc.effort;
  const t = body && body.thinking;
  if (t && typeof t === 'object') {
    if (t.type === 'disabled') return 'none';
    if (t.type === 'enabled') {
      const b = t.budget_tokens;
      if (!Number.isInteger(b) || b < 1) return 'medium';
      return b < 2500 ? 'low' : b < 8000 ? 'medium' : 'high';
    }
  }
  return null;
}

/** min(requested, caps.maxOutput) when the cap is known. */
function clampMaxTokens(requested, caps) {
  const cap = caps && Number.isInteger(caps.maxOutput) && caps.maxOutput > 0 ? caps.maxOutput : null;
  if (!Number.isInteger(requested) || requested < 1) return cap;
  return cap ? Math.min(requested, cap) : requested;
}

module.exports = { resolveModel, capsFor, effectiveEffort, clampMaxTokens, NO_CAPS };
