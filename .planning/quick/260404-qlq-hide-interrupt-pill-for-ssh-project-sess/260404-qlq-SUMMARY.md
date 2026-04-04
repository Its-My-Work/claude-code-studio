---
phase: quick
plan: 260404-qlq
subsystem: ui
tags: [interrupt, ssh, remote-sessions]

provides:
  - SSH-aware interrupt pill visibility guard
  - SSH-aware interrupt send guard
affects: []

tech-stack:
  added: []
  patterns: [isRemote project check before UI feature toggle]

key-files:
  created: []
  modified: [public/index.html]

key-decisions:
  - "Dual guard approach: pill visibility in setSendStop() AND send path guard for defense-in-depth"

requirements-completed: []

duration: 1min
completed: 2026-04-04
---

# Quick Task 260404-qlq: Hide Interrupt Pill for SSH Project Sessions

**Dual guard preventing interrupt pill display and interrupt message sending for SSH remote project sessions**

## Performance

- **Duration:** 1 min
- **Started:** 2026-04-04T13:51:35Z
- **Completed:** 2026-04-04T13:52:21Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- setSendStop() now checks curProjectId's isRemote flag before showing the interrupt pill
- Interrupt send path at line ~7769 guarded with isRemote check to prevent WS interrupt messages for SSH sessions
- Stop button remains visible for all sessions regardless of remote status
- Local project sessions continue to show pill and send interrupts normally

## Task Commits

1. **Task 1: Guard interrupt pill visibility and send path for SSH sessions** - `4e78d0d` (fix)

## Files Created/Modified
- `public/index.html` - Added isRemote guards in setSendStop() and interrupt send path

## Decisions Made
- Dual guard approach: both pill visibility and send path are independently guarded. Even if pill state leaks (e.g., switching projects mid-generation), the interrupt WS message is never sent for SSH sessions.

## Deviations from Plan
None - plan executed exactly as written.

## Issues Encountered
None

## Next Phase Readiness
N/A - standalone quick task.

---
*Quick task: 260404-qlq*
*Completed: 2026-04-04*
