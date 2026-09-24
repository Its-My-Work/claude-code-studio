'use strict';
// Translate mode (provider.type 'openai-compatible'): Anthropic Messages in, OpenAI Chat
// Completions upstream, Anthropic back out. The pure halves live in translate-request.js and
// translate-response.js; this file is the I/O around them.
//
// Order matters for the CLI: the upstream status is known BEFORE anything is written to the
// client, so a 429/5xx/overflow reaches Claude Code as a real HTTP status it can retry or act
// on. Only after a 2xx do SSE headers + message_start go out — immediately, so the CLI's own
// first-byte clock is satisfied — followed by a ping every 15 s of silence (a reasoning model
// can think for minutes without emitting a token; Claude Code aborts a stream that stays silent).

const { sseFrame } = require('./util');
const { resolveDialect } = require('./dialects');
const { resolveModel, capsFor } = require('./models');
const { toOpenAI, BadRequest } = require('./translate-request');
const { createTranslator, createAggregator, completionToChunk } = require('./translate-response');
const { createSseParser, parseEventJson } = require('./sse');
const { readAll, UpstreamError } = require('./upstream');
const { canonicalizeError, transportError, streamChunkError } = require('./errors');
const { estimateInputTokens } = require('./estimate');
const { authHeaders, extraHeaders } = require('./passthrough');

/**
 * `<baseUrl>/chat/completions`. baseUrl conventionally carries the version segment
 * (https://api.openai.com/v1, https://openrouter.ai/api/v1); a base WITHOUT one still just gets
 * /chat/completions appended — some providers (DeepSeek: https://api.deepseek.com) serve it at the
 * root, so the bridge never guesses a /v1. A baseUrl that already ends in /chat/completions is used as is.
 */
