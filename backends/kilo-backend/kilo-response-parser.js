/**
 * KiloResponseParser - парсинг JSON вывода Kilo
 * Преобразует Kilo события в единый формат
 */

class KiloResponseParser {
  /**
   * Парсить JSON событие из Kilo
   * @param {string} line - JSON строка
   * @returns {Object|null} распарсенное событие или null
   */
  static parseJsonEvent(line) {
    if (!line || typeof line !== 'string') return null;

    try {
      const event = JSON.parse(line);
      return KiloResponseParser.normalizeEvent(event);
    } catch (e) {
      return null;
    }
  }

  /**
   * Нормализовать событие Kilo в единый формат
   * @param {Object} event - событие от Kilo
   * @returns {Object} нормализованное событие
   */
  static normalizeEvent(event) {
    if (!event || typeof event !== 'object') return null;

    const normalized = {
      type: event.type || 'unknown',
      timestamp: event.timestamp || Date.now(),
    };

    // Текстовое событие
    if (event.type === 'text' || event.type === 'message') {
      normalized.type = 'text';
      normalized.content = event.content || event.text || event.message || '';
    }

    // Событие инструмента
    if (event.type === 'tool' || event.type === 'tool_call') {
      normalized.type = 'tool';
      normalized.name = event.name || event.tool || '';
      normalized.input = event.input || event.arguments || '';
    }

    // Результат инструмента
    if (event.type === 'tool_result') {
      normalized.type = 'tool_result';
      normalized.toolName = event.toolName || event.tool || '';
      normalized.result = event.result || event.content || '';
    }

    // Ошибка
    if (event.type === 'error') {
      normalized.type = 'error';
      normalized.error = event.error || event.message || '';
    }

    // ID сессии
    if (event.sessionId) {
      normalized.sessionId = event.sessionId;
    }

    // Статус
    if (event.status) {
      normalized.status = event.status;
    }

    // Завершение
    if (event.type === 'done' || event.type === 'complete') {
      normalized.type = 'done';
      normalized.reason = event.reason || 'completed';
    }

    return normalized;
  }

  /**
   * Парсить поток вывода Kilo
   * @param {string} output - полный вывод
   * @returns {Array} массив событий
   */
  static parseStream(output) {
    if (!output || typeof output !== 'string') return [];

    const events = [];
    const lines = output.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;

      const event = KiloResponseParser.parseJsonEvent(line);
      if (event) {
        events.push(event);
      }
    }

    return events;
  }

  /**
   * Извлечь текст из событий
   * @param {Array} events - массив событий
   * @returns {string} объединенный текст
   */
  static extractText(events) {
    return events
      .filter((e) => e.type === 'text')
      .map((e) => e.content)
      .join('');
  }

  /**
   * Извлечь инструменты из событий
   * @param {Array} events - массив событий
   * @returns {Array} массив инструментов
   */
  static extractTools(events) {
    return events
      .filter((e) => e.type === 'tool')
      .map((e) => ({
        name: e.name,
        input: e.input,
      }));
  }

  /**
   * Извлечь ошибки из событий
   * @param {Array} events - массив событий
   * @returns {Array} массив ошибок
   */
  static extractErrors(events) {
    return events
      .filter((e) => e.type === 'error')
      .map((e) => e.error);
  }

  /**
   * Извлечь ID сессии из событий
   * @param {Array} events - массив событий
   * @returns {string|null} ID сессии или null
   */
  static extractSessionId(events) {
    for (const event of events) {
      if (event.sessionId) {
        return event.sessionId;
      }
    }
    return null;
  }
}

module.exports = KiloResponseParser;
