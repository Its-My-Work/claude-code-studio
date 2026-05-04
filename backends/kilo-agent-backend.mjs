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
    // Режим стриминга: 'native' или 'buffered'
    this.streamMode = options.streamMode || 'native';
    // Директория для хранения логов сессий
    this.logsDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }

    // Управление активными подписками на сессии (для предотвращения накопления подписок)
    this.activeSubscriptions = new Map(); // sessionId -> {controller, reader}
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
    this.logFile = path.join(this.logsDir, `${sessionId || 'new'}.log`);

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
    this.logEvent(this.logFile, 'request_start', {
      model: options.model || this.currentModel,
      promptLength: fullPrompt.length,
      promptPreview: fullPrompt.substring(0, 500),
      sessionId,
      maxTurns: options.maxTurns,
    });

    // Создаем обертку для обработки коллбеков
    return this.createCallbackWrapper(options, requestId, sessionId, fullPrompt, this.logFile);
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
      onToolProposal: (fn) => { callbacks.onToolProposal = fn; return wrapper; },
      onToolStart: (fn) => { callbacks.onToolStart = fn; return wrapper; },
      onToolComplete: (fn) => { callbacks.onToolComplete = fn; return wrapper; },
      onToolError: (fn) => { callbacks.onToolError = fn; return wrapper; },
      onDone: (fn) => { callbacks.onDone = fn; return wrapper; },
      onError: (fn) => { callbacks.onError = fn; return wrapper; },
      onSessionId: (fn) => { callbacks.onSessionId = fn; return wrapper; },
      onResult: (fn) => { callbacks.onResult = fn; return wrapper; },
      onRateLimit: (fn) => { callbacks.onRateLimit = fn; return wrapper; },
      onStepStart: (fn) => { callbacks.onStepStart = fn; return wrapper; },
      onStepFinish: (fn) => { callbacks.onStepFinish = fn; return wrapper; },
    };

    // Запускаем обработку запроса с коллбеками
    this.processSend(options, requestId, sessionId, fullPrompt, callbacks);

    return wrapper;
  }

