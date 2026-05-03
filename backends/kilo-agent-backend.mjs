/**
 * Модуль для работы с бэкендом Kilo AI агента.
 * Обрабатывает отправку запросов, стриминг ответов и управление сессиями.
 */

// Импорты необходимых модулей
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import AgentBackend from './agent-backend.js';

/**
 * Класс KiloAgentBackend - реализация бэкенда для взаимодействия с Kilo API.
 * Наследуется от базового AgentBackend и предоставляет методы для отправки запросов,
 * обработки стриминга событий и управления сессиями.
 */
class KiloAgentBackend extends AgentBackend {
  /**
   * Конструктор класса. Инициализирует настройки подключения к Kilo серверу,
   * модель по умолчанию и директорию для логов.
   * @param {Object} options - Параметры конфигурации (url, timeout, model и т.д.)
   */
  constructor(options = {}) {
    super();
    // URL сервера Kilo, берется из опций или переменных окружения
    this.url = options.url || process.env.KILO_SERVER_URL || process.env.KILO_URL || 'http://127.0.0.1:4096';
    // Таймаут для запросов в миллисекундах
    this.timeout = options.timeout || 30000;
    // Модель по умолчанию для генерации ответов
    this.defaultModel = options.model || 'kilo/kilo-auto/free';
    this.currentModel = this.defaultModel;
    // Директория для хранения логов сессий
    this.logsDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
  }

  /**
   * Основной метод отправки запроса к Kilo агенту.
   * Подготавливает промпт, создает лог-файл и возвращает обертку с коллбеками для обработки ответа.
   * @param {Object} options - Параметры запроса (sessionId, prompt, contentBlocks и т.д.)
   * @returns {Object} Обертка с методами onText, onReasoning и т.д. для подписки на события
   */
  send(options) {
    // Генерируем уникальный ID для запроса
    const requestId = uuidv4();
    const sessionId = options.sessionId;
    // Лог-файл для сессии (один файл на сессию)
    const logFile = path.join(this.logsDir, `${sessionId || 'new'}.log`);

    console.log('[KiloBackend] Raw prompt before processing:', options.prompt);
    console.log('[KiloBackend] Content blocks:', options.contentBlocks);

    // Собираем полный промпт из блоков контента или простого текста
    let fullPrompt = '';
    if (options.contentBlocks && options.contentBlocks.length > 0) {
      for (const block of options.contentBlocks) {
        if (block.type === 'text' && block.text) {
          fullPrompt += block.text + '\n';
        }
      }
    } else if (options.prompt) {
      fullPrompt = options.prompt;
    }

    console.log('[KiloBackend] Full prompt after concat:', fullPrompt);

    // Логируем начало запроса
    this.logEvent(logFile, 'request_start', {
      model: options.model || this.currentModel,
      promptLength: fullPrompt.length,
      promptPreview: fullPrompt.substring(0, 500),
      sessionId,
      maxTurns: options.maxTurns,
    });

    // Создаем обертку для обработки коллбеков
    return this.createCallbackWrapper(options, requestId, sessionId, fullPrompt, logFile);
  }

  /**
   * Проверяет статус подключения к Kilo серверу.
   * @returns {Object} Объект с полями status ('connected' или 'error') и url
   */
  async getStatus() {
    try {
      const resp = await fetch(`${this.url}/health`);
      return { status: resp.ok ? 'connected' : 'error', url: this.url };
    } catch (error) {
      return { status: 'error', message: error.message, url: this.url };
    }
  }

  /**
   * Устанавливает текущую модель для генерации ответов.
   * @param {string} mode - Название модели
   * @returns {Object} Результат операции
   */
  async setMode(mode) {
    this.currentModel = mode;
    return { success: true, model: this.currentModel };
  }

  /**
   * Синоним для setMode.
   * @param {string} model - Название модели
   * @returns {Object} Результат операции
   */
  async setModel(model) {
    return this.setMode(model);
  }

