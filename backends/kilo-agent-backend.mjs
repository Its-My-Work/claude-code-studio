import AgentBackend from './agent-backend.js';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const _clientCache = new Map();

function writeLog(logFile, eventType, data) {
  try {
    const entry = { timestamp: new Date().toISOString(), eventType, data };
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[KiloAgentBackend] Log write error:', err.message);
  }
}

async function getKiloClient(config) {
  const key = `${config.baseUrl}:${config.directory || ''}`;
  if (!_clientCache.has(key)) {
    const { createKiloClient } = await import('@kilocode/sdk');
    _clientCache.set(key, createKiloClient(config));
  }
  return _clientCache.get(key);
}

class KiloAgentBackend extends AgentBackend {
  constructor(options = {}) {
    super();
    this.serverUrl = options.serverUrl || process.env.KILO_SERVER_URL || 'http://127.0.0.1:4098';
    this.directory = options.directory || options.cwd || process.cwd();
    this.timeout = options.timeout || 30000;
    this.debug = options.debug || false;
    this._abortControllers = new Set();
  }

  log(...args) {
    if (this.debug) console.log('[KiloAgentBackend]', ...args);
  }

  async _getClient() {
    return getKiloClient({ baseUrl: this.serverUrl, directory: this.directory });
  }

  send(options) {
    return this.runNativeStreamMode(options);
  }

