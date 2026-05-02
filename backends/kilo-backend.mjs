import AgentBackend from './agent-backend.js';
import KiloCLI from '../kilo-cli.js';

class KiloBackend extends AgentBackend {
  constructor(options = {}) {
    super();
    this.kiloCLI = new KiloCLI(options);
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

    console.log('[KiloBackend.send] mode =', mode);

    return this.kiloCLI.send({
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
    });
  }
}

export default KiloBackend;