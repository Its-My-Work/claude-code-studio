// END-TO-END contract of the LLM bridge with the REAL `claude` CLI.
//
// A fake OpenAI-compatible provider scripts one agent turn — (a) Read a file, (b) Edit it,
// (c) a final text — and answers any side request the CLI makes with a short text. The CLI
// talks to the bridge (spawned as a real child by createBridgeHost) through a recording proxy,
// so both sides of the translation are visible: what Claude Code sent, and what the provider got.
//
// Isolation: HOME and CLAUDE_CONFIG_DIR are fresh temp dirs — the real ~/.claude is never read
// or written — and ANTHROPIC_API_KEY / CLAUDECODE are removed from the child env.
//
// Self-skips (exit 0) when no `claude` binary is found: PATH, then ~/.local/bin/claude, or
// CCS_CONTRACT_CLAUDE_BIN. CCS_CONTRACT_CAPTURE=1 also rewrites
// test/fixtures/llm-bridge/claude-<version>-request.json from the captured main request.
//
// Run: node test/llm-bridge-contract.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { createBridgeHost } = require('../llm-bridge/host');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

function findClaude() {
  if (process.env.CCS_CONTRACT_CLAUDE_BIN) return fs.existsSync(process.env.CCS_CONTRACT_CLAUDE_BIN) ? process.env.CCS_CONTRACT_CLAUDE_BIN : null;
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  const local = path.join(os.homedir(), '.local', 'bin', 'claude');
  try { fs.accessSync(local, fs.constants.X_OK); return local; } catch { return null; }
}

const CLAUDE = findClaude();
if (!CLAUDE) { console.log('skipped: claude CLI not found (PATH, ~/.local/bin/claude, CCS_CONTRACT_CLAUDE_BIN)'); process.exit(0); }
let version = 'unknown';
try { version = (execFileSync(CLAUDE, ['--version'], { encoding: 'utf8', timeout: 20000 }).match(/\d+\.\d+\.\d+/) || ['unknown'])[0]; } catch { /* keep unknown */ }
console.log(`claude CLI ${version} at ${CLAUDE}`);

const TOTAL_TIMEOUT_MS = 120000;
const hardStop = setTimeout(() => { console.error('FAIL contract test exceeded 120 s'); process.exit(1); }, TOTAL_TIMEOUT_MS + 10000);
hardStop.unref();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-llm-bridge-contract-'));
const WORK = path.join(tmp, 'work');
const HOME = path.join(tmp, 'home');
const CFG = path.join(tmp, 'config');
for (const d of [WORK, HOME, CFG]) fs.mkdirSync(d, { recursive: true });
const TARGET = path.join(WORK, 'note.txt');
fs.writeFileSync(TARGET, 'original line\n');

const PROVIDER_KEY = 'sk-fake-provider-key-000';

// ------------------------------------------------------------ fake provider --
const upstreamSeen = [];
function sseChunk(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }
function streamReply(res, model, { reasoning, text, toolCalls }, promptTokens) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const base = { id: 'chatcmpl-fake', object: 'chat.completion.chunk', model };
  if (reasoning) sseChunk(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: reasoning } }] });
  if (text) {
    sseChunk(res, { ...base, choices: [{ index: 0, delta: { content: text.slice(0, 4) } }] });
    sseChunk(res, { ...base, choices: [{ index: 0, delta: { content: text.slice(4) } }] });
  }
  (toolCalls || []).forEach((tc, i) => {
    const args = JSON.stringify(tc.args);
    sseChunk(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.name, arguments: '' } }] } }] });
    sseChunk(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: args.slice(0, 10) } }] } }] });
    sseChunk(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: args.slice(10) } }] } }] });
  });
  sseChunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: toolCalls && toolCalls.length ? 'tool_calls' : 'stop' }] });
  sseChunk(res, { ...base, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: reasoning ? 5 : 0 } } });
  res.write('data: [DONE]\n\n');
  res.end();
}

