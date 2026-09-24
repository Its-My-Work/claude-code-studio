# Providers and the LLM bridge

Every run in the studio — chat, multi-agent, rooms, `@@bots`, Kanban tasks, schedules,
Telegram, the utility calls (titles, compaction, translation) — is the `claude` CLI. The
CLI is what gives each mode its tools, MCP servers, hooks, session resume and
compaction. "Another provider" therefore means "another endpoint and model **for this
run**": the registry decides it, the spawn applies it, and for anything that does not
speak the Anthropic Messages API the **LLM bridge** translates.

```
chat / task / bot / room / Telegram
        │ model = "deepseek::deepseek-chat" (or a bare alias like "sonnet")
server.js  resolveRunTarget()  ← providers.js rules, providers-store.js rows
        │ ANTHROPIC_BASE_URL = http://127.0.0.1:<bridge>   ANTHROPIC_AUTH_TOKEN = ccsr_<run token>
claude CLI ─────────────► llm-bridge (separate node process, loopback only)
                             ├─ passthrough → Anthropic API / Anthropic-compatible endpoints
                             ├─ translate   → OpenAI-compatible endpoints (/chat/completions)
                             └─ usage       → llm_usage (SQLite)
Claude subscription (CLI login) never goes through the bridge.
```

## Provider types

| Type | Reached by | Notes |
|---|---|---|
| `claude-subscription` | the CLI's own login (OAuth) | Built-in row `claude`. The only type the tmux **Subscription** engine runs on. |
| `anthropic` | bridge, passthrough | Anthropic API key. |
| `anthropic-compatible` | bridge, passthrough | Any `/v1/messages` endpoint: a gateway such as kilo-gateway, or the Anthropic endpoints of DeepSeek, Kimi, GLM, MiniMax. For Claude Code these are more faithful than translation. |
| `openai-compatible` | bridge, **translation** | `/chat/completions`: OpenAI, OpenRouter, Gemini, Qwen, Groq, Mistral, xAI, Ollama, LM Studio, vLLM… A **dialect** describes how effort, reasoning and the token limit are sent. |

On first start the registry is seeded from the environment: `ANTHROPIC_BASE_URL` (+ its
token) becomes provider `gateway`, the **default** — that is what every run used before,
so a bare `sonnet` stored in an old row keeps landing on the same endpoint. An env-seeded
row follows the env on later boots until it is edited in the UI.

## Model references

One string, everywhere a model already travelled (`sessions.model`, `tasks.model`,
`bots.model`, WS frames, MCP `create_task`, plan files, bot exports):

- `provider::model` — e.g. `deepseek::deepseek-chat`, `kilo::z-ai/glm-5:free`;
- a bare value — `sonnet`, or an old gateway id — resolved on the **default** provider.

On a provider that does not serve Claude, an alias maps through its **roles**:
`haiku → fast`, `sonnet`/`fable → main`, `opus → strong`. A chat pinned to a provider that
was deleted or switched off runs on the default and says so (`provider_notice`).

## What reaches the CLI per run

`providers.buildRunEnv()` first strips every provider variable the server itself inherited,
then sets the run's own:

| Variable / flag | Value | Why |
|---|---|---|
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` | bridge URL, run token | the real key never enters the agent's environment |
| `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS,FABLE}_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL` | provider roles | the CLI's own background calls and sub-agents ask for Claude aliases |
| `CLAUDE_CODE_SUBAGENT_MODEL` | role `subagent` if set | Task sub-agents |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | model context window | for an unknown id the CLI assumes 200K and compacts on that |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | `min(maxOutput, 32000)` | the CLI asks for 32–128K |
| `CLAUDE_CODE_DISABLE_THINKING` | model cannot reason | |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | OpenAI-compatible, or `stripBetas` | fewer fields a foreign backend does not know |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | non-Anthropic (unless `quietCli: false`) | no traffic around the bridge |
| `API_TIMEOUT_MS` | provider option | slow reasoning models |
| `--disallowedTools WebSearch` | non-Anthropic | an Anthropic server tool; the `web` MCP server (SearXNG) replaces it |

The bridge takes **effort** from the run (the toolbar's dial), not from the request: the
CLI sends `effort: "high"` even when no `--effort` was given. `Auto` means "send none".

## What the bridge maps (OpenAI-compatible)

System blocks → one system message (the per-request billing header dropped for prompt
caching) · text / images (vision-gated) / PDFs (file parts or a placeholder) · `tool_use` →
`tool_calls` · `tool_result` → `role: tool` (images move to a following user message,
`is_error` is labelled) · reasoning echoed back per dialect (`reasoning_content` /
`reasoning_details`) via the thinking-block signature · tool schemas sanitised, long tool
names mapped · `tool_choice`, parallel calls · `max_tokens` / `max_completion_tokens`
clamped · sampling params per dialect · `metadata.user_id` hashed · streaming with pings
every 15 s, tool calls buffered so interleaved deltas cannot mix, broken argument JSON
repaired · `stop_reason`, usage with cached tokens · errors canonicalised: context overflow →
`prompt is too long` (the CLI compacts), a spent balance → `credit balance is too low`
(the task pauses, no retries), 429 with `Retry-After`, 5xx/transport → 529 (the CLI retries).

## Security model

- Keys are encrypted at rest with the SSH-host key (`data/hosts.key`, AES-256-GCM); the API
  answers `hasKey` and masks secret-looking header values.
- The CLI sees only a run token, valid on 127.0.0.1 for the run's lifetime (+5 s).
- **Limit, stated:** the agent runs with a shell in the same container as the studio, so a
  determined agent can still read the data directory. The run token closes accidental
  leaks (a key printed to a log, committed, sent in a report), not deliberate extraction —
  the same boundary SSH host passwords and the Telegram token already live behind.

## Operating it

- **Sidebar → Providers**: add (presets), test before saving, default ★, per-model
  capabilities and prices, a probe (a forced tool call + a short reply through the bridge),
  the utility model, 30-day usage.
- **Toolbar**: the four alias chips are the default provider's; `⋯` lists every provider's
  models. Subscription is off for a non-Claude model; effort is off for a model that
  cannot reason.
- **Telegram**: `/model`, `/effort`.
- `GET /api/llm-bridge/log` — the last 200 bridge requests (no content).
- `CCS_BRIDGE=off` disables the bridge (Anthropic-type providers then run with their key in
  the CLI env, as before this registry; OpenAI-compatible ones cannot run).
- `CCS_BRIDGE_PORT` pins the bridge port (default: ephemeral, reused across child restarts).

## Upgrading the CLI

The Dockerfile pins `@anthropic-ai/claude-code` (`CLAUDE_CODE_VERSION`) and CI installs the
same version so `test/llm-bridge-contract.test.js` drives the real binary through the bridge.
Bump both together, and look at the captured request fixture in
`test/fixtures/llm-bridge/` when a new CLI changes its request shape.

## Not covered yet

- SSH projects: the remote `claude` runs on that host's own login/config; a provider ref is
  passed as its bare model id.
- The tmux Subscription engine runs Claude's own login only.
- External agents (`externalAgents`, delegation) keep their own CLIs and credentials.
