/**
 * KiloConfig - управление конфигурацией Kilo
 * Создает и обновляет kilo.json для текущей сессии
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

class KiloConfig {
  constructor(options = {}) {
    this.configDir = options.configDir || path.join(os.homedir(), '.config', 'kilo');
    this.projectDir = options.projectDir || process.cwd();
    this.tempDir = options.tempDir || path.join(os.tmpdir(), 'kilo-config');
  }

  /**
   * Получить или создать конфиг для Kilo
   * @param {Object} options - опции конфигурации
   * @returns {string} путь к конфиг файлу
   */
  getConfigPath(options = {}) {
    const {
      model,
      mcpServers,
      permissions,
      agent,
    } = options;

    // Создать временную директорию если нужно
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    // Построить конфиг
    const config = this.buildConfig({
      model,
      mcpServers,
      permissions,
      agent,
    });

    // Сохранить в временный файл
    const configPath = path.join(this.tempDir, `kilo-${Date.now()}.json`);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    return configPath;
  }

  /**
   * Построить конфиг объект для Kilo
   * @param {Object} options
   * @returns {Object} конфиг
   */
  buildConfig(options = {}) {
    const {
      model,
      mcpServers,
      permissions,
      agent,
    } = options;

    const config = {
      $schema: 'https://app.kilo.ai/config.json',
    };

    // Модель
    if (model) {
      config.model = this.mapModel(model);
    }

    // MCP серверы
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      config.mcp = this.buildMcpConfig(mcpServers);
    }

    // Разрешения
    if (permissions) {
      config.permission = this.buildPermissions(permissions);
    } else {
      // По умолчанию разрешить все
      config.permission = {
        '*': 'allow',
      };
    }

    // Агент
    if (agent) {
      config.default_agent = agent;
    }

    return config;
  }

  /**
   * Маппировать Claude модель на Kilo модель
   * @param {string} model - Claude модель (haiku/sonnet/opus)
   * @returns {string} Kilo модель
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
   * Построить MCP конфиг
   * @param {Object} mcpServers - MCP серверы
   * @returns {Object} MCP конфиг
   */
  buildMcpConfig(mcpServers) {
    const mcp = {};

    for (const [name, config] of Object.entries(mcpServers)) {
      // Определить тип сервера для Kilo
      let serverType = 'local';
      if (config.type === 'http' || config.type === 'sse' || config.url) {
        serverType = 'remote';
      }

      mcp[name] = {
        type: serverType,
        enabled: config.enabled !== false,
      };

      if (serverType === 'local' && config.command) {
        mcp[name].command = config.command;
        if (config.args && config.args.length > 0) {
          mcp[name].args = config.args;
        }
        if (config.env) {
          mcp[name].env = config.env;
        }
      } else if (serverType === 'remote' && config.url) {
        mcp[name].url = config.url;
        if (config.headers) {
          mcp[name].headers = config.headers;
        }
        if (config.env) {
          mcp[name].env = config.env;
        }
      }
    }

    return mcp;
  }

  /**
   * Построить конфиг разрешений
   * @param {Object} permissions - разрешения
   * @returns {Object} конфиг разрешений
   */
  buildPermissions(permissions) {
    const permission = {};

    // Инструменты
    if (permissions.tools) {
      for (const [tool, action] of Object.entries(permissions.tools)) {
        permission[tool] = action;
      }
    }

    // Внешние директории
    if (permissions.externalDirectories) {
      permission.external_directory = {};
      for (const [pattern, action] of Object.entries(permissions.externalDirectories)) {
        permission.external_directory[pattern] = action;
      }
    }

    return permission;
  }

  /**
   * Очистить временные конфиги
   */
  cleanup() {
    try {
      if (fs.existsSync(this.tempDir)) {
        const files = fs.readdirSync(this.tempDir);
        for (const file of files) {
          const filePath = path.join(this.tempDir, file);
          // Удалить файлы старше 1 часа
          const stat = fs.statSync(filePath);
          if (Date.now() - stat.mtimeMs > 3600000) {
            fs.unlinkSync(filePath);
          }
        }
      }
    } catch (e) {
      // Игнорировать ошибки при очистке
    }
  }
}

module.exports = KiloConfig;
