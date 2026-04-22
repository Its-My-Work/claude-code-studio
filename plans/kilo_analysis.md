# Анализ Kilo CLI для миграции

## ✅ Результаты анализа

### 1. Версия Kilo
```
7.2.20
```

### 2. Основные команды
- `kilo run [message..]` — запуск с сообщением (автономный режим)
- `kilo [project]` — интерактивный TUI режим
- `kilo --continue` или `kilo -c` — продолжить последнюю сессию
- `kilo --session <id>` — продолжить конкретную сессию
- `kilo --fork` — форкировать сессию

### 3. Флаги для `kilo run`
```
--format: default | json (для парсинга)
--auto: автоматическое одобрение всех разрешений
--dangerously-skip-permissions: пропустить проверку разрешений
--model: модель в формате provider/model
--agent: выбрать агента
--continue / -c: продолжить последнюю сессию
--session: продолжить конкретную сессию
--fork: форкировать сессию
--file / -f: прикрепить файлы
--dir: директория для запуска
--thinking: показывать thinking блоки
--variant: вариант модели (high, max, minimal)
```

### 4. Доступные агенты
- **code** (default) — основной агент для выполнения задач
  - Инструменты: bash, read, glob, grep, edit, write, task, webfetch, skill, question, suggest, plan_exit
  - Разрешения: bash allow, read allow, edit ask, external_directory ask

### 5. Инструменты Kilo (из конфига агента code)
```
- bash (с разрешениями для: cat, head, tail, less, ls, tree, pwd, echo, wc, which, type, file, diff, du, df, date, uname, whoami, printenv, man, grep, rg, ag, sort, uniq, cut, tr, jq, touch, mkdir, cp, mv, tsc, tsgo, tar, unzip, gzip, gunzip)
- read (чтение файлов)
- glob (поиск файлов по паттерну)
- grep (поиск в файлах)
- edit (редактирование файлов)
- write (создание файлов)
- task (создание подзадач)
- webfetch (загрузка с веб)
- todowrite (запись в TODO)
- skill (использование skills)
- question (задать вопрос)
- suggest (предложить решение)
- plan_exit (выход из плана)
- kilo_local_recall (локальное воспоминание)
```

### 6. Модели
Kilo поддерживает динамические модели через провайдеров:
- anthropic (Claude модели)
- openai (GPT модели)
- google (Gemini модели)
- deepseek
- openrouter (множество моделей)
- И другие...

Формат: `provider/model` (например: `anthropic/claude-sonnet-4-20250514`)

### 7. Сессии
```
kilo session list — список сессий
kilo session delete <sessionID> — удалить сессию
kilo --continue — продолжить последнюю сессию
kilo --session <id> — продолжить конкретную сессию
kilo --fork — форкировать сессию
```

### 8. MCP интеграция
```
kilo mcp add — добавить MCP сервер
kilo mcp list — список MCP серверов
kilo mcp auth [name] — OAuth аутентификация
kilo mcp logout [name] — удалить OAuth credentials
kilo mcp debug <name> — отладка OAuth
```

Конфиг MCP в `kilo.json`:
```json
{
  "mcp": {
    "server-name": {
      "type": "local" | "remote",
      "command": ["node", "server.js"],  // для local
      "url": "https://...",              // для remote
      "environment": {...},
      "enabled": true
    }
  }
}
```

### 9. Конфигурация
Файлы конфигурации (в порядке приоритета):
1. `~/.config/kilo/kilo.json` (глобальный)
2. `.kilo/kilo.json` (проект)
3. `.kilocode/kilo.json` (legacy проект)
4. `.opencode.json` (legacy)

Поддерживаемые форматы: `.json`, `.jsonc`

### 10. Формат вывода
- `--format default` — форматированный вывод (по умолчанию)
- `--format json` — JSON события (для парсинга)

### 11. Skills
Kilo поддерживает skills (аналог Claude skills):
```
~/.config/kilo/skill/name/SKILL.md
.kilo/skill/name/SKILL.md
.kilocode/skill/name/SKILL.md
```

### 12. Permissions система
Kilo имеет встроенную систему разрешений:
```json
{
  "permission": {
    "bash": "allow" | "ask" | "deny",
    "edit": {
      "src/**": "allow",
      "*": "ask"
    },
    "external_directory": "ask"
  }
}
```

## 🔑 Ключевые отличия от Claude

| Аспект | Claude | Kilo |
|--------|--------|------|
| Интерфейс | Веб-UI + CLI | TUI + CLI (`kilo run`) |
| Режимы | planning/task/auto | architect/ask/debug/orchestrator + custom |
| Модели | Жестко кодированы | Динамические через провайдеров |
| Сессии | `--resume <id>` | `--session <id>` или `--continue` |
| MCP | `--mcp-config` флаг | Конфиг файл `kilo.json` |
| Инструменты | Явно перечислены | Через permission систему |
| Вывод | stream-json | default или json |
| Агенты | Встроенные | Встроенные + custom в `.kilo/agent/` |
| Разрешения | Встроены в код | Конфигурируемые в `kilo.json` |

## 🎯 Выводы для миграции

1. **Kilo использует `kilo run` для автономного режима** — нужно создать wrapper аналогично `ClaudeCLI`
2. **Формат вывода может быть JSON** — нужно парсить `--format json`
3. **Сессии работают через флаги** — `--session <id>` вместо `--resume`
4. **MCP конфигурируется через файлы** — нужно создавать `kilo.json` перед вызовом
5. **Инструменты контролируются через permission систему** — нужен маппинг разрешений
6. **Агенты можно кастомизировать** — можно создать агент для каждого режима Claude
7. **Модели динамические** — нужен маппинг моделей через конфиг
