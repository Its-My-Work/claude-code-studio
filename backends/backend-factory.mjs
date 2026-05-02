class BackendFactory {
  static async createBackend(engine, options = {}) {
    const engineType = (engine || '').toLowerCase();

    // Local kilo serve backend (connects to running kilo serve instance)
    if (engineType === 'kilo-agent' || engineType === 'kilo-local' || engineType === 'local') {
      const streamMode = process.env.KILO_STREAM_MODE || options.streamMode || 'prompt';
      const { default: KiloAgentBackend } = await import('./kilo-agent-backend.mjs');
      return new KiloAgentBackend({ ...options, streamMode });
    }

    // Default: auto-detect based on environment
    // If KILO_SERVER_URL is set, prefer local server
    const streamMode = process.env.KILO_STREAM_MODE || options.streamMode || 'prompt';
    const { default: KiloAgentBackend } = await import('./kilo-agent-backend.mjs');
    return new KiloAgentBackend({ ...options, streamMode });
  }

  static isEngineAvailable(engine) {
    const engineType = (engine || '').toLowerCase();

    if (engineType === 'kilo-agent' || engineType === 'kilo-local' || engineType === 'local') {
      try {
        const http = require('http');
        const url = new URL(process.env.KILO_SERVER_URL || 'http://127.0.0.1:4098');
        const req = http.request({
          hostname: url.hostname,
          port: url.port,
          path: '/config',
          method: 'GET',
          timeout: 2000,
        }, (res) => {
          if (res.statusCode < 500) {
            res.resume();
          }
        });
        req.on('error', () => {});
        req.on('timeout', () => req.destroy());
        req.end();
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }
}

export default BackendFactory;