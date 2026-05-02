const KiloCLI = require('../kilo-cli');
const KiloBackend = require('./kilo-backend');
const KiloHttpBackend = require('./kilo-http-backend');
const KiloAgentBackend = (await import('./kilo-agent-backend.mjs')).default;

class BackendFactory {
  static createBackend(engine, options = {}) {
    const engineType = (engine || '').toLowerCase();

    // Local kilo serve backend (connects to running kilo serve instance)
    if (engineType === 'kilo-agent' || engineType === 'kilo-local' || engineType === 'local') {
      return new KiloAgentBackend(options);
    }

    // Gateway API backend (explicit)
    if (engineType === 'kilo-gateway' || engineType === 'gateway') {
      return new KiloHttpBackend(options);
    }

    // Fallback to CLI backend if explicitly requested or for compatibility
    if (engine === 'kilo-cli') {
      return new KiloBackend(options);
    }

    // Default: auto-detect based on environment
    // If KILO_SERVER_URL is set, prefer local server
    if (process.env.KILO_SERVER_URL) {
      return new KiloAgentBackend(options);
    }

    // Default to HTTP backend for server mode (Gateway API)
    if (!engine || engine === 'kilo') {
      return new KiloHttpBackend(options);
    }

    // Default fallback
    return new KiloHttpBackend(options);
  }

  static isEngineAvailable(engine) {
    const engineType = (engine || '').toLowerCase();

    if (engineType === 'kilo-agent' || engineType === 'kilo-local' || engineType === 'local') {
      // Check if kilo serve is reachable
      try {
        const http = require('http');
        const url = new URL(process.env.KILO_SERVER_URL || 'http://127.0.0.1:4097');
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

    if (engineType === 'kilo-gateway' || engineType === 'gateway') {
      // Gateway availability check (will be done at request time with API key validation)
      return !!process.env.KILO_API_KEY;
    }

    if (engineType === 'kilo') {
      try {
        const { execSync } = require('child_process');
        execSync('which kilo', { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }
}

module.exports = BackendFactory;