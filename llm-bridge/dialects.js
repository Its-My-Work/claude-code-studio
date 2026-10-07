'use strict';
// Per-provider quirks of "OpenAI-compatible" APIs, as DATA. The translator never branches on a
// provider name — only on these fields — so a new provider is a table row (or a few
// `provider.options` overrides), not a code change.
//
// Fields:
//   maxTokensField            'max_tokens' | 'max_completion_tokens' (OpenAI reasoning models refuse max_tokens)
//   effortParam               how reasoning effort is expressed upstream:
//                               'reasoning_effort'  top-level string (OpenAI, Gemini compat, most gateways)
//                               'reasoning'         OpenRouter object  reasoning:{effort} / {enabled:false}
//                               'thinking'          DeepSeek-style     thinking:{type:'enabled'|'disabled'}
//                               'enable_thinking'   Qwen/DashScope     enable_thinking + thinking_budget
//                               'none'              never sent
//   effortRequiresCaps        only send effort when the model's caps say reasoning === true (Ollama:
//                             a non-reasoning local model 400s on an unknown knob)
//   effortMap                 Anthropic effort -> upstream value; null = omit the parameter
//   reasoningEcho             how our own thinking blocks go back upstream in history:
//                             'reasoning_content' | 'reasoning_details' | 'none'
//   allowTopK                 forward top_k
//   dropSamplingWithReasoning drop temperature/top_p when reasoning is on (OpenAI o-series/gpt-5 400 on them)
//   schemaSanitize            'none' | 'basic' | 'strict' (see schema.js)
//   toolIdStyle               'passthrough' | 'mistral9' (Mistral wants 9-char alnum tool_call ids)
//   fileParts                 PDFs can go up as {type:'file'} content parts
//   streamUsage               ask for usage in the stream (stream_options.include_usage)
//   usageInclude              also send usage:{include:true} (OpenRouter's own switch for usage accounting)
//   cacheControl              keep Anthropic cache_control markers on content parts (OpenRouter forwards
//                             them to Anthropic/Gemini backends); everyone else gets them stripped
//   upstreamStream            always stream upstream, even for a non-stream client request (idle
//                             watchdog instead of one long silent wait); false = plain JSON call
//   systemFold                'leading' = fold system-role entries that come before the first assistant
//                             turn into the system prompt, later ones become user text (keeps the
//                             prefix stable for provider-side prompt caching); 'all' = fold every one
//   noUserAfterTool           a user text message may not directly follow tool messages (Mistral):
//                             such text is appended to the last tool message instead
//   sendUser                  send metadata.user_id (hashed) as `user`; off where the API rejects
//                             unknown fields (Mistral answers 422 "Extra inputs are not permitted")

const BASE_EFFORT = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high', none: null };

const DEFAULTS = {
  maxTokensField: 'max_tokens',
  effortParam: 'reasoning_effort',
  effortRequiresCaps: false,
  effortMap: BASE_EFFORT,
  reasoningEcho: 'none',
  allowTopK: false,
  dropSamplingWithReasoning: false,
  schemaSanitize: 'basic',
  toolIdStyle: 'passthrough',
  fileParts: false,
  streamUsage: true,
  usageInclude: false,
  cacheControl: false,
  upstreamStream: true,
  systemFold: 'leading',
  noUserAfterTool: false,
  sendUser: true,
};

const PRESETS = {
  generic: {},
  openai: {
    maxTokensField: 'max_completion_tokens', dropSamplingWithReasoning: true, fileParts: true,
    effortMap: { ...BASE_EFFORT, none: 'none' },
  },
  openrouter: {
    effortParam: 'reasoning', reasoningEcho: 'reasoning_details', allowTopK: true, fileParts: true, cacheControl: true, usageInclude: true,
    effortMap: { ...BASE_EFFORT, none: 'none' },
  },
  deepseek: { effortParam: 'thinking', reasoningEcho: 'reasoning_content' },
  gemini: { schemaSanitize: 'strict', sendUser: false, effortMap: { ...BASE_EFFORT, none: 'none' } },
  qwen: { effortParam: 'enable_thinking', reasoningEcho: 'reasoning_content' },
  // Mistral validates strictly (422 on unknown fields) and reports usage in the last chunk anyway
  mistral: { effortParam: 'none', toolIdStyle: 'mistral9', noUserAfterTool: true, sendUser: false, streamUsage: false },
  ollama: { effortParam: 'reasoning_effort', effortRequiresCaps: true, allowTopK: true },
};

const FIELDS = Object.keys(DEFAULTS);

/** The effective dialect for a provider: preset (by provider.dialect) + any provider.options overrides. */
function resolveDialect(provider) {
  const name = provider && PRESETS[provider.dialect] ? provider.dialect : 'generic';
  const d = { name, ...DEFAULTS, ...PRESETS[name] };
  const opts = (provider && provider.options) || {};
  for (const f of FIELDS) {
    if (opts[f] === undefined) continue;
    d[f] = f === 'effortMap' && opts[f] && typeof opts[f] === 'object' ? { ...d.effortMap, ...opts[f] } : opts[f];
  }
  return d;
}

module.exports = { DEFAULTS, PRESETS, FIELDS, resolveDialect };
