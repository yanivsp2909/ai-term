# PROGRESS

## Checkpoint
Last commit: 5d2b37d docs: record Yaniv daemon manual check results
Roadmap step: v0.1.3 done (physical terminal-window closure awaits Yaniv confirmation)
Private remote: https://github.com/yanivsp2909/ai-term (main)
This handover is committed last; its own hash is in git log.

## What works
- v0.1.1 scaffold and v0.1.2 renderer spike remain working. Renderer is the pinned custom cell grid (D26); no product homepage/attach exists.
- Private Unix-socket daemon: protocol 1, 4 MiB bounded frames, per-client validators/queues, hello mismatch closes, single-instance lock, stale recovery, atomic state, redacted rotated logs.
- Internal shell PTYs: argv spawn, always env hygiene, starting/running/exited/error lifecycle, preview sizing, detached query replies, TERM/KILL stop, restart records become exited.
- Read-only preview snapshot then live frames. Slow subscribers drop backlog and refresh on drain; only the mirror's own bounded queue can pause its PTY. Snapshot capture/dimensions are atomic.
- CLI daemon, daemon stop, doctor, debug ls/shell/stop/peek. Peek prints mirror cell text and suppresses OSC52/window title/bell/control bytes. Doctor delegates to official status commands and prints allowlisted facts only. Yaniv verified his actual installations: Claude 2.1.295 subscription, Codex 0.160.1 API key; no sensitive fields printed.
- All final checks pass: typecheck, lint, 46 tests across 10 files, build. Coverage: 84.31% statements, 87.07% lines, 87.75% functions, 73.27% branches; branch coverage is below 80% and subprocess coverage is separate.
- Built daemon manual run: ~/.ai-term and run 0700, socket/PID/state 0600, no TCP listener; daemon stop removed socket/PID. No daemon/session was left running.
- Read-only security, code and TypeScript reviewers' concrete findings fixed with regression tests. Full evidence and architecture corrections: docs/spikes/v0.1-daemon-core.md.

## What's next
- v0.1.4: attach, only with a new authorized prompt. Do not implement homepage v0.1.5 or Claude/Codex spawning v0.1.6 early.
- Yaniv's planning chat should apply the daemon report's architecture corrections: helper packaging, distinct correlation/target IDs, hello PID/snapshot response shape, mirror versus preview backpressure, snapshot bounds.
- Actual login-shell, peek, doctor and stop checks passed from Yaniv's supplied transcript. Confirm whether the window was physically closed between the two list commands. Prior renderer/key/telemetry manual checks in the earlier spike files still remain manual.

## Manual checks
- Private modes/no TCP listener/daemon stop empty run directory: ran with our own built daemon and literal minimal env, SHELL=/bin/sh.
- Real PTY lifecycle, exact cursor-position reply within 2 s, restart, slow preview, OSC52/title/bell suppression: ran in isolated tests.
- `npm run build && node dist/cli/index.js debug shell ~`, then `node dist/cli/index.js debug ls`: ran by Yaniv; returned UUID listed as running shell.
- Close terminal, open another, `cd ~/ai-term && node dist/cli/index.js debug ls`: second list ran and showed the same running UUID; physical close/reopen awaits Yaniv confirmation.
- `node dist/cli/index.js debug peek <UUID>`: ran by Yaniv; actual home-directory prompt printed as plain text with blank terminal rows.
- `node dist/cli/index.js doctor`: ran by Yaniv; Node v26.3.0, daemon protocol 1, directories 0700, Claude subscription and Codex API key. No emails/orgs/key hints printed.
- `node dist/cli/index.js daemon stop && ls ~/.ai-term/run`: ran by Yaniv; Daemon stopped, then no run-directory entries.

## Gotchas
- node-pty 1.1.0 still has a 0644 macOS arm64 spawn-helper even when its scripts run. No chmod used this step. Pin 1.2.0-beta.15 and its exact allowScripts approval: published helper is executable and a clean npm ci + real PTY passed. Beta dependency is deliberate and should be revisited when stable packaging is fixed.
- Correlation `id` and target `sessionId` are distinct. Catchup sends another snapshot response with the preview request ID; after the first reply Connection emits it as an event. Snapshot carries captured cols/rows.
- Mirror stores 5000 scrollback lines but trims serialized scrollback to fit a 4 MiB JSON frame. A pathological styled current screen alone over that bound errors/cancels preview; chunked snapshot support is a future protocol decision.
- Logs retain three total files: daemon.log plus .1/.2. No env or PTY output is logged. State stores recipe metadata without env/secrets, and restart never signals stored PIDs.
- Write-boundary exception: early npm commands automatically wrote cache/debug logs under ~/.npm. This violated the prompt's limits and is disclosed in the evidence report. Later install used a repo cache (removed); final verification used a created temp cache (removed). No credential/config files were read and no npm log contents were opened.
- The created ~/.ai-term state and log remain; Yaniv's subsequent manual shell was stopped and run/ is empty according to his transcript. Only processes started by this session or owned PTY process groups were terminated.
- npm retains one existing low Windows esbuild dev-server advisory; no affected server runs. Ink/React remain dev/spike only. No dependency install script workaround in product code.
- Package version stays 0.1.1; roadmap step IDs do not automatically bump releases. Build now emits dynamic-import chunks under dist/cli; spikes remain excluded.
- The implementation agent ran no real Claude/Codex auth or key operation. Yaniv subsequently verified doctor in his terminal; its sanitized classification is recorded above. Prior Foundry Responses-only/non-GPT, telemetry/context and renderer manual limits remain documented in earlier spike reports.

## New dependencies
- node-pty 1.2.0-beta.15 (moved to runtime): real shell pseudo-terminal; Node streams cannot provide terminal semantics. This exact beta fixes the packaged macOS helper permissions.
- @xterm/headless 6.0.0 (moved to runtime): parses terminal output and answers detached queries without touching the user's terminal.
- @xterm/addon-serialize 0.14.0 (moved to runtime): serializes mirror screen state for read-only previews.
- @vitest/coverage-v8 remains dev, pinned 5.0.3: verification-loop coverage evidence. No other new product dependency.

## Concepts introduced
- Frame codec — src/shared/protocol.ts: a four-byte length prefix permits streamed sockets to reconstruct complete messages across arbitrary chunk boundaries. A type byte separates JSON control from session-prefixed terminal data; bounds prevent arbitrary allocation.
- Correlation — src/client/connection.ts: each request gets a UUID and pending promise; its matching response resolves that promise. Lifecycle and later catchup messages are emitted separately, with runtime validation before client consumption.
- Private daemon identity — src/shared/paths.ts and src/daemon/lock.ts: owner-only directories/socket protect local access; an exclusive PID file chooses one instance. Stale recovery probes existence without sending a termination signal and verifies filesystem identity before unlinking.
- Atomic persistence — src/daemon/store.ts: write and fsync a private temporary file in the same directory, rename it over state, then fsync the directory. Readers see a complete old or new record, never half-written JSON.
- Mirror backpressure — src/daemon/session-manager.ts: PTY output is parsed serially into xterm, so queued bytes need their own watermark. Slow previews independently discard backlog and receive a fresh snapshot, protecting session progress.
- Graceful lifecycle — src/daemon/main.ts and pty-host.ts: shutdown prevents late creates, closes clients, stops owned groups, persists exits and releases identity. Cleanup operations run independently so one filesystem error does not abandon other sessions.
- Safe diagnostics — src/cli/doctor.ts and index.ts: official CLI status output is reduced to allowlisted login/method facts. Peek translates reconstructed cells to text; raw control sequences never reach stdout.