const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* keep null */ }
    upstreamSeen.push({ url: req.url, headers: req.headers, body });
    if (!body || req.url !== '/v1/chat/completions') { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":{"message":"no such route"}}'); return; }
    const names = (body.tools || []).map((t) => t.function && t.function.name);
    const promptTokens = Math.ceil(JSON.stringify(body.messages).length / 4);
    const mainLoop = names.includes('Read') && names.includes('Edit');
    if (!mainLoop) { streamReply(res, body.model, { text: 'Side reply.' }, promptTokens); return; }
    const toolMsgs = body.messages.filter((m) => m.role === 'tool').length;
    if (toolMsgs === 0) {
      streamReply(res, body.model, { reasoning: 'I should look at the file first.', text: 'Reading the file.', toolCalls: [{ id: 'call_read_1', name: 'Read', args: { file_path: TARGET } }] }, promptTokens);
    } else if (toolMsgs === 1) {
      streamReply(res, body.model, { reasoning: 'Now change it.', toolCalls: [{ id: 'call_edit_1', name: 'Edit', args: { file_path: TARGET, old_string: 'original line', new_string: 'changed by the bridge' } }] }, promptTokens);
    } else {
      streamReply(res, body.model, { text: 'Done: the file now says it was changed by the bridge.' }, promptTokens);
    }
  });
});