function openaiUrl(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

function openaiHeaders(provider, stream) {
  return {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
    'accept-encoding': 'identity',
    'user-agent': 'claude-code-studio-llm-bridge/1',
    ...authHeaders({ ...provider, authScheme: provider.authScheme || 'bearer' }),
    ...extraHeaders(provider),
  };
}

/** SSE response writer with the keep-alive ping: a ping goes out whenever nothing else did for `pingMs`. */
function createSseWriter(res, pingMs) {
  let timer = null;
  let closed = false;
  const raw = (s) => { if (!closed && !res.destroyed) res.write(s); };
  return {
    open() {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
      if (res.flushHeaders) res.flushHeaders();
      timer = setTimeout(function tick() { raw(sseFrame('ping', { type: 'ping' })); if (!closed) timer.refresh(); }, pingMs);
    },
    write(event, data) { raw(sseFrame(event, data)); if (timer && !closed) timer.refresh(); },
    end() { if (closed) return; closed = true; clearTimeout(timer); if (!res.destroyed) res.end(); },
    stop() { closed = true; clearTimeout(timer); },
  };
}

async function handleTranslate(rc, env) {
  const p = rc.provider;
  const label = p.label || p.id || 'provider';
  const body = rc.body;
  const dialect = resolveDialect(p);
  const requestedModel = typeof body.model === 'string' ? body.model : '';
  const model = resolveModel(rc.ctx, requestedModel);
  const caps = capsFor(rc.ctx, model);
  rc.setModel(model, requestedModel);

  let tr;
  try {
    tr = toOpenAI(body, { ctx: rc.ctx, dialect, upstreamModel: model, caps });
  } catch (e) {
    if (!(e instanceof BadRequest)) throw e;
    rc.error(400, 'invalid_request_error', `llm-bridge: ${e.message}`);
    rc.finish({ status: 'error', httpStatus: 400, errorType: 'invalid_request_error' });
    return;
  }
  rc.entry.effort = tr.effort;

  const rawEstimate = estimateInputTokens(body);
  const estimate = env.calibrator.apply(rc.calKey, rawEstimate);
  const clientStream = body.stream === true;
  const payload = Buffer.from(JSON.stringify(tr.body));

  const release = await env.acquire(p, rc.signal).catch(() => null);
  if (!release) { rc.finish({ status: 'aborted' }); return; }

  let up;
  try {
    up = await env.sendWithRetry(rc, { url: openaiUrl(p.baseUrl), headers: openaiHeaders(p, tr.upstreamStream), body: payload });
  } catch (e) {
    release();
    if (rc.aborted()) { rc.finish({ status: 'aborted' }); return; }
    const m = transportError(e, label);
    rc.json(m.status, m.body, m.headers);
    rc.finish({ status: 'error', httpStatus: m.status, errorType: m.errorType });
    return;
  }
  rc.entry.upstreamStatus = up.status;

  if (up.status < 200 || up.status >= 300) {
    const { text } = await readAll(up, 1024 * 1024);
    release();
    const m = canonicalizeError({ status: up.status, bodyText: text, headers: up.headers, label, contextWindow: caps.contextWindow, estimate });
    rc.json(m.status, m.body, m.headers);
    rc.finish({ status: 'error', httpStatus: m.status, errorType: m.errorType });
    return;
  }
  if (rc.res.destroyed) { up.destroy(); release(); rc.finish({ status: 'aborted' }); return; }

  const ct = String(up.headers['content-type'] || '');
  // a provider may ignore stream:true for some models and answer JSON; read what it actually sent
  const upstreamSse = /event-stream/i.test(ct) || (tr.upstreamStream && !/json/i.test(ct));
  const sse = clientStream ? createSseWriter(rc.res, env.pingIntervalMs) : null;
  const agg = clientStream ? null : createAggregator();
  const tl = createTranslator({
    clientModel: requestedModel || model,
    providerId: p.id,
    toolNames: tr.toolNames,
    stopSequences: tr.stopSequences,
    inputEstimate: estimate,
    emitThinking: tr.emitThinking,
    sink: clientStream ? (ev, d) => sse.write(ev, d) : (ev, d) => agg.event(ev, d),
  });
  if (clientStream) { sse.open(); tl.start(); }

  await new Promise((resolve) => {
    let done = false;
    let sawDone = false;

    const usageFields = () => {
      const u = tl.usage();
      return { inputTokens: u.input, outputTokens: u.output, cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite, reasoningTokens: u.reasoning, promptTotal: u.promptTotal };
    };
    const settle = (fields) => {
      if (done) return;
      done = true;
      release();
      if (sse) sse.stop();
      const { promptTotal, ...rest } = { ...usageFields(), ...fields };
      if (fields.status === 'ok' && promptTotal) env.calibrator.observe(rc.calKey, rawEstimate, promptTotal);
      const st = tl.stats();
      rc.entry.tools = st.tools;
      if (st.invalidArgs || st.repairedArgs || st.droppedTools) rc.entry.toolArgs = { invalid: st.invalidArgs, repaired: st.repairedArgs, dropped: st.droppedTools };
      rc.finish(rest);
      resolve();
    };
    const failWith = (m) => {
      if (done) return;
      up.destroy();
      if (clientStream) {
        tl.fail(m.body.error.type, m.body.error.message);
        sse.end();
        settle({ status: 'error', httpStatus: 200, errorType: m.errorType });
      } else {
        rc.json(m.status, m.body, m.headers);
        settle({ status: 'error', httpStatus: m.status, errorType: m.errorType });
      }
    };
    const complete = () => {
      if (done) return;
      if (!tl.sawChunk && !sawDone) {
        failWith(transportError(new UpstreamError('EEMPTY', 'upstream returned an empty response'), label));
        return;
      }
      tl.end();
      if (clientStream) sse.end();
      else rc.json(200, agg.message());
      settle({ status: 'ok', httpStatus: 200 });
    };
    const broken = (e) => {
      if (done) return;
      if (rc.aborted()) { up.destroy(); settle({ status: 'aborted' }); return; }
      failWith(transportError(up.reason() || e, label));
    };
    const chunkErrorOpts = { contextWindow: caps.contextWindow, estimate };

    rc.onAbort(() => { up.destroy(); settle({ status: 'aborted' }); });

    if (upstreamSse) {
      const parser = createSseParser(({ data }) => {
        if (done) return;
        if (data.trim() === '[DONE]') { sawDone = true; return; }
        for (const j of parseEventJson(data)) {
          if (done) return;
          const r = tl.chunk(j);
          if (r && r.error !== undefined) { failWith(streamChunkError(r.error, label, chunkErrorOpts)); return; }
        }
      });
      up.stream.on('data', (c) => { if (!done) { rc.markFirstByte(); parser.feed(c); } });
      up.stream.once('end', () => { if (done) return; parser.end(); complete(); });
    } else {
      readAll(up, 64 * 1024 * 1024).then(({ text, error }) => {
        if (done) return;
        rc.markFirstByte();
        if (error) { broken(error); return; }
        let json = null;
        try { json = JSON.parse(text); } catch { /* handled below */ }
        if (!json || typeof json !== 'object') { failWith(transportError(new UpstreamError('EBADJSON', 'upstream returned a body that is not JSON'), label)); return; }
        if (json.error && !Array.isArray(json.choices)) { failWith(streamChunkError(json.error, label, chunkErrorOpts)); return; }
        tl.chunk(completionToChunk(json));
        complete();
      });
      return;
    }
    up.stream.once('error', broken);
    up.stream.once('close', () => { if (!up.stream.readableEnded) broken(new UpstreamError('ECONNRESET', 'upstream closed the connection mid-stream')); });
  });
}

module.exports = { handleTranslate, openaiUrl, openaiHeaders, createSseWriter };
