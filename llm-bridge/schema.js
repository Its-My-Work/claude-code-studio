'use strict';
// Tool input_schema -> OpenAI `parameters`. Claude Code sends draft 2020-12 JSON Schema
// (`$schema`, `additionalProperties:false`, `exclusiveMinimum`, …). Most OpenAI-compatible
// servers accept that; Gemini's compat layer implements an OpenAPI subset and 400s on unknown
// keywords, hence the levels:
//   none   — untouched
//   basic  — drop `$schema` and empty `required: []` (both trip some validators, carry no meaning)
//   strict — also drop keywords outside the OpenAPI subset, recursively
// The walk is SCHEMA-AWARE: the keys of `properties` are parameter names, never keywords, so a
// parameter called `default` or `format` survives.

const STRICT_DROP = new Set([
  'additionalProperties', 'exclusiveMinimum', 'exclusiveMaximum', 'examples', 'default', '$id',
  '$comment', 'patternProperties', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems',
  'dependentRequired', 'dependentSchemas', 'contentEncoding', 'contentMediaType', 'const',
  'if', 'then', 'else', 'readOnly', 'writeOnly', 'deprecated', 'minContains', 'maxContains', 'contains',
]);
// Formats the OpenAPI subset understands; anything else ("uri", "email", …) is dropped in strict mode.
const SAFE_FORMATS = new Set(['enum', 'date-time', 'int32', 'int64', 'float', 'double']);

const SCHEMA_MAPS = new Set(['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas']);
const SCHEMA_LISTS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
const SCHEMA_ONE = new Set(['not', 'additionalProperties', 'contains', 'if', 'then', 'else', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems']);

function walk(node, level) {
  if (Array.isArray(node)) return node.map((n) => walk(n, level));
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$schema') continue;
    if (k === 'required' && Array.isArray(v) && v.length === 0) continue;
    if (level === 'strict') {
      if (k === 'const') { if (!('enum' in node)) out.enum = [v]; continue; } // const -> enum keeps the constraint
      if (STRICT_DROP.has(k)) continue;
      if (k === 'format' && !SAFE_FORMATS.has(v)) continue;
    }
    if (SCHEMA_MAPS.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = {};
      for (const [name, sub] of Object.entries(v)) out[k][name] = walk(sub, level);
    } else if (SCHEMA_LISTS.has(k) && Array.isArray(v)) {
      out[k] = v.map((s) => walk(s, level));
    } else if (k === 'items') {
      out[k] = walk(v, level);
    } else if (SCHEMA_ONE.has(k) && v && typeof v === 'object') {
      out[k] = walk(v, level);
    } else {
      out[k] = v; // enum values, descriptions, numbers: data, not schema
    }
  }
  return out;
}

/** Sanitize a tool input_schema for the upstream. Always returns an object schema. */
function sanitizeSchema(schema, level = 'basic') {
  const s = schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : { type: 'object', properties: {} };
  if (level === 'none') return s;
  const out = walk(s, level);
  if (!out.type) out.type = 'object';
  return out;
}

module.exports = { sanitizeSchema };
