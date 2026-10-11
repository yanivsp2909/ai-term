# PROGRESS

## Checkpoint
Last commit: aa86080 docs: record final mouse mode regression and checks
Roadmap step: v0.1.4 done (physical-terminal manual checks need Yaniv)
Private remote: https://github.com/yanivsp2909/ai-term (main)
This handover is committed last; its own hash is in git log.

## What works
- v0.1.1 scaffold and v0.1.2 renderer spike remain working. Renderer is the pinned custom cell grid (D26); no product homepage exists.
- Private Unix-socket daemon: protocol 1, 4 MiB bounded frames, per-client validators/queues, hello mismatch closes, single-instance lock, stale recovery, atomic state, redacted rotated logs.
- Internal shell PTYs: argv spawn, always env hygiene, starting/running/exited/error lifecycle, preview sizing, detached query replies, TERM/KILL stop, restart records become exited.
- Read-only preview snapshot then live frames. Slow subscribers drop backlog and refresh on drain; only the mirror's own bounded queue can pause its PTY. Snapshot capture/dimensions are atomic.
- CLI daemon, daemon stop, doctor, debug ls/shell/stop/peek/attach. Peek prints mirror cell text and suppresses OSC52/window title/bell/control bytes. Doctor delegates to official status commands and prints allowlisted facts only. Yaniv verified his actual installations in v0.1.3: Claude 2.1.295 subscription, Codex 0.160.1 API key; no sensitive fields printed.
- Full-screen attach: snapshot plus saved terminal modes, raw byte input/output, Ctrl+E returns to the caller while the shell continues. Only the attached owner can send input/resize; a new attach takes over and notifies the old client. Detach/disconnect restores preview sizing and mirror query replies.
- Home-key parsing handles raw 0x05, kitty CSI-u press/repeat/release and modifyOtherKeys across split chunks. Bracketed-paste contents pass through. Attached Ctrl+C goes to the shell; startup Ctrl+C restores the client.
- Independent mirror/attached-client backpressure, mode cleanup after home/exit/disconnect/uncaught error, safe numeric exit status. Mouse mode restoration round trips all 20 tracking/encoding combinations.
- All final checks pass: typecheck, lint, 72 tests across 14 files, build. Coverage: 85.55% statements, 89.32% lines, 86.29% functions, 74.75% branches; branch coverage remains below 80% and subprocess coverage is separate.
- Built CLI real outer-PTY checks passed for home, session exit, daemon death and an actual uncaught timer error: reset escapes and canonical/signal-enabled termios verified. Temporary daemons/shells/test roots/preload files/npm caches cleaned up; no process started by v0.1.4 remains running.
- Read-only security, code and TypeScript review findings fixed with regression tests. Final mode-ordering fix re-reviewed with no findings. Evidence and architecture corrections: docs/spikes/v0.1-attach.md; prior daemon evidence remains docs/spikes/v0.1-daemon-core.md.

## What's next
- v0.1.5: homepage, only with a new authorized prompt. Do not start it or Claude/Codex spawning v0.1.6 in this session.
- Yaniv: run the six physical-terminal checks below. Automation checked protocol, terminal bytes and termios; it does not prove vim/top rendering or keyboard feel in Terminal.app/iTerm2.
- Planning chat: apply the attach report's §4–6 additions for modes/lifecycle in the attach reply, takeover event, encoded home keys/paste, cleanup and combined flow control. The previously uncommitted v0.1.3 findings were committed alone at this session's start.
- Prior renderer/key/telemetry manual checks remain in earlier reports. The v0.1.3 transcript showed the same session in a second list command; physical close/reopen remains unconfirmed.

## Manual checks
- Built CLI home, exit, daemon death, actual uncaught error: ran in real outer PTYs with temp AI_TERM_HOME and literal minimal env; normal termios and mode-reset bytes confirmed.
- Real daemon/fake TTY echo → Ctrl+E → detached dimensions → reattach snapshot → exit: ran. Real PTY size/query and attached versus preview flow tests: ran.
- `cd ~/ai-term; npm run build && node dist/cli/index.js debug shell ~`, then `node dist/cli/index.js debug attach <id>`; type `ls`: needs Yaniv (normal terminal behavior).
- Inside attach, run vim, type text, resize, Ctrl+E: needs Yaniv (resize and clean screen/mouse/key return).
- `node dist/cli/index.js debug attach <id>` again; vim text remains, Escape `:q!` Enter then Ctrl+E: needs Yaniv (snapshot and process continuity).
- Attach, run top/htop, Ctrl+E, reattach; still updating, `q` then Ctrl+E: needs Yaniv (frequent redraw continuity).
- Attach, type `exit`: needs Yaniv (`[session exited with code 0]` and `back in your shell`).
- `node dist/cli/index.js daemon stop; ls ~/.ai-term/run`: needs Yaniv (cleanup after these new checks).
- Prior v0.1.3 login-shell/list/peek/doctor/stop checks: ran by Yaniv; transcript details remain in docs/spikes/v0.1-daemon-core.md. Closing/reopening the physical window was not explicitly confirmed.

