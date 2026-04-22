# Agent Backends

Система абстракции для поддержки различных AI backend'ов (Claude Code и Kilo Code).

## Архитектура

```
AgentBackend (интерфейс)
├── ClaudeBackend (текущая реализация)
│   └── ClaudeCLI (subprocess wrapper)
└── KiloBackend (новая реализация)
    ├── KiloRunner (subprocess wrapper)
    ├── KiloResponseParser (парсинг JSON)
    └── KiloConfig (управление конфигом)
```

## Использование

### Выбор backend через конфиг

```bash
# Использовать Claude (по умолчанию)
AGENT_ENGINE=claude npm start

# Использовать Kilo
AGENT_ENGINE=kilo npm start
```

### Программное использование

```javascript
const BackendFactory = require('./backends/backend-factory');

// Создать backend
const backend = BackendFactory.createBackend('kilo', { cwd: process.cwd() });

// Отправить сообщение
backend.send({
  prompt: 'Hello, world!',
  model: 'sonnet',
  sessionId: 'session-123',
  mcpServers: {},
  abortController: new AbortController(),
})
  .onText((text) => console.log('Text:', text))
  .onTool((name, input) => console.log('Tool:', name, input))
  .onError((error) => console.error('Error:', error))
  .onDone((sessionId) => console.log('Done:', sessionId));
```

## Файлы

### `agent-backend.js`
Интерфейс для всех backend'ов. Определяет методы:
- `send(options)` — отправить сообщение
- `getStatus()` — получить статус
- `setMode(mode)` — установить режим
- `setModel(model)` — установить модель
- `manageSession(sessionId, action)` — управление сессией

### `claude-backend.js`
Реализация для Claude Code. Обертка над `ClaudeCLI`.

### `kilo-backend.js`
Реализация для Kilo Code. Использует:
- `KiloRunner` — запуск `kilo run` как subprocess
- `KiloResponseParser` — парсинг JSON вывода
- `KiloConfig` — управление конфигом Kilo

### `backend-factory.js`
Фабрика для создания backend'ов. Методы:
- `createBackend(engine, options)` — создать backend
- `getCurrentEngine()` — получить текущий engine
- `isEngineAvailable(engine)` — проверить доступность
- `getAvailableEngines()` — список доступных engine'ов

## Маппинги

### Режимы
| Claude | Kilo |
|--------|------|
| planning | architect |
| task | code |
| auto | orchestrator |

### Модели
| Claude | Kilo |
|--------|------|
| haiku | anthropic/claude-haiku-4.5 |
| sonnet | anthropic/claude-sonnet-4-20250514 |
| opus | anthropic/claude-opus-4.6 |

### Инструменты
Инструменты идентичны между Claude и Kilo:
- bash
- read (View)
- edit (SearchReplace)
- write (Write)
- glob (GlobTool)
- grep (GrepTool)
- И другие...

## Интеграция в server.js

В `runCliSingle()` функции:

```javascript
// Вместо:
const cli = new ClaudeCLI({ cwd: workdir || WORKDIR });

// Используем:
const cli = BackendFactory.createBackend(process.env.AGENT_ENGINE, { cwd: workdir || WORKDIR });
```

Остальной код остается без изменений благодаря совместимому интерфейсу.

## Тестирование

### Базовый тест Claude
```bash
AGENT_ENGINE=claude npm start
# Открыть http://localhost:3000
# Отправить сообщение в чат
```

### Базовый тест Kilo
```bash
AGENT_ENGINE=kilo npm start
# Открыть http://localhost:3000
# Отправить сообщение в чат
```

## Известные ограничения MVP

1. **Kilo**: Используется `--auto` флаг (автоматическое одобрение разрешений)
2. **Kilo**: Не поддерживается SSH (только локальный Kilo)
3. **Kilo**: Не поддерживается multi-agent режим (fallback на single)
4. **Kilo**: Не поддерживаются кастомные агенты (используется встроенный `code`)

## Будущие улучшения

1. Полная система разрешений для Kilo
2. SSH поддержка для Kilo
3. Multi-agent режим для Kilo
4. Кастомные агенты для Kilo
5. Миграция сессий между backend'ами
6. Кеширование конфигов Kilo
7. Оптимизация парсинга JSON
8. Мониторинг и логирование

## Разработка

### Добавление нового backend

1. Создать класс, наследующий `AgentBackend`
2. Реализовать методы интерфейса
3. Добавить в `BackendFactory.createBackend()`
4. Добавить маппинги режимов и моделей
5. Написать тесты

Пример:

```javascript
const AgentBackend = require('./agent-backend');

class MyBackend extends AgentBackend {
  send(options) {
    // Реализация
  }

  async getStatus() {
    return { backend: 'my-backend', version: '1.0.0' };
  }

  // ... остальные методы
}

module.exports = MyBackend;
```

Затем добавить в `backend-factory.js`:

```javascript
case 'my-backend':
  return new MyBackend(options);
```
