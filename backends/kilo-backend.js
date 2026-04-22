/**
 * KiloBackend - реализация AgentBackend для Kilo Code
 */

const AgentBackend = require('./agent-backend');
const KiloRunner = require('./kilo-backend/kilo-runner');
const KiloResponseParser = require('./kilo-backend/kilo-response-parser');
const KiloConfig = require('./kilo-backend/kilo-config');

class KiloBackend extends AgentBackend {
  constructor(options = {}) {
    super();
    this.runner = new KiloRunner(options);
    this.config = new KiloConfig(options);
    this.workdir = options.workdir || process.cwd();
  }

  /**
   * Отправить сообщение Kilo
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
    } = options;

    // Маппировать режим Claude на режим Kilo
    const kiloMode = this.mapMode(mode);

    // Маппировать модель
    const kiloModel = this.mapModel(model);

    // Построить конфиг Kilo
    const configPath = this.config.getConfigPath({
      model: kiloModel,
      mcpServers,
      permissions: this.buildPermissions(allowedTools),
      agent: kiloMode,
    });

    // Запустить Kilo
    const kiloRunner = this.runner.run({
      prompt,
      model: kiloModel,
      sessionId,
      format: 'json',
      auto: true,
      abortController,
    });

    // Обработчики
    let fullText = '';
    let fullError = '';
    let newSessionId = sessionId;

    // Обработка текста
    kiloRunner.onText((text) => {
      fullText += text;
    });

    // Обработка инструментов
    kiloRunner.onTool((name, input) => {
      // Преобразовать имя инструмента Kilo в Claude формат
      const claudeToolName = this.mapToolName(name);
    });

    // Обработка ошибок
    kiloRunner.onError((error) => {
      fullError += error;
    });

    // Обработка ID сессии
    kiloRunner.onSessionId((sid) => {
      newSessionId = sid;
    });

    // Вернуть объект совместимый с Claude интерфейсом
    return {
      onText(callback) {
        // Перехватить текст и передать callback
        const originalOnText = kiloRunner.onText;
        kiloRunner.onText((text) => {
          callback(text);
        });
        return this;
      },
      onTool(callback) {
        const originalOnTool = kiloRunner.onTool;
        kiloRunner.onTool((name, input) => {
          callback(name, input);
        });
        return this;
      },
      onError(callback) {
        const originalOnError = kiloRunner.onError;
        kiloRunner.onError((error) => {
          callback(error);
        });
        return this;
      },
      onDone(callback) {
        const originalOnDone = kiloRunner.onDone;
        kiloRunner.onDone((sid) => {
          callback(sid);
        });
        return this;
      },
      onSessionId(callback) {
        const originalOnSessionId = kiloRunner.onSessionId;
        kiloRunner.onSessionId((sid) => {
          callback(sid);
        });
        return this;
      },
      onThinking(callback) {
        // Kilo не поддерживает thinking блоки в текущей версии
        return this;
      },
      onResult(callback) {
        const originalOnDone = kiloRunner.onDone;
        kiloRunner.onDone((sid) => {
          callback({
            subtype: 'success',
            sessionId: sid,
          });
        });
        return this;
      },
      onRateLimit(callback) {
        // Kilo не поддерживает rate limit события
        return this;
      },
    };
  }

  /**
   * Маппировать режим Claude на режим Kilo
   * @param {string} mode - режим Claude (planning/task/auto)
   * @returns {string} режим Kilo (architect/code/orchestrator)
   */
  mapMode(mode) {
    const modeMap = {
      planning: 'architect',
      task: 'code',
      auto: 'orchestrator',
    };
    return modeMap[mode] || 'code';
  }

  /**
   * Маппировать модель Claude на модель Kilo
   * @param {string} model - модель Claude (haiku/sonnet/opus)
   * @returns {string} модель Kilo
   */
  mapModel(model) {
    const modelMap = {
      haiku: 'anthropic/claude-haiku-4.5',
      sonnet: 'anthropic/claude-sonnet-4-20250514',
      opus: 'anthropic/claude-opus-4.6',
    };
    return modelMap[model] || model;
  }

  /**
   * Маппировать имя инструмента Claude на имя инструмента Kilo
   * @param {string} name - имя инструмента
   * @returns {string} имя инструмента Kilo
   */
  mapToolName(name) {
    const toolMap = {
      'Bash': 'bash',
      'View': 'read',
      'SearchReplace': 'edit',
      'Write': 'write',
      'GlobTool': 'glob',
      'GrepTool': 'grep',
      'ListDir': 'read',
      'ReadNotebook': 'read',
      'NotebookEditCell': 'edit',
    };
    return toolMap[name] || name;
  }

  /**
   * Построить конфиг разрешений из allowedTools
   * @param {Array} allowedTools - разрешенные инструменты
   * @returns {Object} конфиг разрешений
   */
  buildPermissions(allowedTools) {
    if (!allowedTools || allowedTools.length === 0) {
      return { '*': 'allow' };
    }

    const permissions = {};
    for (const tool of allowedTools) {
      permissions[tool] = 'allow';
    }
    return permissions;
  }

  /**
   * Получить статус агента
   */
  async getStatus() {
    return {
      backend: 'kilo',
      version: '7.2.20',
    };
  }

  /**
   * Установить режим
   */
  async setMode(mode) {
    // Kilo не поддерживает динамическую смену режима
    // Режим устанавливается при запуске
  }

  /**
   * Установить модель
   */
  async setModel(model) {
    // Kilo не поддерживает динамическую смену модели
    // Модель устанавливается при запуске
  }

  /**
   * Управление сессией
   */
  async manageSession(sessionId, action) {
    // Kilo управляет сессиями через флаги CLI
    // Это реализуется в KiloRunner
  }
}

module.exports = KiloBackend;
