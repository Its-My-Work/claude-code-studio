/**
 * BackendFactory - фабрика для создания backend'ов
 * Позволяет выбирать между Claude и Kilo через конфиг
 */

const ClaudeCLI = require('../claude-cli');
const KiloBackend = require('./kilo-backend');

class BackendFactory {
  /**
   * Создать backend на основе конфигурации
   * @param {string} engine - тип engine ('claude' или 'kilo')
   * @param {Object} options - опции для backend
   * @returns {Object} экземпляр backend
   */
  static createBackend(engine, options = {}) {
    const engineType = (engine || process.env.AGENT_ENGINE || 'claude').toLowerCase();

    switch (engineType) {
      case 'claude':
        return new ClaudeCLI(options);

      case 'kilo':
        return new KiloBackend(options);

      default:
        throw new Error(`Unknown agent engine: ${engineType}. Use 'claude' or 'kilo'.`);
    }
  }

  /**
   * Получить текущий engine из конфигурации
   * @returns {string} текущий engine
   */
  static getCurrentEngine() {
    return process.env.AGENT_ENGINE || 'claude';
  }

  /**
   * Проверить, доступен ли engine
   * @param {string} engine - тип engine
   * @returns {boolean} доступен ли engine
   */
  static isEngineAvailable(engine) {
    const engineType = (engine || '').toLowerCase();

    if (engineType === 'claude') {
      // Claude всегда доступен (встроен)
      return true;
    }

    if (engineType === 'kilo') {
      // Проверить, установлен ли Kilo
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

  /**
   * Получить список доступных engine'ов
   * @returns {Array} список доступных engine'ов
   */
  static getAvailableEngines() {
    const available = [];

    if (BackendFactory.isEngineAvailable('claude')) {
      available.push('claude');
    }

    if (BackendFactory.isEngineAvailable('kilo')) {
      available.push('kilo');
    }

    return available;
  }
}

module.exports = BackendFactory;