  runNativeStreamMode(options) {
    const {
      prompt,
      contentBlocks,
      sessionId,
      model,
      maxTurns,
      abortController,
      mode,
    } = options;

    this.log('runNativeStreamMode() starting', { sessionId, model, mode, promptLength: prompt?.length || 0 });

    const h = {};
    let activeEventSub = null;
    let isDone = false;
    let currentSessionId = sessionId;
    let fullText = '';

    let fullPrompt = prompt || '';
    if (Array.isArray(contentBlocks)) {
      for (const block of contentBlocks) {
        if (block.type === 'text' && block.text) {
          if (block.text !== prompt) {
            fullPrompt = (fullPrompt ? fullPrompt + '\n\n' : '') + block.text;
          }
        }
      }
    }

    const result = {
      onText(fn) { h.onText = fn; return this; },
      onTool(fn) { h.onTool = fn; return this; },
      onDone(fn) { h.onDone = fn; return this; },
      onError(fn) { h.onError = fn; return this; },
      onSessionId(fn) { h.onSessionId = fn; return this; },
      onReasoning(fn) { h.onReasoning = fn; return this; },
      onResult(fn) { h.onResult = fn; return this; },
      onRateLimit(fn) { h.onRateLimit = fn; return this; },
      onStepStart(fn) { h.onStepStart = fn; return this; },
      onStepFinish(fn) { h.onStepFinish = fn; return this; },
    };

    const requestId = randomUUID();
    const logDir = path.join(process.cwd(), 'logs');
    const logFile = path.join(logDir, `${sessionId || 'new'}_${requestId}.log`);

    try {
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      writeLog(logFile, 'request_start', {
        requestId,
        sessionId,
        model,
        mode,
        promptLength: fullPrompt.length,
        prompt: fullPrompt.substring(0, 500),
      });
    } catch (err) {
      console.error('[KiloAgentBackend] Failed to init log file:', err.message);
    }

    const cleanup = () => {
      if (activeEventSub) {
        try { activeEventSub.unsubscribe?.(); } catch {}
        activeEventSub = null;
      }
      this._abortControllers.clear();
    };

    const handleAbort = () => {
      if (isDone) return;
      isDone = true;
      cleanup();
      writeLog(logFile, 'request_aborted', { sessionId: currentSessionId });
      if (h.onError) h.onError('Request aborted');
      if (h.onDone) h.onDone(currentSessionId);
    };

    if (abortController) {
      this._abortControllers.add(abortController);
      abortController.signal.addEventListener('abort', handleAbort);
    }

    (async () => {
      try {
        const client = await this._getClient();

        if (!currentSessionId) {
          this.log('creating new session');
          const sess = await client.session.create({
            body: {
              title: fullPrompt.substring(0, 100),
              workdir: this.directory,
            },
          });
          currentSessionId = sess.data?.id || sess.sessionID;
          writeLog(logFile, 'session_created', { sessionId: currentSessionId });
          this.log('created session:', currentSessionId);
          if (h.onSessionId) h.onSessionId(currentSessionId);
        }

        writeLog(logFile, 'sse_subscribing', { sessionId: currentSessionId, directory: this.directory });

        // Start SSE subscription in background - it will receive status updates
        // Even if session is already idle, we subscribe first to catch any late events
        let eventSubPromise = client.global.event({
          query: { directory: this.directory, sessionID: currentSessionId },
          onSseEvent: (event) => {
            const data = event.data?.payload || event.data;
            const rawType = data?.type;

            if (data?.properties?.sessionID && data.properties.sessionID !== currentSessionId) {
              return;
            }

            writeLog(logFile, 'sse_event', { rawType, data: JSON.stringify(data).substring(0, 500) });

            switch (rawType) {
              case 'message.part.updated': {
                const part = data.properties?.part;
                if (!part) break;

                if (part.type === 'text' && part.text) {
                  fullText += part.text;
                  writeLog(logFile, 'text_chunk', { text: part.text });
                  if (h.onText) h.onText(part.text);
                } else if (part.type === 'reasoning' && part.text) {
                  writeLog(logFile, 'reasoning', { text: part.text });
                  if (h.onReasoning) h.onReasoning(part.text);
                } else if (part.type === 'tool' && h.onTool) {
                  const input = typeof part.input === 'string'
                    ? part.input
                    : JSON.stringify(part.input || {});
                  writeLog(logFile, 'tool_call', { tool: part.tool, input });
                  writeLog(logFile, 'tool_use', { tool: part.tool, input });
                  writeLog(logFile, 'tool_use_start', { tool: part.tool, input });
                  if (!['ask_user', 'notify_user', 'set_ui_state', 'check_user_messages'].includes(part.tool)) {
                    h.onTool(part.tool, input);
                  }
                }
                break;
              }
              case 'session.status':
              case 'session_state': {
                const statusType = data.properties?.status?.type || data.status?.type || data?.status;
                if ((statusType === 'idle' || statusType === 'completed') && !isDone) {
                  isDone = true;
                  cleanup();
                  writeLog(logFile, 'session_idle', { sessionId: currentSessionId, statusType });
                  if (h.onDone) h.onDone(currentSessionId);
                }
                break;
              }
              case 'step_start':
              case 'step.running': {
                if (h.onStepStart) h.onStepStart(data.properties || data);
                break;
              }
              case 'step_finish':
              case 'step.completed': {
                writeLog(logFile, 'step_finish', { properties: data.properties });
                if (h.onStepFinish) h.onStepFinish(data.properties || data);
                break;
              }
              case 'tool_error':
              case 'tool.failure': {
                writeLog(logFile, 'tool_error', {
                  tool: data.tool || data.properties?.tool,
                  error: data.error || data.properties?.error,
                });
                break;
              }
              case 'rate_limit_event':
              case 'rate_limit': {
                const rateLimitInfo = data.rate_limit_info || data.properties?.rateLimitInfo || {};
                if (h.onRateLimit) h.onRateLimit(rateLimitInfo);
                break;
              }
            }
          },
          onSseError: (err) => {
            writeLog(logFile, 'sse_error', { error: err?.message || err });
            if (!isDone) {
              isDone = true;
              cleanup();
              if (h.onError) h.onError(`Stream error: ${err?.message || err}`);
              if (h.onDone) h.onDone(currentSessionId);
            }
          },
        });

        writeLog(logFile, 'prompt_sending', { sessionId: currentSessionId, promptLength: fullPrompt.length });

        const promptResult = await client.session.prompt({
          path: { id: currentSessionId },
          body: {
            parts: [{ type: 'text', text: fullPrompt }],
            model: { providerID: 'kilo', modelID: 'kilo-auto/free' },
            maxTurns,
          },
        });

        writeLog(logFile, 'prompt_response_received', {
          partsCount: promptResult.data?.parts?.length || 0,
          hasError: !!promptResult.error
        });

        // Store eventSub after prompt is done - we just need it for potential late status events
        activeEventSub = await eventSubPromise;

        // Emit result data for task worker to check subtype
        const resultData = promptResult.data || {};
        if (h.onResult) {
h.onResult({
              ...resultData,
              subtype: resultData.subtype || 'success',
            });
          }

          if (promptResult.data?.parts) {
          for (const part of promptResult.data.parts) {
            if (part.type === 'text' && part.text) {
              fullText += part.text;
              writeLog(logFile, 'text_final', { text: part.text });
              if (h.onText) h.onText(part.text);
            } else if (part.type === 'reasoning' && part.text) {
              writeLog(logFile, 'reasoning_final', { text: part.text });
              if (h.onReasoning) h.onReasoning(part.text);
            } else if (part.type === 'tool' && h.onTool && !['ask_user', 'notify_user', 'set_ui_state', 'check_user_messages'].includes(part.tool)) {
              const input = typeof part.input === 'string'
                ? part.input
                : JSON.stringify(part.input || {});
              writeLog(logFile, 'tool_call', { tool: part.tool, input });
              writeLog(logFile, 'tool_use', { tool: part.tool, input });
              writeLog(logFile, 'tool_use_start', { tool: part.tool, input });
              writeLog(logFile, 'tool_execution', { tool: part.tool });
              writeLog(logFile, 'tool_result', { tool: part.tool, result: part.result || part.output || null });
              h.onTool(part.tool, input);
            }
          }
        }

        writeLog(logFile, 'prompt_response_processed', {
          sessionId: currentSessionId,
          totalTextLength: fullText.length,
        });

        // If not already done by SSE, call onDone via fallback (session may have completed synchronously)
        // This handles the case where prompt returns immediately with results and no further SSE events come
        setTimeout(() => {
          if (!isDone) {
            isDone = true;
            cleanup();
            writeLog(logFile, 'fallback_timeout_or_sync_completion', { sessionId: currentSessionId });
            if (h.onDone) h.onDone(currentSessionId);
          }
        }, 0);

        // Also set a longer timeout as safety net for stuck requests
        setTimeout(() => {
          if (!isDone) {
            isDone = true;
            cleanup();
            writeLog(logFile, 'safety_timeout', { sessionId: currentSessionId });
            if (h.onDone) h.onDone(currentSessionId);
          }
        }, this.timeout);

      } catch (error) {
        writeLog(logFile, 'request_error', { error: error.message, stack: error.stack });
        this.log('send error:', error);
        isDone = true;
        cleanup();
        if (h.onError) h.onError(`Kilo Agent API error: ${error.message}`);
        if (h.onDone) h.onDone(sessionId);
      }
    })();

    return result;
  }

  async getStatus() {
    try {
      const client = await this._getClient();
      await client.config.get();
      return { status: 'ok', message: 'Local Kilo server is responding' };
    } catch (error) {
      return { status: 'error', message: `Cannot connect to local Kilo server: ${error.message}` };
    }
  }

  async setMode(mode) {
    this.log('setMode:', mode);
  }

  async setModel(model) {
    this.log('setModel:', model);
  }

  async manageSession(sessionId, action) {
    this.log('manageSession:', { sessionId, action });
    try {
      const client = await this._getClient();
      switch (action) {
        case 'delete':
          await client.session.delete({ path: { id: sessionId } });
          break;
        case 'get':
          return await client.session.get({ path: { id: sessionId } });
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      console.error('[KiloAgentBackend] manageSession error:', error);
      throw error;
    }
  }
}

export default KiloAgentBackend;