  /**
   * Управление сессиями: создание, удаление, список.
   * @param {string} sessionId - ID сессии (для delete)
   * @param {string} action - Действие: 'create', 'delete', 'list'
   * @returns {Object} Результат операции
   */
  async manageSession(sessionId, action) {
    try {
      switch (action) {
        case 'create': {
          // Создание новой сессии
          const resp = await fetch(`${this.url}/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'New Session' }),
          });
          const session = await resp.json();
          return { success: true, sessionId: session.data?.id };
        }
        case 'delete': {
          // Удаление сессии
          await fetch(`${this.url}/session/${sessionId}`, { method: 'DELETE' });
          return { success: true };
        }
        case 'list': {
          // Получение списка сессий
          const resp = await fetch(`${this.url}/session`);
          const sessions = await resp.json();
          return { success: true, sessions };
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Создает обертку для подписки на события обработки запроса.
   * Позволяет клиенту подписаться на различные коллбеки (onText, onReasoning и т.д.).
   * @param {Object} options - Параметры запроса
   * @param {string} requestId - ID запроса
   * @param {string} sessionId - ID сессии
   * @param {string} fullPrompt - Полный текст промпта
   * @param {string} logFile - Путь к лог-файлу
   * @returns {Object} Обертка с методами подписки
   */
  createCallbackWrapper(options, requestId, sessionId, fullPrompt, logFile) {
    // Объект для хранения коллбеков
    const callbacks = {};

    // Обертка с fluent API для подписки
    const wrapper = {
      onText: (fn) => { callbacks.onText = fn; return wrapper; },
      onReasoning: (fn) => { callbacks.onReasoning = fn; return wrapper; },
      onTool: (fn) => { callbacks.onTool = fn; return wrapper; },
      onDone: (fn) => { callbacks.onDone = fn; return wrapper; },
      onError: (fn) => { callbacks.onError = fn; return wrapper; },
      onSessionId: (fn) => { callbacks.onSessionId = fn; return wrapper; },
      onResult: (fn) => { callbacks.onResult = fn; return wrapper; },
      onRateLimit: (fn) => { callbacks.onRateLimit = fn; return wrapper; },
      onStepStart: (fn) => { callbacks.onStepStart = fn; return wrapper; },
      onStepFinish: (fn) => { callbacks.onStepFinish = fn; return wrapper; },
    };

    // Запускаем обработку запроса с коллбеками
    this.processSend(options, requestId, sessionId, fullPrompt, logFile, callbacks);

    return wrapper;
  }

  /**
   * Основная логика обработки запроса: создание сессии, подписка на события,
   * отправка промпта и обработка стриминга ответов.
   * @param {Object} options - Параметры запроса
   * @param {string} requestId - ID запроса
   * @param {string} sessionId - ID сессии
   * @param {string} fullPrompt - Полный текст промпта
   * @param {string} logFile - Путь к лог-файлу
   * @param {Object} callbacks - Объект с коллбеками
   */
  async processSend(options, requestId, sessionId, fullPrompt, logFile, callbacks) {
    console.log('[KiloBackend] processSend started', { fullPrompt: fullPrompt.substring(0, 100) });

    // Проверка на отмену запроса
    if (options.abortController?.signal?.aborted) {
      this.logEvent(logFile, 'request_aborted', { reason: 'aborted_before_start' });
      if (callbacks.onError) callbacks.onError('Request aborted');
      if (callbacks.onDone) callbacks.onDone(sessionId);
      return;
    }

    let latestSessionId = sessionId;
    const decoder = new TextDecoder();
    let hasStreaming = false;
    let doneCalled = false;
    // Буферы для накопления текста ответа и размышлений
    let reasoningText = '';
    let answerText = '';
    // Карта для хранения ролей сообщений (messageID -> role)
    let messageRoles = new Map();
    // Хранилище частей сообщения по partID: { type, text, completed }
    let messageParts = new Map();

    try {
      // Создание сессии, если ID не передан
      if (!latestSessionId) {
        const title = fullPrompt.substring(0, 100);
        const resp = await fetch(`${this.url}/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, directory: options.cwd || process.cwd() }),
        });
        const session = await resp.json();
        // ID может быть в session.id или session.data.id в зависимости от версии API
        latestSessionId = session.id || session.data?.id;
        console.log('[KiloBackend] Session created:', latestSessionId);
        this.logEvent(logFile, 'session_created', { sessionId: latestSessionId, title });
        if (callbacks.onSessionId) callbacks.onSessionId(latestSessionId);
      }

