/**
 * BackendFactory - фабрика для создания backend'ов
 * Всегда создает Kilo backend
 */

const KiloCLI = require('../kilo-cli');
const KiloBackend = require('./kilo-backend');

class BackendFactory {
  /**
   * Создать backend на основе конфигурации
   * @param {string} engine - тип engine
   * @param {Object} options - опции для backend
   * @returns {Object} экземпляр backend
   */
  static createBackend(engine, options = {}) {
    // Always use Kilo backend
    return new KiloBackend(options);
  }

  /**
   * Получить текущий engine
   * @returns {string} всегда 'kilo'
   */
  static getCurrentEngine() {
    return 'kilo';
  }

  /**
   * Проверить, доступен ли engine
   * @param {string} engine - тип engine
   * @returns {boolean} доступен ли engine
   */
  static isEngineAvailable(engine) {
    const engineType = (engine || '').toLowerCase();

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

    if (BackendFactory.isEngineAvailable('kilo')) {
      available.push('kilo');
    }

    return available;
  }
}

module.exports = BackendFactory;
