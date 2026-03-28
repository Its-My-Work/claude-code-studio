# Roadmap: Telegram Bot UX Redesign

## Overview

The 4693-line telegram-bot.js is a working but painful daily driver. The redesign fixes this in four phases ordered by dependency: first establish a stable state machine foundation (Phase 1), then rebuild all user-facing navigation on that foundation (Phase 2), then extract forum code as a separate module once direct mode is stable (Phase 3), and finally clean up the server.js coupling (Phase 4). The result: a user reaches Claude in 2 taps from any state, navigation never dead-ends, and the codebase is split into maintainable modules.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Foundation** - Extract i18n to separate file and replace ad-hoc flag state with explicit FSM
- [ ] **Phase 2: UX Redesign** - Rebuild navigation, screens, persistent keyboard, and streaming on the new FSM
- [ ] **Phase 3: Forum Extraction** - Extract TelegramBotForum class to separate module
- [ ] **Phase 4: Server Encapsulation** - Expose public factory method; remove server.js private method calls

## Phase Details

### Phase 1: Foundation
**Goal**: The bot has a stable, explicit state machine and a separate i18n file — making it safe to build new UX on top
**Depends on**: Nothing (first phase)
**Requirements**: ARCH-01, FSM-01, FSM-02, FSM-03, FSM-04, FSM-05
**Success Criteria** (what must be TRUE):
  1. `telegram-bot-i18n.js` exists as a standalone file; `telegram-bot.js` imports from it and is ~825 lines shorter
  2. `ctx.state` is the single source of pending-input truth — `ctx.pendingInput`, `ctx.pendingAskRequestId`, and `ctx.composing` no longer exist in any code path
  3. Sending a task-creation prompt, then typing a different message, routes that message to Claude (not silently captured as a task title)
  4. Every slash command cancels any in-progress input state before executing
  5. All previously paired devices continue responding without re-pairing after the migration deploys
**Plans**: TBD

### Phase 2: UX Redesign
**Goal**: Users can reach Claude in 2 taps from any state, navigate without dead ends, and see their active context at all times
**Depends on**: Phase 1
**Requirements**: NAV-01, NAV-02, NAV-03, NAV-04, NAV-05, NAV-06, KB-01, KB-02, KB-03, ARCH-02, ARCH-03, ARCH-04, STREAM-01
**Success Criteria** (what must be TRUE):
  1. From any screen (or fresh /start), a user can send a message to Claude with at most 2 taps — no slash commands typed
  2. Every inline keyboard screen shows a Back button; tapping it always goes exactly one level up (never a dead end, never a full reset)
  3. Every screen message shows "Currently: [project name] / [chat name]" (or "none selected") in the header — no navigation required to see active context
  4. Tapping any navigation button edits the existing screen message in place; no new messages appear in chat for navigation actions
  5. The persistent bottom keyboard always shows the active project/chat name, and the Write button is always present and routes correctly
  6. Claude response streaming uses `sendMessageDraft` — no rate-limit freezes or message flickering during long responses
**Plans**: TBD
**UI hint**: yes

### Phase 3: Forum Extraction
**Goal**: Forum Mode logic lives in a dedicated `TelegramBotForum` class with no shared state with Direct Mode
**Depends on**: Phase 2
**Requirements**: FORUM-01, FORUM-02, FORUM-03, FORUM-04
**Success Criteria** (what must be TRUE):
  1. `telegram-bot-forum.js` exists containing `TelegramBotForum` class; `telegram-bot.js` no longer contains inline forum logic (~860 lines removed)
  2. A message sent in a Forum Mode topic does not affect `ctx.state` for the same user's Direct Mode conversation (and vice versa)
  3. All existing Forum Mode supergroups receive messages in the correct topic after extraction — no messages land in General topic
  4. `threadId` is always passed as an explicit parameter to every forum API call; no class-level `this._currentThreadId` remains
**Plans**: TBD

### Phase 4: Server Encapsulation
**Goal**: `server.js` interacts with the bot only through a public API — no private method calls remain
**Depends on**: Phase 3
**Requirements**: ENC-01, ENC-02
**Success Criteria** (what must be TRUE):
  1. `TelegramBot` exposes `createResponseHandler({ userId, chatId, threadId })` and `server.js` uses it as the sole interface for all bot interactions
  2. A grep for `bot._` in `server.js` returns zero matches — no private method calls remain
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 0/TBD | Not started | - |
| 2. UX Redesign | 0/TBD | Not started | - |
| 3. Forum Extraction | 0/TBD | Not started | - |
| 4. Server Encapsulation | 0/TBD | Not started | - |
