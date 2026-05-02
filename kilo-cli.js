const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

// Kill a child process and its tree. On Windows `proc.kill()` only kills the
// direct child (cmd.exe), leaving grandchildren (node.exe) orphaned.
// `taskkill /T /F` kills the entire process tree.
function killProc(proc) {
  if (process.platform === 'win32' && proc.pid && Number.isInteger(proc.pid)) {
    try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  } else {
    try { proc.kill('SIGTERM'); } catch {}
  }
}

// Resolve kilo binary — cross-platform (macOS, Linux, Windows)
function findKiloBin() {
  const isWin = process.platform === 'win32';

  // Unix-only candidate paths (macOS / Linux)
  if (!isWin) {
    const unixCandidates = [
      path.join(os.homedir(), '.local', 'bin', 'kilo'),
      '/opt/homebrew/bin/kilo',
      '/usr/local/bin/kilo',
      '/usr/bin/kilo',
      // Check nvm paths
      path.join(os.homedir(), '.nvm', 'versions', 'node', process.version.split('.')[0], 'bin', 'kilo'),
      // Check common Node.js installation paths
      path.join(os.homedir(), '.nvm', 'versions', 'node', process.version, 'bin', 'kilo'),
    ];
    for (const c of unixCandidates) {
      if (fs.existsSync(c)) return c;
    }
  }

  // Windows: look for kilo.cmd or kilo.exe in common locations
  if (isWin) {
    const appData  = process.env.APPDATA  || '';
    const localApp = process.env.LOCALAPPDATA || '';
    const winCandidates = [
      path.join(appData,  'npm', 'kilo.cmd'),
      path.join(localApp, 'npm', 'kilo.cmd'),
      path.join(appData,  'npm', 'kilo.exe'),
      path.join(localApp, 'Programs', 'kilo', 'kilo.exe'),
    ];
    for (const c of winCandidates) {
      if (fs.existsSync(c)) return c;
    }
    try {
      const resolved = execSync('where.exe kilo', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .split(/\r?\n/)
        .map(s => s.trim())
        .find(Boolean);
      if (resolved) return resolved;
    } catch {}
    return 'kilo'; // fallback via PATH / запасний варіант через PATH
  }

  return 'kilo'; // fallback to PATH (Unix)
}

const KILO_BIN = findKiloBin();

// Global subprocess timeout — process is killed if it does not exit within this window.
// Configurable via CLAUDE_TIMEOUT_MS env var; default 10 minutes.
const MAX_SUBPROCESS_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || '1800000', 10) || 1800000;

// Maximum size of a single unflushed stdout line — guards against heap exhaustion
// when the CLI emits a line without \n (should never happen in stream-json mode,
// but defensive cap prevents OOM if something goes wrong).
const MAX_LINE_BUFFER = 10 * 1024 * 1024; // 10 MB

// CLI uses short aliases — kilo binary resolves them internally
const MODEL_MAP = {
  // 'opus':   'kilo-opus-4-6',
  // 'sonnet': 'kilo-sonnet-4-6',
  // 'haiku':  'kilo-haiku-4-5',
  'opus':   'opus',
  'sonnet': 'sonnet',
  'haiku':  'haiku',
  'kilo/kilo-auto/free': 'kilo/kilo-auto/free',
};

// ─── CLI Engine Detection: KiloCode ──────────────────────────────────────────
// Always uses Kilo CLI

// ─── MCP config file cache ──────────────────────────────────────────────────
// Reuses temp files by content hash instead of creating/deleting per request.
// Key: SHA-256 hash of JSON content → { path, refCount }
// Files are cleaned up when no references remain (process exit or explicit clear).
const _mcpConfigCache = new Map();

