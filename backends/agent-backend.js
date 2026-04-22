/**
 * AgentBackend - интерфейс для различных AI backend'ов
 * Позволяет переключаться между Claude Code и Kilo Code
 */

class AgentBackend {
  /**
   * Отправить сообщение агенту
   * @param {Object} options
   * @param {string} options.prompt - основное сообщение
   * @param {Array} options.contentBlocks - прикрепленные файлы/изображения
   * @param {string} options.sessionId - ID сессии для восстановления
   * @param {string} options.model - модель (haiku/sonnet/opus)
   * @param {number} options.maxTurns - максимум итераций
   * @param {string} options.mode - режим (planning/task/auto)
   * @param {Object} options.mcpServers - MCP серверы
   * @param {string} options.systemPrompt - системный промпт
   * @param {Array} options.allowedTools - разрешенные инструменты
   * @param {AbortController} options.abortController - для отмены
   * @returns {Object} объект с методами .onText(), .onTool(), .onError(), .onDone()
   */
  send(options) {
    throw new Error('send() must be implemented by subclass');
  }

  /**
   * Получить статус агента
   * @returns {Promise<Object>}
   */
  async getStatus() {
    throw new Error('getStatus() must be implemented by subclass');
  }

  /**
   * Установить режим
   * @param {string} mode - режим (planning/task/auto)
   */
  async setMode(mode) {
    throw new Error('setMode() must be implemented by subclass');
  }

  /**
   * Установить модель
   * @param {string} model - модель (haiku/sonnet/opus)
   */
  async setModel(model) {
    throw new Error('setModel() must be implemented by subclass');
  }

  /**
   * Управление сессией
   * @param {string} sessionId - ID сессии
   * @param {string} action - действие (resume/fork/delete)
   */
  async manageSession(sessionId, action) {
    throw new Error('manageSession() must be implemented by subclass');
  }
}

module.exports = AgentBackend;
