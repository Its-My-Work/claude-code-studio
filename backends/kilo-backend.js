/**
 * KiloBackend - реализация AgentBackend для Claude Code
 * Обертка над KiloCLI для совместимости с интерфейсом AgentBackend
 */

const AgentBackend = require('./agent-backend');
const KiloCLI = require('../kilo-cli');

class KiloBackend extends AgentBackend {
  constructor(options = {}) {
    super();
    this.kiloCLI = new KiloCLI(options);
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

    // Вызвать Kilo CLI
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
    });
  }

  /**
   * Получить статус агента
   */
  async getStatus() {
    return {
      backend: 'kilo',
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

module.exports = KiloBackend;
