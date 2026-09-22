# Plan → Kanban import

A planner bot writes a plan/ package to disk; it never creates a Kanban card (see the `planner` bot's own prompt). This is the bridge: a linted preview the user approves, then the server — not an LLM — writes the cards.

## Format

`plan/tasks/T-001-slug.md`:
```
---
id: T-001
title: short title
bot: kolya-prohramist
depends_on: []
model: sonnet
max_turns: 30
covers: [ТЗ §3.2, ТЗ §5]
status: backlog
---
body (first ~2000 chars become the card's description; the rest stays in its `context`)
## Критерии приёмки
...
## Проверка
...
```
`plan/00-overview.md` is free text (goals, phase order, open questions) — read for the card's subtitle, not otherwise parsed.

## The check (`plan-lib.js`, pure, no fs)

- **Errors** (block approval): duplicate id, unknown/missing bot, `depends_on` pointing at a missing id or itself, a dependency cycle, missing title.
- **Warnings** (shown, do not block): no `## Критерии приёмки` / `## Проверка` section, no `covers`, a ТЗ section that no task's `covers` mentions.
- **Coverage**: the ТЗ file is *guessed* from the project root — any `.md` file whose name contains "tz", "тз" or "спец" (`plan-lib.js: guessTzFile`). Not found → coverage is simply skipped, not guessed at with a false answer.

`plan-import.js` reads the files (fs, `fsImpl` injectable for tests) and turns them into the review object; `server.js` owns everything DB-specific (matching against existing cards, writing them).

## Approval card

Posted automatically the moment a room's closing step changes `plan/tasks/*.md` (the disk diff the room already computes for the "files changed" note — no extra model call). Shows the task table with checkboxes (deselecting a task also deselects whatever depends on it), errors/warnings, and an "Approve to Backlog" button. Restored identically from the DB on reload (`messages.type = 'plan_review'`); once imported it shows the created/updated/skipped counts instead of checkboxes.

## Import (`POST /api/plans/import`, and the WS `approve_plan` the card's button sends)

- Re-reads and re-lints the files **fresh** — never trusts a review the client held on to.
- Cards land as `status: 'backlog'` — approving a plan never starts unattended work; the user moves a card to `todo` when ready.
- **Idempotent**: a card once imported carries `tasks.plan_task_id` ("T-003"); re-approving updates that same card (title/description/context/bot/model/`depends_on`) instead of creating a duplicate, and does **not** reset a status the user already changed (`in_progress`/`done` stay put).
- Deselecting a task's dependency skips the dependent too, named why — never a card with a dangling `depends_on`.
- `depends_on` is remapped from plan ids to real Kanban ids in a second pass, the same two-pass approach `/api/tasks/dispatch` uses.
- Cap: 200 tasks per plan (`PLAN_IMPORT_MAX`) — a user-approved import, not agent-spawned, so no per-run child-task throttle.

`POST /api/plans/review` is the dry run (no writes) — usable standalone, e.g. after hand-editing plan files, without re-running the room.

## Known gap

No manual "review this plan again" button in the UI yet — only the automatic trigger right after a room's closing step and the two HTTP endpoints. A project without a `planner` bot, or a closing step that touches no `plan/tasks/*.md` file, never shows a card.
