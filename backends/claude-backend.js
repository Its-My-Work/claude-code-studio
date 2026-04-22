/**
 * ClaudeBackend - реализация AgentBackend для Claude Code
 * Обертка над ClaudeCLI для совместимости с интерфейсом AgentBackend
 */

const AgentBackend = require('./agent-backend');
const ClaudeCLI = require('../claude-cli');

class ClaudeBackend extends AgentBackend {
  constructor(options = {}) {
    super();
    this.claudeCLI = new ClaudeCLI(options);
  }

  /**
   * Отправить сообщение Claude
   * @param {Object} options
   * @returns {Object} объект с методами подписки
   */
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
      mode,
      workdir,
      settingSources,
      forkSession,
      addDirs,
      extraEnv,
      extraSettings,
      tools,
    } = options;

    // Вызвать Claude CLI
    return this.claudeCLI.send({
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
    });
  }

  /**
   * Получить статус агента
   */
  async getStatus() {
    return {
      backend: 'claude',
      version: 'latest',
    };
  }

  /**
   * Установить режим
   */
  async setMode(mode) {
    // Claude не поддерживает динамическую смену режима
  }

  /**
   * Установить модель
   */
  async setModel(model) {
    // Claude не поддерживает динамическую смену модели
  }

  /**
   * Управление сессией
   */
  async manageSession(sessionId, action) {
    // Claude управляет сессиями через флаги CLI
  }
}

module.exports = ClaudeBackend;