      // Подписка на поток событий от сервера
      console.log('[KiloBackend] Subscribing to events...');

      const eventResp = await fetch(`${this.url}/event`, {
        headers: { 'Accept': 'text/event-stream' },
        signal: options.abortController?.signal,
      });

      const reader = eventResp.body.getReader();
      let buffer = '';

      /**
       * Инициализирует часть сообщения по partID
       * @param {string} partID - Идентификатор части
       * @param {string} type - Тип части ('text' или 'reasoning')
       */
      const initializePart = (partID, type) => {
        if (!messageParts.has(partID)) {
          messageParts.set(partID, {
            id: partID,
            type: type || 'unknown',
            text: '',
            completed: false
          });
        }
      };

      /**
       * Асинхронная функция для обработки потока событий.
       * Читает данные из стрима, парсит JSON события и обрабатывает их.
       */
      const processEvents = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const event = JSON.parse(line.slice(6));
                console.log('[KiloBackend] Event:', event.type, JSON.stringify(event.properties || {}).substring(0, 150));
                this.logEvent(logFile, 'stream_event', { event: JSON.stringify(event).substring(0, 4000) });

                // Пропускаем события не для нашей сессии
                const eventSessionId = event.properties?.sessionID;
                if (latestSessionId && eventSessionId && eventSessionId !== latestSessionId) {
                  continue;
                }

