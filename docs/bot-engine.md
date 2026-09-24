# A bot's model and engine

There is no engine setting — not on a chat, a task or a bot. **The model's provider decides the
engine** (`server.js runEngineFor`, `providers.engineForModel`):

| The model belongs to | Runs on |
|---|---|
| **Claude (CLI login)** — the built-in provider, marked *subscription* | an interactive `claude` in a tmux pane, signed in with the server's Claude login (billed on the subscription) |
| any other provider — an Anthropic key ("Claude API"), a gateway, anything OpenAI-compatible — marked *API* | headless `claude -p`, routed to that provider (see `docs/providers.md`) |

Without `tmux` on the server the CLI login still works, headless. Every list that offers a
model — the toolbar picker, the bot editor, Kanban, Schedule, Telegram `/model`, the Providers
sidebar — marks each provider *subscription* or *API*, so the choice of model is the choice of
engine.

## The bot editor

One **Model** button opens the same picker as the chat toolbar, with **Same as chat** on top.
"Same as chat" follows the chat the bot answers in; anything else pins that model (stored as the
toolbar stores it: a bare alias of the default provider, or `provider::model`). The typical use
is one bot (a planner) on `Claude (CLI login) · Opus` while the chat and every other bot stay
on an API provider.

## Where it applies

- Web chat: `@@mentions` and the room (`conversation` mode). A bot on a subscription model gets
  its own pane (`<chat>::room::<bot>` / `<chat>::<bot>`), killed right after its turn, exactly
  as in a subscription chat.
- **Not** Telegram: its bot runner has no WebSocket to stream a pane into, so there every bot
  follows the chat's engine (a Claude model then runs headless on the CLI login).
- The room's own headless calls (choosing who sits, the closing step's prompt) follow the chat.

## Things to know

- The subscription engine removes every provider variable (`ANTHROPIC_BASE_URL`, tokens, keys)
  from the pane's environment (`claude-interactive.js`), so it uses the stored login.
- There is no headless call on the subscription, so `--json-schema` is unavailable to such a
  bot; give it an MCP tool that validates its input instead.
- Kanban tasks follow the same rule with their own model chain
  (`bot.model || session.model || task.model`), so a card run by that bot runs where the bot does.

## Upgrading from the engine dial

The old per-chat/task/bot "Subscription" choice is converted once at boot
(`migrateEngineDial`, flag `engineDialMigrated` in `provider_settings`): where it was chosen,
the model becomes `claude::<model>` (`providers.toClaudeRef`) and `tasks`/`bots.run_engine` is
cleared. An older client or export file that still sends `runEngine: "subscription"` gets the
same conversion on save/import. `sessions.run_engine` now records the engine the chat's last
turn ran on (the session bar's Max badge and the engine-pane entry point read it).
