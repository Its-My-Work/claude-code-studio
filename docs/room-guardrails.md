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

## One persona, several modes

The persona says who the bot is. Two things in it belong to a mode, and the app now owns both:

- **The closing report format** (`- Завершай так: ВЕРДИКТ / … / ДАЛЬШЕ: <имя>`). A discussion turn is not a deliverable: the line
  is left out of the system prompt there (`stripReportFormat`), so a bot no longer turns every reply into a five-part form or
  addresses itself with "ДАЛЬШЕ: <own name>". The room tells everyone to keep to about ten lines. The **closing step** is written
  work, so there the persona's report format stays (the planner's СОЗДАНО / ПОКРЫТИЕ / ВОПРОСЫ is exactly that).
- **What a bot may do to files in a room** (`bots.room_tools`, the "Files in a discussion" row of the bot editor):
  `read` (Read/Glob/Grep), `run` (+ Bash), `work` (+ Edit/Write). Unset = `work`, so nothing changes for a bot that was never
  configured. In a room several bots act on the same files and nobody is answerable for them; on a Kanban card or when you
  address a bot with `@@` there is one responsible actor, and it keeps full tools. Planning mode is read-only for everyone.

The closing step belongs to the last seated bot that may write (the planner speaks last when it is there). A room where nobody
may write says so ("None of the participants may write files, so the result stayed in the chat") instead of skipping silently.

The restriction is the tool list, so it is real on the API engine. On the Subscription engine the interactive CLI has no tool
list to restrict: there it is a request in the prompt, not a lock.

## The closer writes at the end (found on a live run)

On a live run with real models the planner, seated last, started writing its eleven-file package inside its discussion turn and
ran out of its 20 steps before it reported anything. Now the bot that will close the conversation (the last seated bot that may
write) is told: "In this turn do not change any file; give your contribution in about ten lines" and does the writing in the closing
step, which has **twice** the steps of a discussion turn. Other writers still edit files during the discussion, as before. With
the closing step off (`ROOM_CLOSING=off`), in planning mode, or on the Subscription engine nobody defers its writing.

Read-only and run-only bots, who have nowhere to put a long answer but the chat, are asked for the gist in about ten lines and
to say what the writer should put into the file.
