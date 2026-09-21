# Per-bot engine

A bot can pin its own billing engine, independent of the chat:

| Bot setting | Runs on |
|---|---|
| **Same as chat** (default) | the chat's engine: API or Claude subscription |
| **API** | headless `claude -p` through `ANTHROPIC_BASE_URL` / the configured token |
| **Claude subscription** | an interactive `claude` in a tmux pane, signed in with the server's Claude login |

The typical use is one bot (a planner) on the subscription while the chat and every other bot stay on the API.

## Where it applies

- Web chat: `@@mentions` and the room (`conversation` mode). A pinned bot gets its own pane (`<chat>::room::<bot>` / `<chat>::<bot>`), killed right after its turn, exactly as in a subscription chat.
- **Not** Telegram: its bot runner has no WebSocket to stream a pane into, so a pinned bot follows the chat there.
- Without `tmux` on the server a "Claude subscription" bot follows the chat instead of failing every turn.
- The room's own headless calls (choosing who sits, the closing step's prompt) still follow the chat engine.

## Things to know

- The subscription engine removes `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` from the pane's environment (`claude-interactive.js`), so it uses the stored login, not the gateway.
- There is no headless call on the subscription, so `--json-schema` is unavailable to such a bot; give it an MCP tool that validates its input instead.
- Tasks on the Kanban board have their own `run_engine`. A bot's setting does not change how its cards run, and a card created by a subscription task inherits that task's engine unless the creator sets one.
- `model` is per bot too: on the subscription it is a real Claude model (`haiku`/`sonnet`/`opus`/`fable`), on the API it is whatever the gateway maps that alias to.

API: `PUT /api/bots/:id { "runEngine": "subscription" | "api" | "" }` (`""` = same as chat; omitted = unchanged). Exported and imported with the bot as `run_engine`.

## Model per bot

The bot editor offers, next to the engine, a model list built from two sources:

- **Claude aliases** (`haiku`, `sonnet`, `opus`, `fable`) — valid on both engines.
- **Gateway models** — the catalogue of the gateway the `claude` CLI talks to (`GET /api/models`, read from `ANTHROPIC_BASE_URL/v1/models` with the server's own token, cached for 10 minutes). Shown for "API" and "Same as chat"; hidden for "Subscription". A model the gateway reports without `tools` is labelled as such (a bot without tools cannot read or write the project).

The `claude` CLI passes any `--model <id>` to the gateway unchanged, so pinning e.g. `poolside/laguna-s-2.1:free` really selects that model instead of whatever the gateway maps `sonnet` to.

A gateway id on a bot that ends up on the subscription (its own setting, or the chat's) is meaningless there: the turn uses the chat's model, and the header shows that model rather than the pinned one. If the gateway is unreachable the editor still opens with the aliases, and a stored model that is no longer offered stays selectable. `model` must match `[A-Za-z0-9._:/-]{1,100}`.