function getMcpConfigPath(mcpServers) {
  const json = JSON.stringify({ mcpServers });
  const hash = crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);
  const cached = _mcpConfigCache.get(hash);
  if (cached) {
    cached.refCount++;
    return { path: cached.path, hash, isNew: false };
  }
  const filePath = path.join(os.tmpdir(), `mcp-${hash}.json`);
  fs.writeFileSync(filePath, json);
  _mcpConfigCache.set(hash, { path: filePath, refCount: 1 });
  return { path: filePath, hash, isNew: true };
}

function releaseMcpConfig(hash) {
  if (!hash) return;
  const cached = _mcpConfigCache.get(hash);
  if (!cached) return;
  cached.refCount--;
  if (cached.refCount <= 0) {
    try { fs.unlinkSync(cached.path); } catch {}
    _mcpConfigCache.delete(hash);
  }
}

// Cleanup all cached MCP files on process exit
process.on('exit', () => {
  for (const [, entry] of _mcpConfigCache) {
    try { fs.unlinkSync(entry.path); } catch {}
  }
});

class KiloCLI {
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
    this.kiloBin = options.kiloBin || KILO_BIN;
  }

send({ prompt, contentBlocks, sessionId, model, maxTurns, mcpServers, systemPrompt, allowedTools, tools, abortController, settingSources, forkSession, addDirs, extraEnv, extraSettings, mode, thinking }) {
    console.log('[KILO SEND START]', {
      sessionId,
      model,
      mode,
      promptLength: prompt?.length || 0,
      thinking,
      contentBlocksType: typeof contentBlocks,
      contentBlocksLen: contentBlocks?.length || 0,
      contentBlocksIsArray: Array.isArray(contentBlocks)
    });

    // Process contentBlocks to build finalPrompt and file args
    let finalPrompt = prompt || '';
    const filePaths = [];

    if (Array.isArray(contentBlocks) && contentBlocks.length > 0) {
      console.log('[KILO CONTENT BLOCKS] processing', { blocksCount: contentBlocks.length });

      for (const block of contentBlocks) {
        if (block.type === 'text' && block.text) {
          if (block.text !== prompt) {
            finalPrompt = (finalPrompt ? finalPrompt + '\n\n' : '') + block.text;
          }
        } else if ((block.type === 'image' || block.type === 'file') && block.source?.data) {
          const ext = block.type === 'image' ? (block.mimeType?.split('/')[1] || 'png') : 'txt';
          const tmpFile = path.join(os.tmpdir(), `kilo-attachment-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
          try {
            fs.writeFileSync(tmpFile, Buffer.from(block.source.data, 'base64'));
            filePaths.push(tmpFile);
            console.log('[KILO CONTENT BLOCKS] wrote temp file', { path: tmpFile, type: block.type });
          } catch (e) {
            console.error('[KILO CONTENT BLOCKS] failed to write temp file:', e.message);
          }
        }
      }
      console.log('[KILO FINAL PROMPT]', { finalPromptLen: finalPrompt?.length || 0, hasFiles: filePaths.length });
    }

    // Use only supported kilo run arguments
    const args = ['run'];

    // Supported arguments for kilo run
    if (model) args.push('--model', MODEL_MAP[model] || model);

    // Session handling: --session to continue, --fork to fork before continuing
    if (sessionId) {
      args.push('--session', sessionId);
      if (forkSession) args.push('--fork');
    }

    // Agent mapping for CLI
    const validAgents = ['code', 'ask', 'plan', 'debug', 'orchestrator'];
    // Map high-level modes to specific agents (same mapping as UI)
    const modeMap = { auto: 'code', planning: 'plan', task: 'code' };
    const mappedMode = modeMap[mode] || mode;
    if (mappedMode && validAgents.includes(mappedMode)) {
      args.push('--agent', mappedMode);
    }

    // Format and permissions
    args.push('--format', 'json');
    if (thinking) args.push('--thinking');
    args.push('--dangerously-skip-permissions');

    // Add file attachments
    for (const fp of filePaths) {
      args.push('--file', fp);
    }

    // Add the message as positional arguments (Kilo expects: kilo run "message")
    // Split by spaces but preserve as separate args - Kilo handles this
    if (finalPrompt) {
      // Pass as single argument to preserve the full message
      args.push(finalPrompt);
    }

    // Unset CLAUDECODE to allow nested invocation from dev environment.
    const env = { ...process.env, ...(extraEnv || {}) };
    delete env.CLAUDECODE;
    // When ANTHROPIC_BASE_URL is set the user is routing through a proxy (e.g. LiteLLM)
    // and needs ANTHROPIC_API_KEY for auth.  Only strip the key when talking directly to
    // Anthropic so the CLI subprocess falls back to Max subscription (otherwise the CLI
    // prompts for API-key configuration on closed stdin and hangs).
    if (!env.ANTHROPIC_BASE_URL) {
      delete env.ANTHROPIC_API_KEY;
    }

    // On Windows .cmd/.bat files require cmd.exe (shell:true) to execute.
    // On Unix, we use shell:true to properly handle multi-word message arguments
    const needsShell = process.platform === 'win32' &&
/\.(cmd|bat)$/i.test(this.kiloBin);

    console.log('[KILO SPAWN] cwd:', this.cwd, 'shell:', needsShell);

    // Log the complete command being executed
    console.log('[KILO ARGS]', JSON.stringify(args, null, 2));
    console.log('[KILO EXEC]', this.kiloBin, args.join(' '));

    const proc = spawn(this.kiloBin, args, {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: needsShell,
    });

    // Declare variables for process management
    let _finished = false, _abortListener = null, globalTimer = null, sigkillTimer = null;
    let detectedSid = null, stderrBuf = '', mcpHash = null;
    let attFiles = [], attDir = null;

    // Create decoders for stream processing
    const { StringDecoder } = require('string_decoder');
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let buffer = '';

    // Create handlers object
    const h = {};

    // Close stdin immediately (non-interactive)
    proc.stdin.end();
    console.log('[KILO SPAWN] spawning process, stdin closed, cwd:', this.cwd);

    proc.stdout.on('data', (chunk) => {
      buffer += stdoutDecoder.write(chunk);
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          this._handle(data, h);
        } catch (err) {
          console.error('[kilo-cli] failed to parse line:', line.slice(0, 200), err);
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const str = stderrDecoder.write(chunk);
      if (str.trim()) console.log('[KILO STDERR]', str.slice(0, 300).replace(/\n/g, '\\n'));
      if (stderrBuf.length < 8192) stderrBuf += str.slice(0, 8192 - stderrBuf.length);
      if (stderrBuf.length < 8192) stderrBuf += str.slice(0, 8192 - stderrBuf.length);
      // Extract session ID from stderr
      const sm = str.match(/Session:\s*([a-f0-9-]+)/i)
        || str.match(/session[_\s]*id[:\s]*([a-f0-9-]+)/i)
        || str.match(/Resuming session\s+([a-f0-9-]+)/i);
      if (sm && !detectedSid) {
        detectedSid = sm[1];
        h._detectedSid = detectedSid;
        if (h.onSessionId) h.onSessionId(detectedSid);
      }
    });

proc.on('close', (code) => {
      if (_finished) return; _finished = true;

      // Cleanup temp attachment files
      for (const fp of filePaths) {
        try { fs.unlinkSync(fp); } catch {}
      }

      // Remove abort listener to prevent GC leak (listener holds proc reference)
      if (abortController && _abortListener) {
        abortController.signal.removeEventListener('abort', _abortListener);
        _abortListener = null;
      }
      // Clear both timers — process already exited
      if (globalTimer) { clearTimeout(globalTimer); globalTimer = null; }
      if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = null; }
      // Flush remaining buffer (including any incomplete multi-byte sequence held by the decoder)
      buffer += stdoutDecoder.end();
      // Parse any remaining complete lines in buffer
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          this._handle(data, h);
        } catch (err) {
          console.error('[kilo-cli] failed to parse remaining line:', line.slice(0, 200), err);
        }
      }
      // Handle any remaining buffer content
      if (buffer.trim()) {
        try {
          this._handle(JSON.parse(buffer), h);
        } catch {
          const tail = buffer.trim();
          const looksLikeStructuredTail = /^[{\[]/.test(tail) || /"type"\s*:/.test(tail);
          if (looksLikeStructuredTail) {
            console.warn('[kilo-cli] Dropping unparseable trailing stream-json chunk');
          } else {
            try { if (h.onText) h.onText(buffer); } catch {}
          }
        }
      }
      releaseMcpConfig(mcpHash); mcpHash = null;
      if (code !== 0 && stderrBuf.trim() && h.onError) {
        // Filter out known non-error noise (MCP loading messages) line-by-line,
        // then report any remaining real error lines to the caller.
        const realErrors = stderrBuf.trim().split('\n')
          .filter(l => l.trim() && !l.includes('Loaded MCP') && !l.includes('Starting MCP'))
          .join('\n').trim();
        if (realErrors) {
          // Wrapped in try-catch: if the callback throws (e.g. ws.send on closed socket),
          // onDone must still fire so the caller's Promise always settles.
          try { h.onError(realErrors.substring(0, 1000)); } catch {}
        }
      }
      if (h.onDone) h.onDone(detectedSid || h._detectedSid);
    });

    proc.on('error', (err) => {
      if (_finished) return; _finished = true;
      // Remove abort listener to prevent GC leak
      if (abortController && _abortListener) {
        abortController.signal.removeEventListener('abort', _abortListener);
        _abortListener = null;
      }
      if (globalTimer) { clearTimeout(globalTimer); globalTimer = null; }
      if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = null; }
      // Clean up MCP config and temp attachments even when the process fails to start
      releaseMcpConfig(mcpHash); mcpHash = null;
      for (const f of attFiles) { try { fs.unlinkSync(f); } catch {} }
      if (attDir) { try { fs.rmSync(attDir, { recursive: true, force: true }); } catch {} attDir = null; }
      attFiles = [];
      // Wrapped in try-catch for the same reason as in 'close': onDone must always fire.
      try { if (h.onError) h.onError(`Failed to start kilo: ${err.message}. Binary: ${this.kiloBin}`); } catch {}
      if (h.onDone) h.onDone(detectedSid || h._detectedSid);
    });

    // Global timeout — must be set after all declarations to avoid TDZ with let
    globalTimer = setTimeout(() => {
      globalTimer = null;
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      try { if (h.onError) h.onError('Claude subprocess timed out'); } catch {}
      killProc(proc);
      // Escalate to SIGKILL after 3 s (Unix only — on Windows killProc already force-kills)
      if (process.platform !== 'win32') {
        if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = null; }
        sigkillTimer = setTimeout(() => {
          sigkillTimer = null;
          if (proc.exitCode !== null || proc.signalCode !== null) return;
          try { proc.kill('SIGKILL'); } catch {}
        }, 3000);
      }
    }, MAX_SUBPROCESS_MS);

    if (abortController) {
      _abortListener = () => {
        killProc(proc);
        // Escalate to SIGKILL after 3 s (Unix only — on Windows killProc already force-kills).
        // Guard: if proc already exited (exitCode/signalCode set), skip to avoid
        // hitting a new process that the OS reused the same PID for.
        if (process.platform !== 'win32') {
          if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = null; }
          sigkillTimer = setTimeout(() => {
            sigkillTimer = null;
            if (proc.exitCode !== null || proc.signalCode !== null) return;
            try { proc.kill('SIGKILL'); } catch {}
          }, 3000);
        }
      };
      abortController.signal.addEventListener('abort', _abortListener);
    }

    return {
      onText(fn) { h.onText = fn; return this; },
      onTool(fn) { h.onTool = fn; return this; },
      onDone(fn) { h.onDone = fn; return this; },
      onError(fn) { h.onError = fn; return this; },
      onSessionId(fn) { h.onSessionId = fn; return this; },
      onReasoning(fn) { h.onReasoning = fn; return this; },
      onRateLimit(fn) { h.onRateLimit = fn; return this; },
      onResult(fn) { h.onResult = fn; return this; },
      onStepStart(fn) { h.onStepStart = fn; return this; },
      onStepFinish(fn) { h.onStepFinish = fn; return this; },
      process: proc,
    };
  }

  _handle(data, h) {
    // Reset per-block delta tracking at the start of each assistant turn
    if (data.type === 'message_start') {
      h._deltaBlocks = new Set();
      h._hasEmittedText = false;
    }

    // Inject paragraph separator between text blocks so post-tool text doesn't
    // run together with pre-tool text. Covers both:
    // - Same-turn: text(index:0) → tool(index:1) → text(index:2) — index > 0
    // - Cross-turn: turn1 text → tool → turn2 text(index:0) — index resets to 0
    // Using _hasEmittedText flag to detect cross-turn boundaries.
    if (data.type === 'content_block_start' && data.content_block?.type === 'text' && h.onText) {
      if (h._hasEmittedText) {
        h.onText('\n\n');
      }
    }

    // Handle streaming delta events (Anthropic API streaming format used by newer CLI versions)
    if (data.type === 'content_block_delta' && data.delta) {
      const idx = data.index ?? 0;
      if (data.delta.type === 'text_delta' && data.delta.text && h.onText) {
        h._deltaBlocks.add(idx);
        h._hasEmittedText = true;
        h.onText(data.delta.text);
      } else if (data.delta.type === 'thinking_delta' && data.delta.thinking) {
        h._deltaBlocks.add(idx);
        if (h.onReasoning) h.onReasoning(data.delta.thinking);
      }
    }
    // Handle assistant messages with content blocks (legacy format / tool_use)
    // Skip text/thinking for blocks already streamed via content_block_delta (per-block check)
    if (data.type === 'assistant' || data.role === 'assistant') {
      const content = data.content || data.message?.content || [];
      const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content) }];
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        const streamed = h._deltaBlocks.has(i);
        if (b.type === 'text' && b.text && h.onText && !streamed) { h._hasEmittedText = true; h.onText(b.text); }
        else if (b.type === 'thinking' && b.thinking && !streamed) {
          if (h.onReasoning) h.onReasoning(b.thinking);
        }
        else if (b.type === 'tool_use' && h.onTool) {
          h.onTool(b.name, typeof b.input === 'string' ? b.input : JSON.stringify(b.input, null, 2));
        }
      }
    }
    // Rate limit event
    if (data.type === 'rate_limit_event' && data.rate_limit_info && h.onRateLimit) {
      h.onRateLimit(data.rate_limit_info);
    }
    // Step start event
    if (data.type === 'step_start' && h.onStepStart) {
      h.onStepStart(data);
    }
    // Step finish event
    if (data.type === 'step_finish' && h.onStepFinish) {
      h.onStepFinish(data);
    }
    // Result message — emitted at end of stream with session_id, subtype, num_turns etc.
    // subtype: "success" | "error_max_turns" | "error_during_execution" | "error_max_budget_usd" | ...
    if (data.type === 'result' && h.onResult) {
      h.onResult(data);
    }
    // Session ID in result messages — ensure it's a clean string (not object/nested JSON)
    if (data.session_id && !h._detectedSid && h.onSessionId) {
      const sid = typeof data.session_id === 'string' ? data.session_id
        : (typeof data.session_id === 'object' && data.session_id.session_id) ? data.session_id.session_id
        : null;
      if (sid && typeof sid === 'string') { h._detectedSid = sid; h.onSessionId(sid); }
    }
  }
}

module.exports = KiloCLI;