                // Обработка события обновления сообщения (сохранение роли)
                if (event.type === 'message.updated') {
                  const info = event.properties?.info;
                  const messageID = info?.id || event.properties?.messageID;
                  if (info?.role && messageID) {
                    messageRoles.set(messageID, info.role);
                    console.log('[KiloBackend] Set role for messageID:', messageID, 'role:', info.role);
                  }
} else if (event.type === 'message.part.delta') {
                  // DELTA - инкрементальное добавление текста
                  hasStreaming = true;
                  const delta = event.properties?.delta;
                  const field = event.properties?.field;
                  const partID = event.properties?.partID;
                  const messageID = event.properties?.messageID;
                  const role = messageRoles.get(messageID);

                  // Игнорируем события без известной роли или от пользователя
                  if (!role || role === 'user') {
                    console.log('[KiloBackend] Skipping delta - unknown or user role');
                    continue;
                  }

                  // Получаем часть (должна быть уже создана в message.part.updated)
                  let part = messageParts.get(partID);
                  if (!part) {
                    // Резервный вариант: создаём без типа (будет обновлён позже)
                    messageParts.set(partID, { id: partID, type: 'unknown', text: '', completed: false });
                    part = messageParts.get(partID);
                  }

                  // Добавляем delta к тексту части
                  part.text += delta;

                  // Отправляем в UI в зависимости от типа части
                  const isReasoning = part.type === 'reasoning';
                  const eventType = isReasoning ? 'reasoning_chunk' : 'answer_chunk';

                  if (delta && callbacks.onText) {
                    const chunkData = { chunk: delta, partID, partType: part.type };
                    if (!isReasoning) {
                      answerText += delta;
                      callbacks.onText(delta);
                    } else {
                      reasoningText += delta;
                      if (options.thinking && callbacks.onReasoning) {
                        callbacks.onReasoning(delta);
                      }
                    }
                    this.logEvent(logFile, eventType, chunkData);
                    console.log(`[KiloBackend] Calling on${isReasoning ? 'Reasoning' : 'Text'} with delta:`, delta?.substring(0, 50));
                  }
                } else if (event.type === 'message.part.updated') {
                  // UPDATED - обновление метаданных части
                  const part = event.properties?.part;
                  const partID = part?.id;
                  const partType = part?.type;

                  if (partID) {
                    // Сохраняем тип части в хранилище
                    let partData = messageParts.get(partID);
                    if (!partData) {
                      initializePart(partID, partType);
                      partData = messageParts.get(partID);
                    } else {
                      partData.type = partType;
                    }

                    // Если есть time.end - часть завершена
                    if (part?.time?.end) {
                      partData.completed = true;

                      // ТОЛЬКО логируем, НЕ отправляем в UI (delta уже всё отправил)
                      console.log(`[COMPLETED] ${partType} part finished:`, {
                        partID: partID,
                        length: partData.text.length,
                        preview: partData.text.substring(0, 100) + '...'
                      });
                    }
                  }
                } else if (event.type === 'session.status') {
                  // Статус сессии: завершаем обработку при idle
                  if (event.properties?.status?.type === 'idle' && !doneCalled) {
                    doneCalled = true;
                    if (callbacks.onDone) callbacks.onDone(latestSessionId);
                  }
                } else if (event.type === 'session.idle') {
                  // Сессия стала idle (завершена)
                  if (!doneCalled && callbacks.onDone) {
                    doneCalled = true;
                    callbacks.onDone(latestSessionId);
                  }
                } else if (event.type === 'session.error') {
                  // Ошибка сессии
                  const errorMsg = event.properties?.error?.data?.message || 'Unknown error';
                  console.log('[KiloBackend] Session error:', errorMsg);
                  this.logEvent(logFile, 'session_error', { error: errorMsg });
                } else if (event.type === 'session.turn.close') {
                  // Закрытие хода (turn) в сессии
                  if (!doneCalled) {
                    doneCalled = true;
                    // Логируем итоговую статистику частей
                    console.log('Turn completed. Parts summary:');
                    for (const [partID, part] of messageParts) {
                      console.log(`  ${part.type}: ${part.text.length} chars, completed: ${part.completed}`);
                    }
                    messageParts.clear();
                    if (callbacks.onDone) callbacks.onDone(latestSessionId);
                  }
                }
              } catch (e) {
                console.log('[KiloBackend] parse error:', e.message);
              }
            }
          }
        }
      };

      // Запускаем обработку событий параллельно
      const eventPromise = processEvents();
      await new Promise(r => setTimeout(r, 100)); // Небольшая задержка для инициализации

      // Отправляем промпт асинхронно в сессию
      const messageID = 'msg_' + Date.now();
      console.log('[KiloBackend] Sending prompt to session:', latestSessionId);

      // Подготавливаем объект модели, если указана
      let modelObj = undefined;
      if (options.model) {
        const parts = options.model.split('/');
        const providerID = parts.shift();
        const modelID = parts.join('/');
        modelObj = { providerID, modelID };
      }

      // Формируем payload для промпта
      const promptPayload = {
        messageID,
        agent: options.mode || 'plan',
        parts: [{ type: 'text', text: fullPrompt }],
        model: modelObj,
        thinking: options.thinking || false,
      };
      console.log('[KiloBackend] Prompt payload:', JSON.stringify(promptPayload, null, 2));

      // Отправляем запрос на генерацию ответа
      const promptResp = await fetch(`${this.url}/session/${latestSessionId}/prompt_async`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(promptPayload),
        signal: options.abortController?.signal,
      });

      console.log('[KiloBackend] Prompt response:', promptResp.status);
      if (promptResp.status !== 204) {
        const responseBody = await promptResp.text();
        console.log('[KiloBackend] Response body:', responseBody);
      }
      this.logEvent(logFile, 'prompt_response', { status: promptResp.status });

      // Ожидаем завершения обработки событий с таймаутом 60 секунд
      const timeoutPromise = new Promise(r => setTimeout(r, 60000));
      await Promise.race([eventPromise, timeoutPromise]).catch(() => {});

      // Убеждаемся, что onDone вызван
      if (!doneCalled) {
        doneCalled = true;
        if (callbacks.onDone) callbacks.onDone(latestSessionId);
      }

    } catch (error) {
      console.log('[KiloBackend] Error:', error.message);
      this.logEvent(logFile, 'request_error', { error: error.message });
      if (callbacks.onError) callbacks.onError(error.message);
    }
  }

  /**
   * Логирует событие в файл сессии.
   * @param {string} logFile - Путь к лог-файлу
   * @param {string} eventType - Тип события
   * @param {Object} data - Данные события
   */
  logEvent(logFile, eventType, data) {
    const entry = {
      timestamp: new Date().toISOString(),
      eventType,
      data,
    };
    try {
      fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
    } catch (error) {
      console.error('Logging error:', error);
    }
  }
}

export default KiloAgentBackend;