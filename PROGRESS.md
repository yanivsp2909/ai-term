# PROGRESS

## Checkpoint
Last commit: 2849af6 docs: record the This Mac gate range across runs
Roadmap step: v0.1.8a done (This Mac panel: machine CPU, RAM, network, plus per-agent CPU and RAM). v0.1.6 is still partial: its live checks need Yaniv.
Branch: main, started from 3fb93e3 (clean, 168 tests). This handover is committed last; its own hash is in git log.

## What works
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
- Yaniv runs the manual checks below. When the v0.1.6f ones pass, mark v0.1.6 done and go on to v0.1.7 (login/keys).
- v0.1.8b: usage and cost (D45). Not started.

## Manual checks
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
- **Branch coverage** is still below 80% (78.08%, up from 77.09%).

## New dependencies
- None.

## Concepts introduced
- **Subscribe-to-sample** (`src/daemon/server.ts`, `src/daemon/sysstats.ts`): the daemon measures the machine only while a homepage is looking. Each connection has a flag, and the sampler runs while any flag is set. Closing a connection clears its flag, so a crashed client can't leave sampling on.
- **Process-tree sums** (`sessionUsage`): an agent is a tree of processes (shell → claude → node → tools). ps lists each process with its parent, so the daemon walks down from each session's PTY child and adds up CPU and memory for the whole tree.
- **Counters vs. rates** (`cpuPercent`, `netRates`): the OS reports running totals (CPU ticks, bytes since boot). A rate is the difference between two samples divided by the time between them. That's why the first sample is only a baseline, and why a counter that goes backwards (reset) voids a sample instead of showing a negative speed.
