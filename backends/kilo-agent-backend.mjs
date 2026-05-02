import AgentBackend from './agent-backend.js';

// Per-directory client cache - each directory gets its own client
const _clientCache = new Map();

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
    this.streamMode = options.streamMode || 'prompt'; // 'prompt' or 'native'
    this._abortControllers = new Set();
  }

  log(...args) {
    if (this.debug) console.log('[KiloAgentBackend]', ...args);
  }

  async _getClient() {
    return getKiloClient({ baseUrl: this.serverUrl, directory: this.directory });
  }

  send(options) {
    if (this.streamMode === 'native') {
      return this.runNativeStreamMode(options);
    } else {
      return this.runPromptMode(options);
    }
  }

  runPromptMode(options) {
    const {
      prompt,
      contentBlocks,
      sessionId,
      model,
      maxTurns,
      mcpServers,
      systemPrompt,
      allowedTools,
      abortController,
      mode,
      thinking,
    } = options;

    this.log('runPromptMode() starting', { sessionId, model, mode, promptLength: prompt?.length || 0 });

    const h = {};
    let activeEventSub = null;
    let isDone = false;
    let currentSessionId = sessionId;
    let fullText = '';

    // Build full prompt from content blocks
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

    // Cleanup function
    const cleanup = () => {
      if (activeEventSub) {
        try { activeEventSub.unsubscribe?.(); } catch {}
        activeEventSub = null;
      }
      this._abortControllers.clear();
    };

    // Abort handler
    const handleAbort = () => {
      if (isDone) return;
      isDone = true;
      cleanup();
      if (h.onError) h.onError('Request aborted');
      if (h.onDone) h.onDone(currentSessionId);
    };

    if (abortController) {
      this._abortControllers.add(abortController);
      abortController.signal.addEventListener('abort', handleAbort);
    }

    // Return handler interface matching KiloCLI
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

    // Start the process asynchronously
    (async () => {
      try {
        const client = await this._getClient();

        // Create session if not provided
        if (!currentSessionId) {
          this.log('creating new session');
          const sess = await client.session.create({
            body: {
              title: fullPrompt.substring(0, 100),
              workdir: this.directory,
            },
          });
          currentSessionId = sess.data?.id || sess.sessionID;
          this.log('created session:', currentSessionId);
          if (h.onSessionId) h.onSessionId(currentSessionId);
        }

        // Subscribe to global events for streaming (AFTER session creation)
        this.log('starting SSE subscription for directory:', this.directory);
        const eventSub = await client.global.event({
          query: { directory: this.directory },
          onSseEvent: (event) => {
            const data = event.data?.payload || event.data;
            this.log('SSE event received:', data?.type, data?.properties?.sessionID || 'no sessionID');
            if (this.debug) this.log('SSE event full:', JSON.stringify(data, null, 2));

            // Check if this event is for our session
            if (data?.properties?.sessionID && data.properties.sessionID !== currentSessionId) {
              this.log('Event for different session, ignoring');
              return;
            }

            switch (data?.type) {
              case 'message.part.updated': {
                const part = data.properties?.part;
                if (!part) break;

                if (part.type === 'text' && part.text) {
                  fullText += part.text;
                  if (h.onText) h.onText(part.text);
                } else if (part.type === 'reasoning' && part.text) {
                  if (h.onReasoning) h.onReasoning(part.text);
                } else if (part.type === 'tool' && h.onTool) {
                  const toolPart = part;
                  const input = typeof toolPart.input === 'string'
                    ? toolPart.input
                    : JSON.stringify(toolPart.input || {});
                  if (!['ask_user', 'notify_user', 'set_ui_state', 'check_user_messages'].includes(toolPart.tool)) {
                    h.onTool(toolPart.tool, input);
                  }
                }
                break;
              }
              case 'session.status': {
                if (data.properties?.status?.type === 'idle' && !isDone) {
                  isDone = true;
                  cleanup();
                  if (h.onDone) h.onDone(currentSessionId);
                }
                break;
              }
              case 'step_start': {
                if (h.onStepStart) h.onStepStart(data.properties || data);
                break;
              }
              case 'step_finish': {
                if (h.onStepFinish) h.onStepFinish(data.properties || data);
                if (h.onResult && data.properties) {
                  h.onResult({
                    subtype: data.properties.reason || 'success',
                    session_id: currentSessionId,
                    cost: data.properties.cost,
                    num_turns: data.properties.numTurns,
                    duration_ms: data.properties.durationMs,
                    ...data.properties,
                  });
                }
                break;
              }
              case 'server.heartbeat':
                this.log('Received heartbeat event');
                break;
            }
          },
          onSseError: (err) => {
            this.log('SSE error:', err?.message || err);
            if (!isDone) {
              isDone = true;
              cleanup();
              if (h.onError) h.onError(`Stream error: ${err?.message || err}`);
              if (h.onDone) h.onDone(currentSessionId);
            }
          },
        });
        this.log('SSE subscription established successfully');
        activeEventSub = eventSub;

        // Send the message (prompt returns the response directly)
        this.log('sending prompt to session', { sessionId: currentSessionId, model });
        const promptResult = await client.session.prompt({
          path: { id: currentSessionId },
          body: {
            parts: [{ type: 'text', text: fullPrompt }],
            model: { providerID: 'kilo', modelID: 'kilo-auto/free' },
            // agent: mode,
            maxTurns,
          },
        });
        this.log('prompt completed successfully');

        // Process the response directly since prompt returns the full result
        if (promptResult.data?.parts) {
           for (const part of promptResult.data.parts) {
             if (part.type === 'text' && part.text) {
               fullText += part.text;
               if (h.onText) h.onText(part.text);
             } else if (part.type === 'reasoning' && part.text) {
               if (h.onReasoning) h.onReasoning(part.text);
             } else if (part.type === 'tool' && h.onTool) {
              const input = typeof part.input === 'string'
                ? part.input
                : JSON.stringify(part.input || {});
              if (!['ask_user', 'notify_user', 'set_ui_state', 'check_user_messages'].includes(part.tool)) {
                h.onTool(part.tool, input);
              }
            }
          }
        }

        // Mark as done since we got the full response
        if (!isDone) {
          isDone = true;
          cleanup();
          if (h.onDone) h.onDone(currentSessionId);
        }

        // Prompt returns immediately; wait for idle status via events
        // Set timeout fallback
        setTimeout(() => {
          if (!isDone) {
            isDone = true;
            cleanup();
            this.log('timeout reached, calling onDone');
            if (h.onDone) h.onDone(currentSessionId);
          }
        }, this.timeout);

      } catch (error) {
        this.log('send error:', error);
        isDone = true;
        cleanup();
        if (h.onError) h.onError(`Kilo Agent API error: ${error.message}`);
        if (h.onDone) h.onDone(sessionId);
      }
    })();

    return result;
  }

  runNativeStreamMode(options) {
    const {
      prompt,
      contentBlocks,
      sessionId,
      model,
      maxTurns,
      mcpServers,
      systemPrompt,
      allowedTools,
      abortController,
      mode,
      thinking,
    } = options;

    this.log('runNativeStreamMode() starting', { sessionId, model, mode, promptLength: prompt?.length || 0 });

    const h = {};
    let activeEventSub = null;
    let isDone = false;
    let currentSessionId = sessionId;
    let fullText = '';

    // Build full prompt from content blocks
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

    // Cleanup function
    const cleanup = () => {
      if (activeEventSub) {
        try { activeEventSub.unsubscribe?.(); } catch {}
        activeEventSub = null;
      }
      this._abortControllers.clear();
    };

    // Abort handler
    const handleAbort = () => {
      if (isDone) return;
      isDone = true;
      cleanup();
      if (h.onError) h.onError('Request aborted');
      if (h.onDone) h.onDone(currentSessionId);
    };

    if (abortController) {
      this._abortControllers.add(abortController);
      abortController.signal.addEventListener('abort', handleAbort);
    }

    // Return handler interface matching KiloCLI
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

    // Start the process asynchronously
    (async () => {
      try {
        const client = await this._getClient();

        // Create session if not provided
        if (!currentSessionId) {
          this.log('creating new session');
          const sess = await client.session.create({
            body: {
              title: fullPrompt.substring(0, 100),
              workdir: this.directory,
            },
          });
          currentSessionId = sess.data?.id || sess.sessionID;
          this.log('created session:', currentSessionId);
          if (h.onSessionId) h.onSessionId(currentSessionId);
        }

        // Subscribe to global events for streaming (AFTER session creation)
        this.log('starting SSE subscription for directory:', this.directory, 'session:', currentSessionId);
        const eventSub = await client.global.event({
          query: { directory: this.directory, sessionID: currentSessionId },
          onSseEvent: (event) => {
            const data = event.data?.payload || event.data;
            this.log('SSE event received:', data?.type, data?.properties?.sessionID || 'no sessionID');
            if (this.debug) this.log('SSE event full:', JSON.stringify(data, null, 2));

            // Check if this event is for our session
            if (data?.properties?.sessionID && data.properties.sessionID !== currentSessionId) {
              this.log('Event for different session, ignoring (our session:', currentSessionId, 'event session:', data.properties.sessionID, ')');
              return;
            }

            switch (data?.type) {
              case 'message.part.updated': {
                const part = data.properties?.part;
                if (!part) break;

                if (part.type === 'text' && part.text) {
                  fullText += part.text;
                  if (h.onText) h.onText(part.text);
                } else if (part.type === 'reasoning' && part.text) {
                  if (h.onReasoning) h.onReasoning(part.text);
                } else if (part.type === 'tool' && h.onTool) {
                  const toolPart = part;
                  const input = typeof toolPart.input === 'string'
                    ? toolPart.input
                    : JSON.stringify(toolPart.input || {});
                  if (!['ask_user', 'notify_user', 'set_ui_state', 'check_user_messages'].includes(toolPart.tool)) {
                    h.onTool(toolPart.tool, input);
                  }
                }
                break;
              }
              case 'session.status': {
                if (data.properties?.status?.type === 'idle' && !isDone) {
                  isDone = true;
                  cleanup();
                  if (h.onDone) h.onDone(currentSessionId);
                }
                break;
              }
              case 'step_start': {
                if (h.onStepStart) h.onStepStart(data.properties || data);
                break;
              }
              case 'step_finish': {
                if (h.onStepFinish) h.onStepFinish(data.properties || data);
                if (h.onResult && data.properties) {
                  h.onResult({
                    subtype: data.properties.reason || 'success',
                    session_id: currentSessionId,
                    cost: data.properties.cost,
                    num_turns: data.properties.numTurns,
                    duration_ms: data.properties.durationMs,
                    ...data.properties,
                  });
                }
                break;
              }
              case 'server.heartbeat':
                this.log('Received heartbeat event');
                break;
            }
          },
          onSseError: (err) => {
            this.log('SSE error:', err?.message || err);
            if (!isDone) {
              isDone = true;
              cleanup();
              if (h.onError) h.onError(`Stream error: ${err?.message || err}`);
              if (h.onDone) h.onDone(currentSessionId);
            }
          },
        });
        this.log('SSE subscription established successfully');
        activeEventSub = eventSub;

        // Send the message and process result with simulated streaming
        this.log('sending prompt in native streaming mode', { sessionId: currentSessionId, model });
        const promptResult = await client.session.prompt({
          path: { id: currentSessionId },
          body: {
            parts: [{ type: 'text', text: fullPrompt }],
            model: { providerID: 'kilo', modelID: 'kilo-auto/free' },
            // agent: mode,
            maxTurns,
          },
        });
        this.log('prompt completed, emitting simulated streaming events');

        // Process the result with simulated streaming
        if (promptResult.data?.parts) {
          // Emit step start
          if (h.onStepStart) h.onStepStart({ step: 'agent_run' });

          for (const part of promptResult.data.parts) {
            if (part.type === 'reasoning' && part.text) {
              // Simulate streaming reasoning
              const words = part.text.split(/(\s+)/);
              for (const word of words) {
                if (word.trim()) {
                  await new Promise(resolve => setTimeout(resolve, 10));
                  if (h.onReasoning) h.onReasoning(word);
                }
              }
            } else if (part.type === 'text' && part.text) {
              // Simulate streaming text
              const words = part.text.split(/(\s+)/);
              for (const word of words) {
                if (word.trim()) {
                  await new Promise(resolve => setTimeout(resolve, 10));
                  if (h.onText) h.onText(word);
                }
              }
            } else if (part.type === 'tool' && h.onTool && !['ask_user', 'notify_user', 'set_ui_state', 'check_user_messages'].includes(part.tool)) {
              const input = typeof part.input === 'string'
                ? part.input
                : JSON.stringify(part.input || {});
              h.onTool(part.tool, input);
            }
          }

          // Emit step finish and result
          if (h.onStepFinish) h.onStepFinish({ reason: 'success' });
          if (h.onResult) {
            h.onResult({
              subtype: 'success',
              session_id: currentSessionId,
              cost: promptResult.data.info?.cost || 0,
              num_turns: 1,
              duration_ms: promptResult.data.info?.time ? (promptResult.data.info.time.completed - promptResult.data.info.time.created) : 0,
            });
          }
        }

        // Mark as done
        if (!isDone) {
          isDone = true;
          cleanup();
          if (h.onDone) h.onDone(currentSessionId);
        }

        // In native mode, we rely entirely on stream events for completion
        // Set timeout fallback in case stream doesn't complete
        setTimeout(() => {
          if (!isDone) {
            isDone = true;
            cleanup();
            this.log('timeout reached in native mode, calling onDone');
            if (h.onDone) h.onDone(currentSessionId);
          }
        }, this.timeout);

      } catch (error) {
        this.log('send error in native mode:', error);
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