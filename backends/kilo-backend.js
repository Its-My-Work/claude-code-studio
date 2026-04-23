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
    let resultData = null;
    
    // Хранилище для callbacks
    const callbacks = {
      onText: null,
      onTool: null,
      onError: null,
      onDone: null,
      onSessionId: null,
      onResult: null,
    };

    // Регистрировать обработчики один раз
    kiloRunner.onText((text) => {
      fullText += text;
      if (callbacks.onText) {
        callbacks.onText(text);
      }
    });

    kiloRunner.onTool((name, input) => {
      if (callbacks.onTool) {
        callbacks.onTool(name, input);
      }
    });

    kiloRunner.onError((error) => {
      fullError += error;
      if (callbacks.onError) {
        callbacks.onError(error);
      }
    });

    kiloRunner.onSessionId((sid) => {
      newSessionId = sid;
      if (callbacks.onSessionId) {
        callbacks.onSessionId(sid);
      }
    });

    kiloRunner.onDone((sid) => {
      if (sid) newSessionId = sid;
      // Гарантировать, что onResult вызывается перед onDone
      if (callbacks.onResult && !resultData) {
        resultData = {
          subtype: 'success',
          sessionId: sid,
        };
        callbacks.onResult(resultData);
      }
      if (callbacks.onDone) {
        callbacks.onDone(sid);
      }
    });

    // Вернуть объект совместимый с Claude интерфейсом
    return {
      onText(callback) {
        callbacks.onText = callback;
        return this;
      },
      onTool(callback) {
        callbacks.onTool = callback;
        return this;
      },
      onError(callback) {
        callbacks.onError = callback;
        return this;
      },
      onDone(callback) {
        callbacks.onDone = callback;
        return this;
      },
      onSessionId(callback) {
        callbacks.onSessionId = callback;
        return this;
      },
      onThinking(callback) {
        // Kilo не поддерживает thinking блоки в текущей версии
        return this;
      },
      onResult(callback) {
        callbacks.onResult = callback;
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