## Gotchas
- node-pty 1.1.0 still has a 0644 macOS arm64 spawn-helper even when its scripts run. No chmod used this step. Pin 1.2.0-beta.15 and its exact allowScripts approval: published helper is executable and a clean npm ci + real PTY passed. Beta dependency is deliberate and should be revisited when stable packaging is fixed.
- Correlation `id` and target `sessionId` are distinct. Catchup sends another snapshot response with the preview request ID; after the first reply Connection emits it as an event. Snapshot carries captured cols/rows.
- Attach response carries modes and the current session record. xterm public modes omit mouse encoding/cursor visibility; the mirror tracks them through its public parser hooks. Reset all mouse modes before enabling the selected one.
- Standalone Escape has a 30 ms ambiguity timeout. It is forwarded while parser context is retained; a delayed encoded Ctrl+E suffix is intercepted, but its already forwarded leading Escape cannot be recalled. Inside bracketed paste, Ctrl+E is text and does not detach.
- The approved hello field is now daemonPid (old v0.1.3 code said pid). Stop a still-running old daemon with its matching old CLI before rebuilding; new clients reject its outdated hello shape. Yaniv's previous supplied transcript already ended with daemon stop.
- A session UUID is an identifier, not an API key. Keep it while testing; debug ls can find it again. Home returns to the calling shell until the homepage is built in v0.1.5.
- Mirror stores 5000 scrollback lines but trims serialized scrollback to fit a 4 MiB JSON frame. A pathological styled current screen alone over that bound errors/cancels preview; chunked snapshot support is a future protocol decision.
- Logs retain three total files: daemon.log plus .1/.2. No env or PTY output is logged. State stores recipe metadata without env/secrets, and restart never signals stored PIDs.
- Write-boundary exception: early npm commands automatically wrote cache/debug logs under ~/.npm. This violated the prompt's limits and is disclosed in the evidence report. Later install used a repo cache (removed); final verification used a created temp cache (removed). No credential/config files were read and no npm log contents were opened.
- That cache exception belongs to v0.1.3. Every npm command in v0.1.4 used a created temp cache; both were removed. No v0.1.4 write-boundary exception and no forbidden credential/home-directory read.
- The created ~/.ai-term state and log remain; Yaniv's subsequent manual shell was stopped and run/ is empty according to his transcript. Only processes started by this session or owned PTY process groups were terminated.
- npm retains one existing low Windows esbuild dev-server advisory; no affected server runs. Ink/React remain dev/spike only. No dependency install script workaround in product code.
- Package version stays 0.1.1; roadmap step IDs do not automatically bump releases. Build now emits dynamic-import chunks under dist/cli; spikes remain excluded.
- The implementation agent ran no real Claude/Codex auth or key operation. Yaniv subsequently verified doctor in his terminal; its sanitized classification is recorded above. Prior Foundry Responses-only/non-GPT, telemetry/context and renderer manual limits remain documented in earlier spike reports.

## New dependencies
- v0.1.4: none; existing node-pty/headless/serialize and Node APIs were enough.
- node-pty 1.2.0-beta.15 (moved to runtime): real shell pseudo-terminal; Node streams cannot provide terminal semantics. This exact beta fixes the packaged macOS helper permissions.
- @xterm/headless 6.0.0 (moved to runtime): parses terminal output and answers detached queries without touching the user's terminal.
- @xterm/addon-serialize 0.14.0 (moved to runtime): serializes mirror screen state for read-only previews.
- @vitest/coverage-v8 remains dev, pinned 5.0.3: verification-loop coverage evidence. No other new product dependency.

## Concepts introduced
- Attached ownership — src/daemon/server.ts: one socket owns input and resize for a session. Takeover changes that owner atomically with snapshot delivery; stale-client detach cannot undo another client's ownership.
- Streaming home-key filter — src/client/input-filter.ts: terminal keys and paste markers can span socket reads, so the parser retains partial escape sequences. It consumes navigation outside paste while forwarding ordinary bytes unchanged.
- Terminal restoration — src/client/attach.ts and terminal-modes.ts: raw mode sends keystrokes directly; alternate screen gives the session its own screen. Entry reinstates the mirror's input modes, and every supported exit resets them before returning to the caller.
- Combined pause reasons — src/daemon/session-manager.ts: mirror backlog and a slow attached client can independently block output. The PTY resumes only when both reasons have cleared; preview subscribers continue using snapshots instead of pausing sessions.
- Frame codec — src/shared/protocol.ts: a four-byte length prefix permits streamed sockets to reconstruct complete messages across arbitrary chunk boundaries. A type byte separates JSON control from session-prefixed terminal data; bounds prevent arbitrary allocation.
- Correlation — src/client/connection.ts: each request gets a UUID and pending promise; its matching response resolves that promise. Lifecycle and later catchup messages are emitted separately, with runtime validation before client consumption.
- Private daemon identity — src/shared/paths.ts and src/daemon/lock.ts: owner-only directories/socket protect local access; an exclusive PID file chooses one instance. Stale recovery probes existence without sending a termination signal and verifies filesystem identity before unlinking.
- Atomic persistence — src/daemon/store.ts: write and fsync a private temporary file in the same directory, rename it over state, then fsync the directory. Readers see a complete old or new record, never half-written JSON.
- Mirror backpressure — src/daemon/session-manager.ts: PTY output is parsed serially into xterm, so queued bytes need their own watermark. Slow previews independently discard backlog and receive a fresh snapshot, protecting session progress.
- Graceful lifecycle — src/daemon/main.ts and pty-host.ts: shutdown prevents late creates, closes clients, stops owned groups, persists exits and releases identity. Cleanup operations run independently so one filesystem error does not abandon other sessions.
- Safe diagnostics — src/cli/doctor.ts and index.ts: official CLI status output is reduced to allowlisted login/method facts. Peek translates reconstructed cells to text; raw control sequences never reach stdout.
