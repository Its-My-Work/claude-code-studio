/**
 * KiloRunner - запуск Kilo CLI как subprocess
 * Аналог ClaudeCLI для Kilo Code
 */

const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

class KiloRunner {
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
    this.kiloBin = options.kiloBin || 'kilo';
    this.timeout = options.timeout || 1800000; // 30 минут
    this.logger = options.logger || console;
  }

  /**
   * Запустить Kilo с сообщением
   * @param {Object} options
   * @returns {Object} объект с методами .onText(), .onTool(), .onError(), .onDone()
   */
  run(options) {
    const {
      prompt,
      model,
      sessionId,
      format = 'json',
      auto = true,
      abortController,
    } = options;

    // Построить аргументы для kilo run
    const args = ['run'];

    // Добавить сообщение
    if (prompt) {
      args.push(prompt);
    }

    // Формат вывода
    args.push('--format', format);

    // Автоматическое одобрение разрешений
    if (auto) {
      args.push('--auto');
    }

    // Модель
    if (model) {
      args.push('--model', model);
    }

    // Продолжить сессию
    if (sessionId) {
      args.push('--session', sessionId);
    }

    // Создать процесс
    const proc = spawn(this.kiloBin, args, {
      cwd: this.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Обработчики событий
    const handlers = {
      onText: null,
      onTool: null,
      onError: null,
      onDone: null,
      onSessionId: null,
      onResult: null,
    };

    let fullOutput = '';
    let fullError = '';
    let sessionIdFromOutput = null;
    let timeoutHandle = null;

    // Обработка stdout
    const decoder = new StringDecoder('utf8');
    let buffer = '';

    proc.stdout.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Оставить неполную строку в буфере

      for (const line of lines) {
        if (!line.trim()) continue;

        fullOutput += line + '\n';

        // Парсить JSON события
        try {
          const event = JSON.parse(line);
          handleJsonEvent(event);
        } catch (e) {
          // Не JSON - обработать как текст
          if (handlers.onText) {
            handlers.onText(line);
          }
        }
      }
    });

    // Обработка stderr
    proc.stderr.on('data', (chunk) => {
      const text = decoder.write(chunk);
      fullError += text;

      // Логировать ошибки
      if (handlers.onError) {
        handlers.onError(text);
      }
    });

    // Завершение процесса
    proc.on('close', (code) => {
      clearTimeout(timeoutHandle);

      if (handlers.onDone) {
        handlers.onDone(sessionIdFromOutput || sessionId);
      }
    });

    // Таймаут
    timeoutHandle = setTimeout(() => {
      proc.kill('SIGTERM');
      if (handlers.onError) {
        handlers.onError('Timeout: Kilo process exceeded time limit');
      }
    }, this.timeout);

    // Обработка JSON событий
    const logger = this.logger;
    const handleJsonEvent = (event) => {
      if (!event || typeof event !== 'object') return;

      // Извлечь sessionID из события
      if (event.sessionID) {
        sessionIdFromOutput = event.sessionID;
        logger.info('[kilocode] session_id', { sessionId: event.sessionID });
        if (handlers.onSessionId) {
          handlers.onSessionId(event.sessionID);
        }
      }

      // Событие завершения шага - сигнал о том, что Kilo завершил обработку
      if (event.type === 'step_finish' || event.type === 'step-finish') {
        logger.info('[kilocode] step_finish', { sessionId: sessionIdFromOutput || sessionId });
        // Сигнал завершения, но ждем закрытия процесса
        return;
      }

      // Текстовое событие - Kilo отправляет текст в event.part.text
      if (event.type === 'text' && event.part && event.part.text) {
        logger.info('[kilocode] text', { sessionId: sessionIdFromOutput || sessionId, text: event.part.text });
        if (handlers.onText) {
          handlers.onText(event.part.text);
        }
      }

      // Событие инструмента
      if ((event.type === 'tool' || event.type === 'tool_use') && event.part && event.part.name) {
        logger.info('[kilocode] tool', { sessionId: sessionIdFromOutput || sessionId, tool: event.part.name, input: event.part.input });
        if (handlers.onTool) {
          handlers.onTool(event.part.name, event.part.input || '');
        }
      }

      // Результат
      if (event.type === 'result' && event.result) {
        logger.info('[kilocode] result', { sessionId: sessionIdFromOutput || sessionId, result: event.result });
        if (handlers.onResult) {
          handlers.onResult(event.result);
        }
      }

      // Ошибка
      if (event.type === 'error' && event.error) {
        logger.error('[kilocode] error', { sessionId: sessionIdFromOutput || sessionId, error: event.error });
        if (handlers.onError) {
          handlers.onError(event.error);
        }
      }

      // Неизвестное событие
      logger.debug('[kilocode] event', { type: event.type, sessionId: sessionIdFromOutput || sessionId });
    };

    // Обработка сигнала отмены
    if (abortController?.signal) {
      abortController.signal.addEventListener('abort', () => {
        proc.kill('SIGTERM');
      });
    }

    // Вернуть объект с методами подписки
    return {
      onText(callback) {
        handlers.onText = callback;
        return this;
      },
      onTool(callback) {
        handlers.onTool = callback;
        return this;
      },
      onError(callback) {
        handlers.onError = callback;
        return this;
      },
      onDone(callback) {
        handlers.onDone = callback;
        return this;
      },
      onSessionId(callback) {
        handlers.onSessionId = callback;
        return this;
      },
      onResult(callback) {
        handlers.onResult = callback;
        return this;
      },
    };
  }
}

module.exports = KiloRunner;