// --------------------------------------------- recording proxy (CLI -> bridge) --
const cliSeen = [];
let bridgePort = 0;
const proxy = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    let body = null;
    try { body = JSON.parse(raw.toString('utf8')); } catch { /* keep null */ }
    cliSeen.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
    const up = http.request({ host: '127.0.0.1', port: bridgePort, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${bridgePort}` } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => up.destroy());
    up.end(raw);
  });
});

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

// ------------------------------------------------- fixture capture (sanitised) --
function sanitize(obj) {
  const reps = [[tmp, '/TMP'], [WORK, '/WORKDIR'], [HOME, '/HOME'], [CFG, '/CLAUDE_CONFIG_DIR'], [os.homedir(), '/HOME'], [os.userInfo().username, 'user']];
  reps.sort((a, b) => b[0].length - a[0].length);
  let s = JSON.stringify(obj);
  for (const [from, to] of reps) if (from && from.length > 3) s = s.split(from).join(to);
  const o = JSON.parse(s);
  const cut = (t, n) => (typeof t === 'string' && t.length > n ? `${t.slice(0, n)}…[${t.length - n} more chars trimmed from the fixture]` : t);
  if (Array.isArray(o.system)) o.system = o.system.map((b) => ({ ...b, text: cut(b.text, 400) }));
  if (Array.isArray(o.tools)) o.tools = o.tools.map((t) => ({ ...t, description: cut(t.description, 200) }));
  if (o.metadata && typeof o.metadata.user_id === 'string') o.metadata.user_id = JSON.stringify({ device_id: 'DEVICE_ID', account_uuid: '', session_id: 'SESSION_ID' });
  for (const m of o.messages || []) {
    if (m.role === 'system' && typeof m.content === 'string') {
      m.content = m.content.replace(/(OS Version: )[^\n]*/g, '$1OS_VERSION').replace(/(Platform: )[^\n]*/g, '$1PLATFORM').replace(/(Shell: )[^\n]*/g, '$1SHELL')
        .replace(/\d{4}-\d{2}-\d{2}/g, 'YYYY-MM-DD').replace(/<total_tokens>\d+/g, '<total_tokens>N');
    }
  }
  return o;
}

(async () => {
  const upPort = await listen(upstream);
  const proxyPort = await listen(proxy);
  const usage = [];
  const logs = [];
  const host = createBridgeHost({ onUsage: (r) => usage.push(r), log: { debug() {}, info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) } });
  let cli = null;
  try {
    await host.start();
    bridgePort = Number(new URL(host.baseUrl()).port);
    const caps = { tools: true, vision: true, reasoning: true, pdf: false, contextWindow: 128000, maxOutput: 16000 };
    const token = host.registerRun({
      runId: 'run-contract', purpose: 'chat', sessionId: 'sess-1', taskId: null, botId: null,
      provider: { id: 'fake', label: 'Fake Provider', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: PROVIDER_KEY, authScheme: 'bearer', headers: {}, dialect: 'generic', options: {} },
      model: 'fake-model',
      models: { 'fake-model': caps, 'fake-fast': { ...caps, reasoning: false } },
      modelMap: { 'fake-fast': 'fake-fast', haiku: 'fake-fast' },
      fallbackModel: 'fake-fast',
      effort: 'high',
    });

    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE)/.test(k)) delete env[k];
    Object.assign(env, {
      HOME, CLAUDE_CONFIG_DIR: CFG, USERPROFILE: HOME,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxyPort}`,
      ANTHROPIC_AUTH_TOKEN: token,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '128000',
      CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fake-fast',
    });
    const args = ['-p', 'Update note.txt: replace "original line" with "changed by the bridge".',
      '--output-format', 'stream-json', '--verbose', '--model', 'fake-model', '--dangerously-skip-permissions',
      '--tools', 'Read,Edit,Write', '--max-turns', '8', '--effort', 'high'];
    const out = await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      cli = spawn(CLAUDE, args, { cwd: WORK, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { try { cli.kill('SIGKILL'); } catch { /* gone */ } }, TOTAL_TIMEOUT_MS - 10000);
      cli.stdout.on('data', (c) => { stdout += c; });
      cli.stderr.on('data', (c) => { stderr += c; });
      cli.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    await new Promise((r) => setTimeout(r, 300)); // let the last usage record cross IPC

    const lines = out.stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const result = lines.find((l) => l.type === 'result');
    if (!result) console.error(`  (cli exit ${out.code}) stderr: ${out.stderr.slice(-2000)}\n  stdout tail: ${out.stdout.slice(-2000)}`);

    console.log('the CLI run:');
    check('the run ended with result subtype success', result && result.subtype, 'success');
    check('the file was edited as scripted', fs.readFileSync(TARGET, 'utf8'), 'changed by the bridge\n');
    check('the final text came through', !!(result && /changed by the bridge/.test(result.result || '')), true);

    console.log('what the provider received:');
    const chats = upstreamSeen.filter((r) => r.url === '/v1/chat/completions' && r.body);
    const main = chats.filter((r) => (r.body.tools || []).some((t) => t.function.name === 'Read'));
    check('three main-loop calls reached the provider', main.length, 3);
    check('every call went to <baseUrl>/chat/completions', upstreamSeen.every((r) => r.url === '/v1/chat/completions'), true);
    check('the provider got its own key, never the run token', upstreamSeen.every((r) => r.headers.authorization === `Bearer ${PROVIDER_KEY}` && !JSON.stringify(r.headers).includes(token)), true);
    const first = main[0] && main[0].body;
    check('a system message comes first', first && first.messages[0].role, 'system');
    check('the system text is Claude Code\'s, minus the billing header', !!(first && /Claude/.test(first.messages[0].content) && !/x-anthropic-billing-header/.test(first.messages[0].content)), true);
    check('the tools arrived as OpenAI functions', first && first.tools.map((t) => t.type + ':' + t.function.name).sort(), ['function:Edit', 'function:Read', 'function:Write']);
    check('tool schemas lost $schema (basic sanitize)', !!(first && first.tools.every((t) => !('$schema' in t.function.parameters))), true);
    check('reasoning_effort is the run\'s effort (high)', main.map((r) => r.body.reasoning_effort), ['high', 'high', 'high']);
    check('max_tokens was clamped to the model cap', first && first.max_tokens, 16000);
    check('the upstream call streamed with usage', first && [first.stream, first.stream_options && first.stream_options.include_usage], [true, true]);
    const second = main[1] && main[1].body;
    const toolMsg = second && second.messages.find((m) => m.role === 'tool');
    check('the Read result came back as a role:tool message', !!(toolMsg && toolMsg.tool_call_id === 'call_read_1' && /original line/.test(toolMsg.content)), true);
    const asst = second && second.messages.find((m) => m.role === 'assistant');
    check('the assistant turn carries the tool call', asst && asst.tool_calls && asst.tool_calls.map((t) => [t.id, t.function.name]), [['call_read_1', 'Read']]);
    check('no Anthropic-only field leaked upstream', main.every((r) => !['thinking', 'output_config', 'context_management', 'metadata', 'system'].some((k) => k in r.body)), true);

    console.log('what the CLI sent and got back:');
    const cliMain = cliSeen.filter((r) => r.body && Array.isArray(r.body.tools) && r.body.tools.some((t) => t.name === 'Read'));
    check('the CLI called POST /v1/messages', cliMain.every((r) => r.method === 'POST' && r.url.split('?')[0] === '/v1/messages'), true);
    const sid = cliMain[0] && cliMain[0].headers['x-claude-code-session-id'];
    check('the CLI sends x-claude-code-session-id', typeof sid === 'string' && sid.length > 8, true);
    check('the CLI authenticates with the run token only', cliMain.every((r) => r.headers.authorization === `Bearer ${token}` && !r.headers['x-api-key']), true);

    console.log('usage records:');
    const msgRequests = cliSeen.filter((r) => r.url.split('?')[0].endsWith('/v1/messages')).length;
    check('one usage record per /v1/messages request', usage.length, msgRequests);
    const u = usage.find((r) => r.requestedModel === 'fake-model');
    check('a record names run, provider, model and the CLI session', u && [u.runId, u.purpose, u.providerId, u.model, u.cliSessionId, u.status, u.stream], ['run-contract', 'chat', 'fake', 'fake-model', sid, 'ok', true]);
    check('a record carries real token counts', !!(u && u.inputTokens > 0 && u.outputTokens === 12 && u.latencyMs >= 0), true);
    check('reasoning tokens are recorded', usage.some((r) => r.reasoningTokens === 5), true);

    // observations for the integration (printed, not asserted)
    const paths = [...new Set(cliSeen.map((r) => `${r.method} ${r.url}`))];
    const models = [...new Set(cliSeen.map((r) => r.body && r.body.model).filter(Boolean))];
    const betas = [...new Set(cliSeen.map((r) => r.headers['anthropic-beta']).filter(Boolean))];
    console.log(`  info endpoints called: ${paths.join(', ')}`);
    console.log(`  info models requested: ${models.join(', ')}`);
    console.log(`  info anthropic-beta: ${betas.join(' | ')}`);
    if (cliMain[0]) {
      const b = cliMain[0].body;
      console.log(`  info main request: max_tokens=${b.max_tokens} thinking=${JSON.stringify(b.thinking)} output_config=${JSON.stringify(b.output_config)} keys=${Object.keys(b).join(',')}`);
    }

    if (process.env.CCS_CONTRACT_CAPTURE && cliMain.length) {
      const last = cliMain[cliMain.length - 1];
      const fixture = { captured: `claude CLI ${version}`, note: 'Real request body captured by test/llm-bridge-contract.test.js (CCS_CONTRACT_CAPTURE=1). Paths, ids and env details replaced by placeholders; long system/tool texts trimmed.', headers: {}, body: sanitize(last.body) };
      for (const k of ['anthropic-version', 'anthropic-beta', 'content-type', 'accept', 'x-app']) if (last.headers[k]) fixture.headers[k] = last.headers[k];
      if (last.headers['x-claude-code-session-id']) fixture.headers['x-claude-code-session-id'] = 'SESSION_ID';
      fixture.headers.url = last.url;
      const dir = path.join(__dirname, 'fixtures', 'llm-bridge');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `claude-${version}-request.json`);
      fs.writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
      console.log(`  info captured ${path.relative(path.join(__dirname, '..'), file)}`);
    }
  } catch (e) {
    fail++;
    console.error(`  FAIL harness error: ${(e && e.stack) || e}`);
    if (logs.length) console.error(logs.slice(-20).join('\n'));
  } finally {
    if (cli && cli.exitCode === null) { try { cli.kill('SIGKILL'); } catch { /* gone */ } }
    await host.stop().catch(() => {});
    upstream.close();
    proxy.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
