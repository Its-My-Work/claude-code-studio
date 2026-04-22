# Дорожная карта реализации: Минимальный путь к MVP

## 🎯 Стратегия: Минимум боли, максимум результата

Вместо полной рефакторизации, создаем **параллельный backend** с feature flag. Это позволит:
- Не трогать существующий Claude код
- Тестировать Kilo в production без риска
- Откатиться за 5 минут если что-то сломается
- Постепенно мигрировать функциональность

## 📋 MVP Scope (Фаза 1)

**Цель:** Запустить базовый чат через Kilo с минимальными изменениями

### Что реализуем:
1. ✅ `KiloRunner` — subprocess wrapper для `kilo run`
2. ✅ `KiloResponseParser` — парсинг JSON вывода
3. ✅ Feature flag в конфиге для выбора backend
4. ✅ Базовая интеграция в `runCliSingle()`

### Что НЕ реализуем в MVP:
- ❌ Multi-agent режим (используем fallback на single)
- ❌ SSH интеграция (используем только локальный Kilo)
- ❌ Полная система разрешений (используем `--auto`)
- ❌ Кастомные агенты (используем встроенный `code`)
- ❌ Миграция существующих сессий

## 🔧 Минимальный набор файлов

```
src/
├── backends/
│   ├── agent-backend.js          (интерфейс)
│   ├── claude-backend.js          (рефакторинг текущего кода)
│   └── kilo-backend.js            (новый)
│       ├── kilo-runner.js         (subprocess)
│       ├── kilo-response-parser.js (парсинг)
│       └── kilo-config.js         (конфиг)
└── backend-factory.js             (выбор backend)
```

## 📝 Пошаговая реализация

### Шаг 1: Создать интерфейс AgentBackend
```javascript
// backends/agent-backend.js
class AgentBackend {
  send(options) {
    // { prompt, sessionId, model, maxTurns, mode, mcpServers, ... }
    // Возвращает объект с методами: .onText(), .onTool(), .onError(), .onDone()
  }
}
```

### Шаг 2: Создать KiloRunner
```javascript
// backends/kilo-backend/kilo-runner.js
class KiloRunner {
  async run(prompt, options) {
    // Запустить: kilo run "prompt" --auto --format json --model X
    // Парсить JSON события
    // Вернуть результат
  }
}
```

### Шаг 3: Создать KiloResponseParser
```javascript
// backends/kilo-backend/kilo-response-parser.js
class KiloResponseParser {
  parseJsonEvent(line) {
    // Парсить JSON события из Kilo
    // Преобразовать в единый формат
  }
}
```

### Шаг 4: Создать KiloBackend
```javascript
// backends/kilo-backend.js
class KiloBackend extends AgentBackend {
  send(options) {
    // Использовать KiloRunner + KiloResponseParser
    // Вернуть совместимый результат
  }
}
```

### Шаг 5: Создать BackendFactory
```javascript
// backends/backend-factory.js
function createBackend(engine) {
  if (engine === 'claude') return new ClaudeBackend();
  if (engine === 'kilo') return new KiloBackend();
  throw new Error(`Unknown engine: ${engine}`);
}
```

### Шаг 6: Интегрировать в server.js
```javascript
// server.js
const backend = createBackend(process.env.AGENT_ENGINE || 'claude');

// В runCliSingle():
const result = await backend.send({
  prompt,
  sessionId,
  model,
  maxTurns,
  mode,
  mcpServers,
  // ...
});
```

### Шаг 7: Добавить конфиг
```json
// .env
AGENT_ENGINE=kilo  // или claude
```

## 🧪 Тестирование MVP

### Минимальные тесты:
1. Запустить `kilo run "echo test"` и парсить вывод
2. Проверить, что текст приходит через `.onText()`
3. Проверить, что ошибки приходят через `.onError()`
4. Проверить, что сессия сохраняется

### Не нужно тестировать в MVP:
- Multi-agent
- SSH
- Все режимы (только `code`)
- Все модели (только одна)

## 📊 Сравнение подходов

| Подход | Сложность | Риск | Время |
|--------|-----------|------|-------|
| Полная рефакторизация | Высокая | Высокий | Долго |
| Параллельный backend | Средняя | Низкий | Быстро |
| Постепенная миграция | Низкая | Минимальный | Очень быстро |

**Рекомендация:** Параллельный backend (MVP) → Постепенная миграция

## 🚀 Фазы после MVP

### Фаза 2: Расширение функциональности
- Поддержка всех режимов (architect, ask, debug, orchestrator)
- Поддержка всех моделей
- Система разрешений
- Кастомные агенты

### Фаза 3: Продвинутые функции
- Multi-agent режим
- SSH интеграция (если нужна)
- Миграция сессий
- Полная совместимость

### Фаза 4: Оптимизация
- Кеширование конфигов
- Оптимизация парсинга
- Мониторинг и логирование
- Документация

## ✅ Информация для реализации

Да, у нас есть ВСЯ информация:

1. ✅ Формат вывода Kilo (JSON через `--format json`)
2. ✅ Флаги Kilo (`--auto`, `--session`, `--model`, и т.д.)
3. ✅ Инструменты Kilo (идентичны Claude)
4. ✅ Режимы Kilo (architect, code, debug, orchestrator)
5. ✅ Модели Kilo (динамические через провайдеров)
6. ✅ Сессии Kilo (`--session <id>`, `--continue`)
7. ✅ MCP Kilo (конфиг файлы)
8. ✅ Агенты Kilo (встроенные + кастомные)

## 🎬 Начало реализации

1. Создать файлы в `src/backends/`
2. Реализовать `KiloRunner` (самая критичная часть)
3. Реализовать `KiloResponseParser` (парсинг JSON)
4. Создать `KiloBackend` (обертка)
5. Интегрировать в `server.js` через feature flag
6. Тестировать локально
7. Развернуть в production с флагом `AGENT_ENGINE=claude` (по умолчанию)

## 📌 Критические моменты

1. **JSON парсинг** — нужно получить примеры реального вывода Kilo
2. **Обработка ошибок** — нужно правильно обрабатывать ошибки Kilo
3. **Таймауты** — нужно установить таймауты для `kilo run`
4. **Конфиг Kilo** — нужно создавать `kilo.json` перед вызовом
5. **Модели** — нужно маппировать Claude модели на Kilo модели

## 🎯 Итог

**Минимальный путь:** 
- 3-4 новых файла (~500 строк кода)
- 1-2 дня разработки
- Нулевой риск для существующего функционала
- Полная совместимость с текущей архитектурой