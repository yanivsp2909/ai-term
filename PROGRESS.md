# PROGRESS

## Checkpoint
Last commit: 2c49103 docs: record D32 through D35 and Part A behavior
Roadmap step: v0.1.5f done
Branch: main. This handover is committed last; its own hash is in git log.

## What works
- Restart preserves finished session results and changes only starting/running records.
- Failed state/log writes never stop sessions; persistent homepage warning clears on writer recovery, state retries on next change.
- SIGTERM/SIGHUP quit homepage or attached client with 143/129 after cleanup; sessions keep running. SIGQUIT exits 131.
- Full reset on all attach exits: title, palette, default colors, cursor shape, alternate-scroll and existing modes.
- Baseline found c52a59d atop bbb7c8a; prior handover's branch reconciliation notes were stale.
- Required checks passed: typecheck tsc --noEmit; lint eslint .; 144 tests / 23 files; build success. Coverage: 85.8% statements, 75.67% branches, 85.29% functions, 91.42% lines.
- Security review and TDD evidence: docs/testing/v0.1.5f-followups.md.

## What's next
- v0.1.6 starting agents (Part B), only after this handover is pushed to origin/main.

## Manual checks
- Spawned client TERM/HUP from home and attach, daemon/session survival: ran (143/129; session running and socket responsive).
- Every attach exit reset bytes and detach, no stop: ran (eight paths).
- Warning display/color/sanitization and ENOSPC retry: ran (tests).
- Physical Terminal.app title/palette/cursor restoration: needs Yaniv. `cd ~/ai-term && npm run dev`, attach an isolated test session, then Ctrl+E; confirm terminal defaults restored.

## Gotchas
- Only processes and temporary homes created by this run were used; real ~/.ai-term was untouched.
- A3 harness initially failed before app startup; e7d2ddc corrects it and records valid RED before GREEN. Keep evidence commits.
- Socket trust is accepted same-user trust (D35), no token. Untrusted agents stay in Ask.
- Title reset uses empty/default; exact prior custom title is not saved.
- No concurrent reviewer agents; security review was direct to honor AGENTS.md.

## New dependencies
- None.

## Concepts introduced
- Writer recovery (src/daemon/session-manager.ts and log.ts): storage is secondary to a live PTY. Failure emits a warning; the next successful write clears only that writer's failure, so a recovered log cannot hide an unsaved state.
- Signal exit codes (src/client/signals.ts): conventional codes are 128 plus the signal number. A typed error carries that code through terminal cleanup to the CLI, without signalling sessions.
- Appearance reset (src/client/terminal-modes.ts): OSC resets restore terminal palette/default colors; DECSCUSR resets cursor shape. These affect the surrounding terminal, so leaving alternate screen alone is insufficient.
