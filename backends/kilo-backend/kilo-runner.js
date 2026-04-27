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
      thinking = false,
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

    // Включить thinking блоки
    if (thinking) {
      args.push('--thinking');
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
      onStepStart: null,
      onStepFinish: null,
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

      const part = event.part;
      const sid = sessionIdFromOutput || sessionId;

      // step_start - начало нового шага
      if (event.type === 'step_start') {
        const stepData = {
          partId: part?.id,
          messageId: part?.messageID,
          type: part?.type,
        };
        logger.info('[kilocode] step_start', { sessionId: sid, ...stepData });
        if (handlers.onStepStart) {
          handlers.onStepStart(stepData);
        }
        return;
      }

      // step_finish - завершение шага (с токенами и reason)
      if (event.type === 'step_finish' || event.type === 'step-finish') {
        const tokens = part?.tokens || {};
        const stepData = {
          partId: part?.id,
          reason: part?.reason,
          tokens: {
            total: tokens.total,
            input: tokens.input,
            output: tokens.output,
            reasoning: tokens.reasoning,
          },
          cost: part?.cost,
        };
        logger.info('[kilocode] step_finish', { sessionId: sid, ...stepData });
        if (handlers.onStepFinish) {
          handlers.onStepFinish(stepData);
        }
        return;
      }

      // tool_use - использование инструмента
      if ((event.type === 'tool' || event.type === 'tool_use') && part) {
        const toolName = part.tool || part.name;
        const state = part.state || {};
        const input = state.input || part.input || {};
        const output = state.output || part.output || '';
        const status = state.status || 'unknown';
        const exit = state.exit;
        const time = state.time || {};

        // Truncate long outputs
        const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
        const truncatedOutput = outputStr.length > 500 ? outputStr.substring(0, 500) + '...' : outputStr;

        logger.info('[kilocode] tool_use', {
          sessionId: sid,
          tool: toolName,
          callId: part.callID,
          status,
          input: input.command || input.pattern || input,
          output: truncatedOutput,
          exit,
          duration: time.end && time.start ? time.end - time.start : null,
        });

        if (handlers.onTool) {
          handlers.onTool(toolName, input.command || input.pattern || JSON.stringify(input));
        }
        return;
      }

      // text - текстовый ответ от модели
      if (event.type === 'text' && part && part.text) {
        // Truncate long texts
        const text = part.text.length > 1000 ? part.text.substring(0, 1000) + '...' : part.text;
        logger.info('[kilocode] text', { sessionId: sid, text });
        if (handlers.onText) {
          handlers.onText(part.text);
        }
        return;
      }

      // thinking - размышления модели (если включены)
      if (event.type === 'thinking' && part && part.thinking) {
        const thinking = part.thinking.length > 500 ? part.thinking.substring(0, 500) + '...' : part.thinking;
        logger.debug('[kilocode] thinking', { sessionId: sid, thinking });
        return;
      }

      // result - итоговый результат
      if (event.type === 'result' && event.result) {
        logger.info('[kilocode] result', { sessionId: sid, result: event.result });
        if (handlers.onResult) {
          handlers.onResult(event.result);
        }
        return;
      }

      // error
      if (event.type === 'error' && event.error) {
        logger.error('[kilocode] error', { sessionId: sid, error: event.error });
        if (handlers.onError) {
          handlers.onError(event.error);
        }
        return;
      }

      // Неизвестное событие
      logger.debug('[kilocode] event', { type: event.type, sessionId: sid });
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
      onStepStart(callback) {
        handlers.onStepStart = callback;
        return this;
      },
      onStepFinish(callback) {
        handlers.onStepFinish = callback;
        return this;
      },
    };
  }
}

module.exports = KiloRunner;
