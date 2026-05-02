import AgentBackend from './agent-backend.js';
import http from 'http';
import https from 'https';
import EventSource from 'eventsource';

class KiloHttpBackend extends AgentBackend {
  constructor(options = {}) {
    super();
    // Use Kilo AI Gateway API instead of local server
    this.serverUrl = 'https://api.kilo.ai';
    this.apiKey = options.apiKey || process.env.KILO_API_KEY;
    this.timeout = options.timeout || 30000;
    this.directory = options.cwd || process.cwd();

    if (!this.apiKey) {
      throw new Error('KILO_API_KEY environment variable is required for Kilo AI Gateway');
    }

    console.log('[KiloHttpBackend] initialized for Kilo AI Gateway, directory:', this.directory);
  }

  send(options) {
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
      settingSources,
      forkSession,
      addDirs,
      extraEnv,
      extraSettings,
      tools,
      thinking,
      mode,
    } = options;

    console.log('[KiloHttpBackend.send] starting Gateway API request', {
      sessionId,
      model,
      mode,
      thinking
    });

    // Handlers object for callbacks
    const h = {};

    // Start the process asynchronously
    setImmediate(async () => {
      try {
        // Prepare messages for OpenAI-compatible API
        const messages = [];

        // Add system message if provided
        if (systemPrompt) {
          messages.push({ role: 'system', content: systemPrompt });
        }

        // Add user message
        let userContent = prompt || '';

        // Add content blocks
        if (Array.isArray(contentBlocks)) {
          for (const block of contentBlocks) {
            if (block.type === 'text' && block.text) {
              userContent += (userContent ? '\n\n' : '') + block.text;
            }
            // For images/files, we could add them as base64, but for simplicity skip for now
          }
        }

        messages.push({ role: 'user', content: userContent });

        // Determine model
        const actualModel = model || 'kilo/kilo-auto/free';
        const modelName = actualModel.replace('kilo/', ''); // Remove provider prefix

        console.log('[KiloHttpBackend] sending to Gateway API with model:', modelName);

        // Make request to Gateway API
        const response = await this._makeGatewayRequest(messages, modelName, thinking, abortController);

        // Process the response
        if (response.choices && response.choices[0]) {
          const content = response.choices[0].message?.content || '';
          if (content && h.onText) {
            // Simulate streaming by sending content in chunks
            const chunks = content.split(' ');
            for (const chunk of chunks) {
              if (chunk) {
                h.onText(chunk + ' ');
                await new Promise(resolve => setTimeout(resolve, 50)); // Small delay to simulate streaming
              }
            }
          }
        }

        if (h.onDone) h.onDone(sessionId);

      } catch (error) {
        console.error('[KiloHttpBackend] Gateway API error:', error);
        if (h.onError) h.onError(`Gateway API request failed: ${error.message}`);
        if (h.onDone) h.onDone(sessionId);
      }
    });

    // Return handler interface matching KiloCLI
    return {
      onText(fn) { h.onText = fn; return this; },
      onTool(fn) { h.onTool = fn; return this; },
      onDone(fn) { h.onDone = fn; return this; },
      onError(fn) { h.onError = fn; return this; },
      onSessionId(fn) { h.onSessionId = fn; return this; },
      onThinking(fn) { h.onThinking = fn; return this; },
      onReasoning(fn) { h.onReasoning = fn; return this; },
      onRateLimit(fn) { h.onRateLimit = fn; return this; },
      onResult(fn) { h.onResult = fn; return this; },
      onStepStart(fn) { h.onStepStart = fn; return this; },
      onStepFinish(fn) { h.onStepFinish = fn; return this; },
    };
  }

  async _makeGatewayRequest(messages, model, thinking = false, abortController = null) {
    const body = {
      model: model,
      messages: messages,
      stream: false, // For simplicity, disable streaming for now
      temperature: thinking ? 0.1 : 0.7, // Lower temperature for thinking mode
    };

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.kilo.ai',
        port: 443,
        path: '/api/gateway/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        timeout: this.timeout
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode === 401) {
              reject(new Error('Invalid API key'));
              return;
            }
            if (res.statusCode !== 200) {
              reject(new Error(`Gateway API returned ${res.statusCode}: ${data}`));
              return;
            }

            const response = JSON.parse(data);
            resolve(response);
          } catch (e) {
            reject(new Error(`Failed to parse Gateway API response: ${e.message}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Gateway API request failed: ${error.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Gateway API request timed out'));
      });

      if (abortController) {
        abortController.signal.addEventListener('abort', () => {
          req.destroy();
          reject(new Error('Request aborted'));
        });
      }

      req.write(JSON.stringify(body));
      req.end();
    });
  }

  async _makeRequest(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.serverUrl);
      const options = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
          'x-opencode-directory': this.directory
        },
        timeout: this.timeout
      };

      const req = this.httpModule.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const response = {
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              statusText: res.statusMessage || '',
              body: data ? JSON.parse(data) : null,
              headers: res.headers
            };
            resolve(response);
          } catch (e) {
            const response = {
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              statusText: res.statusMessage || '',
              body: { error: 'Invalid JSON response', raw: data },
              headers: res.headers
            };
            resolve(response);
          }
        });
      });

      req.on('error', (error) => {
        if (error.code === 'ECONNREFUSED') {
          reject(new Error(`Cannot connect to Kilo server at ${this.serverUrl}. Make sure Kilo is running.`));
        } else if (error.code === 'ENOTFOUND') {
          reject(new Error(`Kilo server hostname not found: ${url.hostname}`));
        } else if (error.code === 'ETIMEDOUT') {
          reject(new Error(`Connection to Kilo server timed out after ${this.timeout}ms`));
        } else {
          reject(error);
        }
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timed out after ${this.timeout}ms`));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }



  async getStatus() {
    try {
      // Try to create a temporary session to test connectivity
      const testSession = await this._createSession();
      return { status: 'ok', message: 'Server is responding' };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  }

  async setMode(mode) {
    // Not implemented for HTTP backend
    console.log('[KiloHttpBackend] setMode not implemented:', mode);
  }

  async setModel(model) {
    // Not implemented for HTTP backend
    console.log('[KiloHttpBackend] setModel not implemented:', model);
  }

  async manageSession(sessionId, action) {
    // Not implemented for HTTP backend
    console.log('[KiloHttpBackend] manageSession not implemented:', sessionId, action);
  }
}

export default KiloHttpBackend;