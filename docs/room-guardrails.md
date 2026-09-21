# Room guard rails and the planner

A conversation room (several bots, one chat) edits files in the project. Two things went wrong on a real run:
the writer bot rewrote the user's ТЗ (25.9 KB → 13.8 KB) with no copy left, and nobody thought to ask the bot
whose job it is to turn a ТЗ into tasks. What the room now does about it.

## A restore point

Before the discussion and again after it, the room commits the working directory (`room-git.js`, `ROOM_GIT=off`
disables it). So the state before the bots is one command away: `git checkout <commit> -- <file>`.

- Only in a repository the app manages: one whose root commit is the app's own "Initial commit (auto-created by Claude
  Code Studio)", or a `ccs/...` branch. A project you keep under your own history is never committed to behind your back.
- Planning mode reads only, so it commits nothing. A merge or rebase in progress is skipped. It never throws:
  a failed checkpoint costs the room nothing.
- The note under the room says what changed, with sizes (`25 KB → 13 KB`), and `📌 Saved in git: <sha>`.

## "Documents got much smaller"

A modified file that lost more than 20% (or a deleted one), when it was at least 2 KB, is listed with sizes and the
exact restore command using the commit from *before* the room. Where there is no such commit (a repo the app does not
manage) the note says so instead.

## What every bot is told

The real working directory (paths are relative to it, no made-up `/workspace/...`), read a file before changing it, do
not rewrite a document from scratch, do not shorten one unless asked.

## The planner

Bot `planner` turns an agreed ТЗ into tasks (see the bot's prompt). A message about a plan or tasks (`PLAN_INTENT_RE`:
план, задач, канбан, декомпоз, roadmap, backlog, plan, tasks…) always seats it, whatever the seating model chose, and
**last**: it reads the whole discussion, and the closing step (the last seat's) is then its work, the plan files. A
project without a `planner` bot, and a message that is not about a plan, are unaffected.
