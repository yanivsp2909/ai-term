# PROGRESS

## Checkpoint
Last commit: c1c41b6 test: client-signals holds the PTY slave open so Linux can't drop the restore bytes at exit
Roadmap step: coverage chore plus B7 (the two flaky tests), not roadmap steps; both done. Last roadmap step is still v0.1.8a done; v0.1.6 is still partial (its live checks need Yaniv).
Branch: claude/coverage-chore-80-percent-lmfy2c, started from 7bf527a. This handover is committed last; its own hash is in git log.

## What works
- **B7, flaky tests (cloud session, Linux):** both had a real product race behind them; client-signals also had two test-side problems.
  - **homepage-settings "resizing detached sessions…":** product. node-pty closes the PTY fd when the child hangs up but reports the exit later; a resize in between threw `ioctl(2) failed, EBADF` out of `previewSize` (and attach, detach, resize). Test d26b8fb (red), fix abfea66 in `src/daemon/pty-host.ts`: that one error is a no-op, any other resize error still throws. The scenario under CPU load failed 4/200 before, 0/400 after.
  - **client-signals SIGTERM "exit 0":** product. Leaving a session, attach drops its signal listeners and awaits the detach reply before the homepage takes them back; with no listener Node restores the default action and SIGTERM/SIGHUP killed the client (node-pty shows exitCode 0, signal 15). Test 0c77a21 (red, deterministic: holds the daemon's detach reply), fix 5094d0b in `src/client/tui/homepage.ts`: guard listeners for SIGTERM/SIGHUP/SIGQUIT live as long as the homepage, keep a signal nobody else heard, and the homepage quits with its code when attach returns.
  - **client-signals test side:** it waited for `SESSION_READY`, which the homepage preview also draws, so it could kill during the hand-off instead of while attached (cc04414: waits for the daemon's 130x45 attach resize instead). Linux also drops unread PTY output when the child hangs up, so the restore bytes could vanish (c1c41b6: the test holds the slave open).
  - Under 8 CPU hogs the test file failed 3/25 before (1 exit 0, 1 missing restore bytes, 1 timeout), 0/25 after. Full suite: 2/15 runs had an extra flaky failure before, 0/15 after (only the two Linux-environment failures remain).
  - SIGTERM before the homepage first draws kills `ai` by the signal itself (shell `$?` 143, terminal untouched because nothing was changed yet). That is the normal outcome, not a bug.
- **Coverage chore (cloud session, Linux):** 128 new tests, 192 → 320 (1 todo). Coverage on Linux, before → after: statements 86.19 → 88.9, branches 78.21 → 82.3, functions 86.93 → 88.0, lines 92.34 → 94.26.
  - `tests/server-rejections.test.ts` (ebfcb89): invalid requests echo only a string id; output frames and bad lengths close the client; input before hello is dropped; switching attach detaches the first session; a disconnect during a queued attach leaves the session detached; warnings after hello and list; only known error messages pass through; failed preview refresh clears the preview; a client that stops reading is dropped at the queue cap; listen refuses a non-socket path and a live socket; socketAnswers rethrows ENOTDIR.
  - `tests/session-manager-lifecycle.test.ts` (c9ab2aa): bad state files are refused and left untouched; every operation on an unknown id; bad titles and sizes; agent preflight errors (not installed, not logged in, status unknown) leave no record and spawn nothing; default agent titles and authMethod; spawn failure becomes a saved error record; a failing mirror emits fatal; sampler roots and active count; attach during shutdown; detach and resize from a non-owner; warning dedup and two-source clearing.
  - `tests/store-settings.test.ts` (276e7b8): directory and oversized state/settings refused; loose files tightened to 0600 on read; failed serialize and failed rename leave no temp file; a symlink at the target is replaced, never written through; a failed settings write doesn't block the next one.
  - `tests/validate-rejections.test.ts` and `tests/protocol.test.ts` (b1be597): every validator rejection branch, each asserting its own message; frame encode limit, non-control decode, unknown types, data frames without a UUID.
  - `tests/sysstats.test.ts` (3563e1d): sampler failure reasons logged in fixed words only; unreadable netstat/vm_stat restarts the baseline; counter reset skips one event; a late failure after stop isn't logged; ps parent loops end; runCommand and defaultSamplerDeps.
- **Checks (Linux):** build success; typecheck exit 0; lint exit 0, no output; tests 320: 317 passed, 1 todo, 2 failed (both Linux/root-only, listed in Gotchas).
- **Contract:** `system.subscribe {on}` → `{ok}` and the event `system.stats {stats}`, numbers only (`src/shared/protocol.ts`, eb61fd1).
  - `stats` = `{cpuPercent, memUsedBytes, memTotalBytes, netRxBytesPerSec, netTxBytesPerSec, sessions: [{sessionId, cpuPercent, rssBytes}]}`.
  - `validateSystemStats` accepts exact keys only. The daemon checks every sample with it before sending, and the homepage checks every event on arrival.
- **Sampler (`src/daemon/sysstats.ts`, 192a2a1):**
  - Every 2 s, only while at least one client is subscribed. It stops on the last unsubscribe or disconnect.
  - Three commands, run with `execFile`: absolute paths, argv arrays, 2 s timeout, 1 MiB output cap.
  - Per session: `ps` process tree, PTY child plus all descendants, as a share of the whole machine.
  - Machine CPU from `os.cpus()` deltas.
  - RAM from `vm_stat` (active + wired + compressor) out of `os.totalmem()`.
  - Network from `netstat -ibn` link-row deltas (non-loopback, never negative).
  - Pure parsers with tests on recorded output, including malformed lines and a ps line carrying a command line.
- **Daemon wiring (e02bd33):** per-peer subscription flag; events go only to subscribed peers; `SessionManager.sessionRoots()` gives the live PTY pids.
- **Homepage (044e066):**
  - This Mac, exactly per design.md: `CPU 31% ▃▃▄▅▆▇▇██▃  agents 19%`, `RAM 14.2/32 GB  agents 2.3 GB`, `NET ↓ 1.4 MB/s  ↑ 0.2 MB/s`. The client keeps 10 samples for the sparkline.
  - Per-agent usage `cpu 4% · 310 MB` (ink-3) sits at the right of the selected agent's preview header. design.md is silent on where, so this is the choice; it's recorded in design.md. Cards are unchanged.
  - Subscribes on open; unsubscribes before attach and on quit; resubscribes on return.
  - Redraws only when a sample arrives.
- **Review fixes (08b7046):**
  - A sample still running when sampling stops leaves no baseline.
  - `server.close()` can't restart sampling.
  - Numbers clear on unsubscribe, so no stale values show after attach.
  - A failed subscribe shows a note instead of closing the homepage.
  - Quit doesn't await the unsubscribe.
- **Performance gate:** own daemon from `dist`, temp home under /tmp, 3 live shell sessions.
  - Subscribed for 60 s: 0.32% of one core on the final code. Earlier runs gave 0.13% and 0.18%. The gate is under 1%.
  - No subscriber for 30 s: kqueue `NOTE_FORK` on the daemon pid counted 0 spawns. While subscribed it counted 87 per 60 s (29 samples × 3 commands), which shows the detector works.
- **Security checks:**
  - The only new spawn is `src/daemon/sysstats.ts:118`: `execFile`, absolute path from `SAMPLE_COMMANDS`, argv array. There are no `exec(`, `execSync(` or `shell: true` in `src`.
  - Fake ps output with a command line never reaches events, logs or responses (unit and server tests). Real ps against a live `sleep` session never shows "sleep".
  - `system.subscribe` is validated (non-boolean, missing or extra fields are rejected).
- **Checks:** build success; typecheck exit 0; lint "No issues found"; tests 34 files, 192 passed. Coverage: statements 86.16%, branches 78.08%, functions 87.15%, lines 92.28%.

## What's next
- Decide on the todo in `tests/server-rejections.test.ts`: Node's pipe server unlinks its bound path on `close()` whatever is there, so `DaemonServer.close()`'s inode check can't spare a replaced socket path. A fix would bind to a unique temp name and rename it to `daemon.sock` (touches S1 startup). Low impact: the lock stops a second daemon from replacing it.
- Re-run `npm test -- --coverage` on the Mac to confirm branches stay ≥ 80% there (the Linux-failing Mac tests cover a few extra branches, so the Mac number should be a little higher).
- Yaniv runs the manual checks below. When the v0.1.6f ones pass, mark v0.1.6 done and go on to v0.1.7 (login/keys).
- v0.1.8b: usage and cost (D45). Not started.

## Manual checks
- B7: `kill -TERM <ai pid>` right after Ctrl+E from a session returns to your shell with `$?` 143 and a clean terminal: needs Yaniv (optional; the red/green test covers it headlessly).
- Coverage chore: none needed (tests only). Optional: `npm test -- --coverage` on the Mac to see the Mac numbers: needs Yaniv.
- This Mac numbers move with a busy shell session, temp `AI_TERM_HOME` (commands in the final report of this session): needs Yaniv.
- Performance gate and no-subscriber spawn count: ran (numbers above).
- Carried from v0.1.6g, all need Yaniv:
  - emoji line in a session preview lines up
  - B4: after Ctrl+E from Claude Code, switching dark/light sends nothing into the shell
- Carried from v0.2.1b, all need Yaniv: bar feel test; htop; kitty keyboard in Ghostty/iTerm2; real-terminal emoji widths.
- Carried from v0.1.6f, all need Yaniv (commands in `docs/testing/v0.1.6f-fixes.md`):
  - Codex account reply with no Azure error
  - Codex `/status` shows on-request + workspace-write
  - Claude Ask mode and its `ok` reply
  - S6 names-only env check
  - optional: Don't ask unchanged
  - title, palette and cursor after Ctrl+E and `/exit`

## Gotchas
- **Running the suite on Linux (cloud sessions):** two tests fail for platform reasons, not code:
  - `daemon-core` "recovers a stale lock whose PID now belongs to a process that started after the lock was written": the container runs as root, so `kill(1, 0)` succeeds instead of EPERM and the lock is (correctly) kept.
  - `system-stats` "real ps, vm_stat and netstat on this Mac": `/usr/bin/vm_stat` and `/usr/sbin/netstat` don't exist on Linux.
  - The two flaky tests from the coverage chore are fixed (B7). `homepage-terminal` "source CLI opens homepage…" failed once in 15 runs before B7 and not in 15 after; not investigated.
- **vitest prints no coverage table when a test fails;** add `--coverage.reportOnFailure`.
- **Node unlinks a Unix socket's path on `server.close()`,** whatever file is there by then (libuv `uv__pipe_close`).
- **Linux drops unread PTY output when the child hangs up** (3/60 under load, even waiting after exit). A test that checks a child's last bytes must hold the slave open (`ptsName`, an untyped node-pty getter).
- **node-pty closes the fd before it reports the exit.** Anything that touches `pty` after a hang-up can get EBADF until onExit runs.
- **Removing a signal's last listener restores its default action.** Hand signals over by adding the new listener before removing the old one, or keep a guard installed. `ai debug attach` (attach without the homepage) still has the old gap while it awaits the detach reply; the terminal is already restored by then.
- **A paused client socket never sees its own close.** To test that the daemon dropped a client, watch `server.clientCount()`.
- **ps `%cpu` is a decaying average,** not an instant value, so per-agent and "agents" CPU lag a few seconds. They can briefly disagree with machine CPU, which comes from `os.cpus()` deltas.
- **Network counts every non-loopback interface,** so VPN traffic is counted twice (on `utun*` and on the physical interface).
- **The first event comes about 2 s after subscribing:** the first sample is only a baseline. The panel shows `—` until then, including after returning from a session.
- **A running daemon keeps its old code.** Test This Mac with a temp `AI_TERM_HOME`, or restart the daemon.
- **Interactive shells ignore SIGTERM.** Stopping a daemon with live shell sessions takes about 3 s (SIGKILL after the timeout), so test scripts must wait for it.
- **A 25 ms `ps` poller can't see sampler children:** each one exits in a few ms. kqueue `NOTE_FORK` on the daemon pid is exact and needs no root (python3 `select.kqueue`).
- **ESLint bans any `.exec` property,** including `RegExp.exec`. Use `String.match`.
- **Earlier gotchas still apply:**
  - The Bash tool runs zsh (no `timeout`).
  - Always filter `codex login status`.
  - Claude's `--permission-mode=default` alias.
  - Never script Enter into Codex or Claude.
  - Unicode 11 isn't grapheme-aware: skin tones, ZWJ families and flags count per code point.
- **Branch coverage** reached 82.3% on Linux in the coverage chore (was 78.08% on the Mac).

## New dependencies
- None.

## Concepts introduced
- **Signal disposition** (`src/client/tui/homepage.ts`, guards): each signal has a default action (SIGTERM: die). `process.on('SIGTERM')` replaces it with "call my listeners"; removing the last listener puts the default back. So two parts of a program that hand a signal to each other must never both be unsubscribed at once, even for one `await`.
- **Hang-up vs. exit** (`src/daemon/pty-host.ts`): a PTY child's end shows up twice, as a hang-up on the terminal (the fd stops working) and as the process exit (waitpid). node-pty sees the hang-up first and reports the exit a moment later, so code that only checks "has it exited?" can still hit a dead fd.
- **Branch coverage** (`npm test -- --coverage`): counts each way a decision can go (both sides of an `if`, each `||` operand, each `case`) and how many were run by a test. It finds untested error paths that line coverage hides, because a one-line `if (bad) throw` counts as a covered line even if `bad` was never true.
- **Asserting the message, not just the throw** (`tests/validate-rejections.test.ts`): a validator with ten checks rejects a bad value at the first check that fails. A test that only says "throws" passes even if the check it meant to test is broken, so each case names the message it expects.
- **Subscribe-to-sample** (`src/daemon/server.ts`, `src/daemon/sysstats.ts`): the daemon measures the machine only while a homepage is looking. Each connection has a flag, and the sampler runs while any flag is set. Closing a connection clears its flag, so a crashed client can't leave sampling on.
- **Process-tree sums** (`sessionUsage`): an agent is a tree of processes (shell → claude → node → tools). ps lists each process with its parent, so the daemon walks down from each session's PTY child and adds up CPU and memory for the whole tree.
- **Counters vs. rates** (`cpuPercent`, `netRates`): the OS reports running totals (CPU ticks, bytes since boot). A rate is the difference between two samples divided by the time between them. That's why the first sample is only a baseline, and why a counter that goes backwards (reset) voids a sample instead of showing a negative speed.