/**
    * Основная логика обработки запроса: создание сессии, подписка на события,
    * отправка промпта и обработка стриминга ответов.
    * @param {Object} options - Параметры запроса
    * @param {string} requestId - ID запроса
    * @param {string} sessionId - ID сессии
    * @param {string} fullPrompt - Полный текст промпта
    * @param {Object} callbacks - Объект с коллбеками
    */
  async processSend(options, requestId, sessionId, fullPrompt, callbacks) {
    console.log('[KiloBackend] processSend started', { fullPrompt: fullPrompt.substring(0, 100) });

    // Проверка на отмену запроса
    if (options.abortController?.signal?.aborted) {
      this.logEvent(this.logFile, 'request_aborted', { reason: 'aborted_before_start' });
      if (callbacks.onError) callbacks.onError('Request aborted');
      if (callbacks.onDone) callbacks.onDone(sessionId);
      return;
    }

    // Закрываем предыдущую подписку на эту же сессию (если есть)
    if (sessionId && this.activeSubscriptions.has(sessionId)) {
      console.log('[KiloBackend] Closing previous subscription for session:', sessionId);
      const prevSub = this.activeSubscriptions.get(sessionId);
      if (prevSub?.controller) {
        prevSub.controller.abort();
      }
      this.activeSubscriptions.delete(sessionId);
    }

    // Создаем новый AbortController для этой подписки
    const controller = new AbortController();
    const signal = controller.signal;

    // Сохраняем активную подписку
    let latestSessionId = sessionId;
    const decoder = new TextDecoder();
    let hasStreaming = false;
    let doneCalled = false;
    // Буферы для накопления текста ответа и размышлений
    let reasoningText = '';
    let answerText = '';
    // Карта для хранения ролей сообщений (messageID -> role)
    let messageRoles = new Map();
    // Хранилище частей сообщения по partID: { type, text, completed, time, tool }
    let messageParts = new Map();
    // Хранилище tool parts по partID для toolpartupdated событий
    let toolPartsMap = new Map();
    // Буфер для всех parts в buffered mode
    let allParts = [];
    // Буфер для tool events в buffered mode
    let bufferedToolEvents = [];
    // Массив для буферизации toolpartupdated при race condition
    let pendingToolEvents = [];
    const isBuffered = this.streamMode === 'buffered';

    // Класс для дедупликации событий
    class EventDeduplicator {
      constructor(ttl = 100) { // 100ms окно дедупликации
        this.seen = new Map();
        this.ttl = ttl;
      }

      /**
       * Проверяет, является ли событие дубликатом
       * @param {string} eventType - Тип события
       * @param {string} eventId - Уникальный ID события
       * @param {number} timestamp - Timestamp события
       * @returns {boolean} true если дубликат
       */
      isDuplicate(eventType, eventId, timestamp) {
        const key = `${eventType}:${eventId}`;
        const lastSeen = this.seen.get(key);

        // Если событие было меньше ttl мс назад — дубликат
        if (lastSeen && (timestamp - lastSeen) < this.ttl) {
          return true;
        }

        // Сохраняем новое событие
        this.seen.set(key, timestamp);

        // Чистим старые записи если их слишком много
        if (this.seen.size > 1000) {
          const cutoff = timestamp - this.ttl;
          for (const [k, v] of this.seen.entries()) {
            if (v < cutoff) this.seen.delete(k);
          }
        }

        return false;
      }
    }

    // Создаем экземпляр дедупликатора
    const eventDedup = new EventDeduplicator();

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
        this.logFile = path.join(this.logsDir, `${latestSessionId}.log`);
        this.logEvent(this.logFile, 'session_created', { sessionId: latestSessionId, title });
        if (callbacks.onSessionId) callbacks.onSessionId(latestSessionId);
      }

      // Подписка на поток событий от сервера
      console.log('[KiloBackend] Subscribing to events...');

      const eventResp = await fetch(`${this.url}/event`, {
        headers: { 'Accept': 'text/event-stream' },
        signal: signal, // Используем наш контроллер вместо options.abortController
      });

      const reader = eventResp.body.getReader();
      let buffer = '';

      // Сохраняем reader для возможности отмены
      if (latestSessionId) {
        this.activeSubscriptions.set(latestSessionId, { controller, reader });
      }

      /**
       * Инициализирует часть сообщения по partID
       * @param {string} partID - Идентификатор части
       * @param {string} type - Тип части ('text', 'reasoning', 'tool')
       * @param {Object} time - Время начала/конца
       * @param {string} tool - Название инструмента для tool parts
       */
      const initializePart = (partID, type, time, tool) => {
        if (!messageParts.has(partID)) {
          const partData = {
            id: partID,
            type: type || 'unknown',
            text: '',
            completed: false,
            time: time,
            tool: tool,
            proposed: false
          };
          messageParts.set(partID, partData);
          if (isBuffered) {
            allParts.push(partData);
          }
        }
      };

      /**
       * Повторяет обработку toolpartupdated события при race condition
       * @param {string} partID - Идентификатор части
       */
      const retryToolEvent = (partID) => {
        const index = pendingToolEvents.findIndex(e => e.partID === partID);
        if (index === -1) return;

        const { partID: pID, toolName, event, retry } = pendingToolEvents[index];
        if (retry >= 5) {
          console.warn('[KiloBackend] Max retries exceeded for toolpartupdated:', pID);
          pendingToolEvents.splice(index, 1);
          return;
        }

        const toolPart = toolPartsMap.get(pID);
        if (toolPart) {
          // Повторяем обработку события
          pendingToolEvents.splice(index, 1);
          // Вставляем событие обратно для обработки
          const syntheticEvent = { type: 'toolpartupdated', data: { partID: pID, tool: toolName }, properties: event.properties };
          // Обработка как будто событие пришло сейчас
          const status = toolPart.state?.status || toolPart.status || 'unknown';
          const input = toolPart.input?.command || JSON.stringify(toolPart.input, null, 2) || '';

          console.log('[TOOL EVENT RETRY]', { pID, toolName, status, inputLength: input.length });

          if (isBuffered) {
            bufferedToolEvents.push({
              partID: pID, toolName, status, input,
              output: toolPart.output || '',
              error: toolPart.error || toolPart.state?.error || '',
              timestamp: Date.now()
            });
          } else {
            if (status === 'pending' && callbacks.onToolProposal) {
              callbacks.onToolProposal({ tool: toolName, input });
            } else if (status === 'running' && callbacks.onToolStart) {
              callbacks.onToolStart({ tool: toolName, input });
            } else if (status === 'completed' && callbacks.onToolComplete) {
              callbacks.onToolComplete({ tool: toolName, input, output: toolPart.output || '' });
            } else if (status === 'failed' && callbacks.onToolError) {
              const error = toolPart.error || toolPart.state?.error || 'Unknown error';
              callbacks.onToolError({ tool: toolName, input, error });
            }
          }
        } else {
          // Еще не готов, повторить через 100ms
          pendingToolEvents[index].retry++;
          setTimeout(() => retryToolEvent(pID), 100);
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
                this.logEvent(this.logFile, 'stream_event', { event: JSON.stringify(event).substring(0, 4000) });

                // Пропускаем события не для нашей сессии
                const eventSessionId = event.properties?.sessionID;
                if (latestSessionId && eventSessionId && eventSessionId !== latestSessionId) {
                  continue;
                }

                // Обработка события обновления сообщения (сохранение роли)
                if (event.type === 'message.updated') {
                  const info = event.properties?.info;
                  const messageID = info?.id || event.properties?.messageID;

                  // Проверяем на дублирование события
                  const timestamp = Date.now();
                  const eventId = `${messageID}-${JSON.stringify(info || event.properties || {})}`;
                  if (eventDedup.isDuplicate('message.updated', eventId, timestamp)) {
                    console.warn('[KiloBackend] Skipping duplicate message.updated event:', messageID);
                    continue;
                  }

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

                  // Проверяем на дублирование события
                  const timestamp = Date.now();
                  const eventId = `${messageID}-${partID}-${delta}`;
                  if (eventDedup.isDuplicate('message.part.delta', eventId, timestamp)) {
                    console.warn('[KiloBackend] Skipping duplicate delta event:', delta?.substring(0, 50));
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

                  // Обработка в зависимости от типа части
                  if (part.type === 'tool') {
                    // Для tools
                    this.logEvent(this.logFile, 'tool_delta', { partID, tool: part.tool, delta: delta.substring(0, 100) });
                    if (!isBuffered && callbacks.onTool) {
                      callbacks.onTool({ type: 'tool', tool: part.tool || 'unknown', input: part.text });
                    }
                    if (!isBuffered && callbacks.onToolStart && part.text === delta) { // первый delta
                      callbacks.onToolStart({ tool: part.tool || 'unknown', input: delta });
                    }
                  } else {
                    // Для reasoning и text
                    const isReasoning = part.type === 'reasoning';
                    if (!isBuffered) {
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
                        this.logEvent(this.logFile, eventType, chunkData);
                        console.log(`[KiloBackend] Calling on${isReasoning ? 'Reasoning' : 'Text'} with delta:`, delta?.substring(0, 50));
                      }
                    }
                  }
                } else if (event.type === 'message.part.updated') {
                  // UPDATED - обновление метаданных части
                  const part = event.properties?.part;
                  const partID = part?.id;
                  const partType = part?.type;

                  // Проверяем на дублирование события
                  const timestamp = Date.now();
                  const eventId = `${partID}-${partType}-${JSON.stringify(part?.time || {})}`;
                  if (eventDedup.isDuplicate('message.part.updated', eventId, timestamp)) {
                    console.warn('[KiloBackend] Skipping duplicate part.updated event:', partID, partType);
                    continue;
                  }

                  if (partID) {
                    // Сохраняем тип части в хранилище
                    let partData = messageParts.get(partID);
                    if (!partData) {
                      initializePart(partID, partType, part?.time, part?.tool);
                      partData = messageParts.get(partID);
                    } else {
                      partData.type = partType;
                      if (part?.time) partData.time = part?.time;
                      if (part?.tool) partData.tool = part?.tool;
                    }

                    // Для tools, сохранить в toolPartsMap и вызвать proposal если еще не
                    if (partType === 'tool') {
                      this.logEvent(this.logFile, 'tool_part_updated', { partID, tool: partData.tool, type: partType });
                      // Сохраняем tool part в Map для toolpartupdated событий
                      toolPartsMap.set(partID, part);
                      if (!isBuffered && !partData.proposed) {
                        partData.proposed = true;
                        if (callbacks.onToolProposal) {
                          callbacks.onToolProposal({ tool: partData.tool || 'unknown', input: '', partID });
                        }
                      }
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

                      // Для tools, вызвать onToolComplete если buffered, или обработать tool
                      if (partType === 'tool') {
                        this.logEvent(this.logFile, 'tool_completed', { partID, tool: partData.tool, input: partData.text });
                        if (!isBuffered && callbacks.onToolComplete) {
                          callbacks.onToolComplete({ tool: partData.tool || 'unknown', input: partData.text, output: '' });
                        }
                      }
                    }
                  }
                } else if (event.type === 'session.status') {
                  // Проверяем на дублирование события
                  const timestamp = Date.now();
                  const eventId = `${latestSessionId}-${JSON.stringify(event.properties?.status || {})}`;
                  if (eventDedup.isDuplicate('session.status', eventId, timestamp)) {
                    console.warn('[KiloBackend] Skipping duplicate session.status event');
                    continue;
                  }

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
                  this.logEvent(this.logFile, 'session_error', { error: errorMsg });
                } else if (event.type === 'toolpartupdated') {
                  // Обработка обновления состояния tool part
                  const { partID, tool: toolName } = event.data || {};
                  if (!partID) continue;

                  console.log('[KiloBackend] toolpartupdated:', { partID, toolName });

                  // Получаем tool part из Map
                  let toolPart = toolPartsMap.get(partID);
                  if (!toolPart) {
                    // Race condition: toolpartupdated пришел до message.part.updated
                    // Буферизуем событие для повторной обработки через 100ms
                    pendingToolEvents.push({ partID, toolName, event, retry: 0 });
                    setTimeout(() => retryToolEvent(partID), 100);
                    continue;
                  }

                  // Определяем статус
                  const status = toolPart.state?.status || toolPart.status || 'unknown';
                  const input = toolPart.input?.command || JSON.stringify(toolPart.input, null, 2) || '';

                  console.log('[TOOL EVENT]', { partID, toolName, status, inputLength: input.length });

                  // Обработка output: проверка на binary
                  let output = toolPart.output;
                  if (output && typeof output !== 'string') {
                    output = JSON.stringify(output, null, 2);
                  }
                  if (!output) output = '';

                  if (isBuffered) {
                    // В buffered mode буферизуем tool events
                    bufferedToolEvents.push({
                      partID, toolName, status, input,
                      output,
                      error: toolPart.error || toolPart.state?.error || '',
                      timestamp: Date.now()
                    });
                  } else {
                    // В native mode отправляем немедленно
                    if (status === 'pending' && callbacks.onToolProposal) {
                      callbacks.onToolProposal({ tool: toolName, input, partID });
                    } else if (status === 'running' && callbacks.onToolStart) {
                      callbacks.onToolStart({ tool: toolName, input, partID });
                    } else if (status === 'completed' && callbacks.onToolComplete) {
                      callbacks.onToolComplete({ tool: toolName, input, output, partID });
                    } else if (status === 'failed' && callbacks.onToolError) {
                      const error = toolPart.error || toolPart.state?.error || 'Unknown error';
                      callbacks.onToolError({ tool: toolName, input, error, partID });
                    }
                  }

                  this.logEvent(this.logFile, 'toolpartupdated', { partID, toolName, status, input: input.substring(0, 100) });

                } else if (event.type === 'session.turn.close') {
                  // Проверяем на дублирование события
                  const timestamp = Date.now();
                  const eventId = `${latestSessionId}-turn-close`;
                  if (eventDedup.isDuplicate('session.turn.close', eventId, timestamp)) {
                    console.warn('[KiloBackend] Skipping duplicate session.turn.close event');
                    continue;
                  }

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
      this.logEvent(this.logFile, 'prompt_response', { status: promptResp.status });

      // Ожидаем завершения обработки событий с таймаутом 60 секунд
      const timeoutPromise = new Promise(r => setTimeout(r, 60000));
      await Promise.race([eventPromise, timeoutPromise]).catch(() => {});

      // Для buffered mode, отправляем все накопленные parts в правильном порядке
      if (isBuffered && !doneCalled) {
        allParts.sort((a, b) => (a.time?.start || 0) - (b.time?.start || 0));
        console.log('[KiloBackend] Buffered mode: processing', allParts.length, 'parts');
        for (const part of allParts) {
          if (part.type === 'reasoning' && callbacks.onReasoning) {
            callbacks.onReasoning(part.text);
            this.logEvent(this.logFile, 'buffered_reasoning', { length: part.text.length });
          } else if (part.type === 'text' && callbacks.onText) {
            callbacks.onText(part.text);
            this.logEvent(this.logFile, 'buffered_text', { length: part.text.length });
          } else if (part.type === 'tool' && callbacks.onTool) {
            callbacks.onTool({ type: 'tool', tool: part.tool || 'unknown', input: part.text });
            if (callbacks.onToolProposal) callbacks.onToolProposal({ tool: part.tool || 'unknown', input: part.text });
            if (callbacks.onToolStart) callbacks.onToolStart({ tool: part.tool || 'unknown', input: part.text });
            if (callbacks.onToolComplete) callbacks.onToolComplete({ tool: part.tool || 'unknown', input: part.text, output: '' });
            this.logEvent(this.logFile, 'buffered_tool', { tool: part.tool, inputLength: part.text.length });
          }
        }

        // Отправляем buffered tool events в порядке timestamp
        bufferedToolEvents.sort((a, b) => a.timestamp - b.timestamp);
        for (const toolEvent of bufferedToolEvents) {
          const { partID, toolName, status, input, output, error } = toolEvent;
          if (status === 'pending' && callbacks.onToolProposal) {
            callbacks.onToolProposal({ tool: toolName, input, partID });
          } else if (status === 'running' && callbacks.onToolStart) {
            callbacks.onToolStart({ tool: toolName, input, partID });
          } else if (status === 'completed' && callbacks.onToolComplete) {
            callbacks.onToolComplete({ tool: toolName, input, output, partID });
          } else if (status === 'failed' && callbacks.onToolError) {
            callbacks.onToolError({ tool: toolName, input, error, partID });
          }
          console.log('[BUFFERED TOOL EVENT]', { partID, toolName, status });
        }
      }

      // Убеждаемся, что onDone вызван
      if (!doneCalled) {
        doneCalled = true;
        if (callbacks.onDone) callbacks.onDone(latestSessionId);
      }

    } catch (error) {
      console.log('[KiloBackend] Error:', error.message);
      this.logEvent(this.logFile, 'request_error', { error: error.message });
      if (callbacks.onError) callbacks.onError(error.message);
    } finally {
      // Очищаем активную подписку при завершении
      if (latestSessionId && this.activeSubscriptions.has(latestSessionId)) {
        this.activeSubscriptions.delete(latestSessionId);
        console.log('[KiloBackend] Cleaned up subscription for session:', latestSessionId);
      }
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