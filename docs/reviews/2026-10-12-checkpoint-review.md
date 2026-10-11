# v0.1.5r checkpoint review (before v0.1.6)

Reviewed: `main` at `609d23b` (v0.1.1–v0.1.5, all built by Codex). Reviewer: Claude Code (Opus 5.5), unattended night run, 2026-10-11/12.

Method:
- Read AGENTS.md, PROGRESS.md, `docs/architecture.md` (§11 rule set), `docs/design.md`, `docs/spikes/*`, `docs/testing/*`, and all of `src/` myself.
- Three read-only reviewers ran in parallel:
  - `security-reviewer`: the §11 rules, ownership and input routing.
  - `security-bounty-hunter`: the attack list in the prompt, each one actually run, with daemons in temporary homes.
  - `code-reviewer`: correctness, swallowed errors, leaks, and v0.1.6 traps.
- I checked every reported finding against the code before accepting it, and re-ran the repros for each fix.
- `silent-failure-hunter` was not run; it is reserved for v0.1.9.

**Result:** 0 Critical, 0 High, 7 Medium fixed, 3 Medium written up as questions, 21 Low listed (some rows group related items).

Every fix is a pair of commits on branch `review/v0.1.5r-checkpoint`: a failing test (RED), then the fix (GREEN).

**Branch note:** Yaniv's setup commit `fd79920` ("Add review agents, skills and commands for cloud sessions") landed on local `main` between my commits, during the run. I was told not to push it, and I may not rewrite history. So the review commits were cherry-picked unchanged onto a clean branch, `review/v0.1.5r-checkpoint`, which starts at `609d23b` and has no `fd79920`. That branch is what was pushed.

Local `main` still holds `fd79920` and the original copies of the review commits. Their tree for `src/` and `tests/` matches the branch, apart from the last fix and the docs.

## Findings

Lines refer to `609d23b` unless a fix moved them.

### Fixed (Medium)

| id | sev | area | file:line | what's wrong | how it was proved | status |
|---|---|---|---|---|---|---|
| M1 | Medium | homepage / size rule | `src/client/tui/homepage.ts:206`, `layout.ts:11` | The homepage reports its preview area even when no preview is drawn: 38×6 at 80×24 (compact) and 2×1 below 60×16 (tiny). Every detached session and its mirror are resized to that. The xterm reflow at 2 columns overflows the 5,000-line scrollback, so history is lost for good (a probe kept 142 of 1,000 lines). v0.1.6 agents would redraw at 38×6. | RED: homepage fixture at 80×24 and 50×12 sends `layout.previewSize`. | fixed `59f7bff` (RED), `c8b3685` (GREEN): size is reported only while a preview is visible, and again when `p` shows it |
| M2 | Medium | session lifecycle | `src/daemon/session-manager.ts:90-95` | node-pty reports `exitCode 0` plus `signal` for a killed child, so a crashed or OOM-killed session showed `exited · exit 0`. That contradicts §5 (non-zero → error). | Probe: `kill -SEGV $$` gives `{exitCode:0, signal:11}`. RED test: status `exited`. | fixed `a851912`, `13c0258`: an unrequested signal death is `error`, `signal N`, exitCode null. A user stop still ends as `exited`. |
| M3 | Medium | daemon startup | `src/daemon/lock.ts:19-30` | A stale `run/daemon.pid` whose number now belongs to another live process blocks the daemon forever. That happens after a crash plus reboot: our own pid gives "already running", a root pid gives EPERM "alive or inaccessible". `ai` then shows only "Daemon did not start within 3 s" until the file is deleted by hand. | Repro: lock holding PID 1, and one holding a live PID with an old mtime, are both refused. RED test. | fixed `67f133d`, `67af744`: EPERM (foreign user) is stale. Otherwise `/bin/ps -o etime=` via `execFile`: a holder that started more than 2 s after the lock was written is stale. `acquireLock` is now async. |
| M4 | Medium | copy / clipboard | `src/client/tui/homepage.ts:283-288` | A plain click in the preview (press and release on one cell) copied that cell, or `""`, to the Mac clipboard and flashed "✓ copied 1 lines". Clicking the preview destroyed whatever the user had copied. | Homepage fixture: `\e[<0;41;4M\e[<0;41;4m` called copy. RED test. | fixed `3fa8cf2`, `afce941`: copy only after the pointer moved; a click clears the highlight. |
| M5 | Medium | spawning | `src/daemon/main.ts:7`, `src/daemon/pty-host.ts:13` | The daemon sets umask 077 for its private files, and every PTY child inherited it. Files created in an AI Term session were 0600/0700, unlike Terminal.app. Claude Code and Codex would write owner-only files in v0.1.6. | `sh -c umask` in a session printed `0077`. RED test. | fixed `07102d3`, `1414f58`: `main.ts` keeps the user's umask and `PtyHost` spawns under it. Re-checked on a real daemon: the session prints `UMASK=0022`, while `~/.ai-term`, `run/`, `state.json` and `daemon.log` stay 0700/0600. |
| M6 | Medium | protocol / availability | `src/daemon/server.ts:80-83` vs `src/daemon/mirror.ts:35` | Snapshots may fill a 4 MiB frame, but `control()` destroyed any client with more than 2 MiB queued. The event right after a >2 MiB attach or preview snapshot (`session.previewResized`) disconnected the client, silently. One verbose session (a per-cell truecolor scrollback is enough) made `ai` exit at startup and the session could never be opened. Only a daemon restart helped, and that kills every agent. | Hunter: 1,200 coloured lines (2.28 MB snapshot) give "Daemon connection closed"; 600 lines are fine. RED integration test. | fixed `0e38f42`, `a638bdb`: the cap is one full frame plus 2 MiB. Re-ran the hunter's real-homepage repro: `ai` stays up and Enter attaches. |
| M7 | Medium | flow control / memory | `src/daemon/mirror.ts:24-25`, `session-manager.ts:67` | With nobody attached, every reply the mirror generates is written to the PTY, and node-pty queues writes without limit. A session that floods `\e[6n` and never reads stdin grew the daemon to 995 MB RSS in 20 s and kept climbing. A detached `cat` of a hostile file is enough. | Hunter RSS run. RED test: 120,000 bytes of replies queued for 20,000 queries. | fixed `7a4f4b1`, `c44e16c`: per-session reply budget (16 KiB burst, 4 KiB/s, `src/daemon/reply-budget.ts`); excess is dropped and logged once per burst. Same flood re-run: 157 MB after 25 s. The remaining ~1 MB/s is the 100 MB flood still being parsed. |

### Questions (Medium, need a decision; not changed)

| id | sev | area | file:line | what's wrong | how it was proved | status |
|---|---|---|---|---|---|---|
| Q1 | Medium | socket trust model | `src/daemon/server.ts` accept, `src/shared/validate.ts:56-60` | Any process running as the same user can `hello`, then `sessions.create`, `attach`, and send input to any session. Once v0.1.6 runs agents in session PTYs, a prompt-injected agent (Claude Code without a sandbox) could connect to the fixed socket path. From there it could start an unsandboxed shell or type into another session, for example a Don't-ask one, bypassing S10 and Codex's sandbox. | Traced; not run end to end. | **question Q1** |
| Q2 | Medium | restart | `src/daemon/session-manager.ts:38` | On load, every record becomes `exited · background service restarted` with `exitCode: null`, including sessions that had already finished. A session that failed with `exit 3` shows as a normal exit after any daemon restart. An existing test (`marks old records exited on restart…`) encodes today's behavior. | Probe: a stored `{status:'error', exitCode:3}` loads as `exited`, null. | **question Q2** |
| Q3 | Medium | resilience | `session-manager.ts:55`, `server.ts:122`, `main.ts:38`, `log.ts:27-45` | A recoverable I/O error stops every agent. A failed `state.json` write (for example ENOSPC) or a failed disconnect-detach emits `fatal`, and `runDaemon` then shuts down and SIGTERMs all sessions. `Logger.write` throws synchronously inside event handlers (for example the socket `error` handler), and the daemon has no `uncaughtException` handler, so a log write failure crashes it outright. Fail-visibly was a deliberate v0.1.3 choice, but in v0.1.6 it means a full disk ends every agent. | Traced; RED test proposed: make `atomicWrite` reject once and expect the session to survive. | **question Q3** |

### Listed (Low)

| id | sev | area | file:line | what's wrong | how it was proved | status |
|---|---|---|---|---|---|---|
| L1 | Low (v0.1.6) | data model | `session-manager.ts:35,53`, `validate.ts:132-138`, `protocol.ts:9-26,42-46` | Shell-only shapes everywhere:<br>• `load()` throws on any non-`shell` record, so the daemon won't start.<br>• `validateSession` hard-codes `auth.kind==='account'`, `permission==='ask'` and `ctxPercent===null`. One don't-ask or keyed session in a list kills the client connection.<br>• `persist()` writes a fixed shell recipe.<br>• `create()` takes only `{cwd,title}` and the recipe is a constructor singleton.<br>The code-reviewer rated this High; it is not reachable today. | probes | listed: v0.1.6 must widen protocol, validator, loader and recipe first |
| L2 | Low (v0.1.6) | env | `src/daemon/env.ts:2-12`, `session-manager.ts:26` | `buildShellEnv` copies the whole daemon env, including any exported `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (fine for the debug shell), and is computed once per manager. The daemon env also carries the first launcher's `TMUX`, `TERM_SESSION_ID`, `ITERM_SESSION_ID`, `PWD`, and npm's `node_modules/.bin` in `PATH` when started via `npm run dev`. | read | listed: `buildSpawnEnv` must be fresh per session, never reuse `recipe.env`, and `resolveExecutable` must walk the PATH the child gets |
| L3 | Low | errors to user | `session-manager.ts:101-105`, `server.ts:260` | A spawn failure shows a fixed `spawn failed`, and every operation error reaches the client as `Session operation failed`, including §5's "snapshot too large". §7.2 wants "claude not found in PATH". | read | listed |
| L4 | Low (v0.2) | idle exit | `session-manager.ts:50`, `main.ts:46` | `activeCount` counts only starting/running. Once v0.2 adds waiting/done/idle, an agent waiting on a prompt with no client open would be stopped after 10 min. | read | listed |
| L5 | Low | stop | `pty-host.ts:43-45` | If the leader dies on SIGTERM, the SIGKILL escalation is skipped, so group members ignoring TERM and HUP survive. The await after SIGKILL is unbounded. zsh ignores TERM, so stopping a shell always takes 3 s. | probe: survivor; `stop()` returned in 10 ms | listed |
| L6 | Low (v0.1.6) | settings | `validate.ts:125`, `settings.ts:27`, `server.ts:87` | Settings must be exactly `{theme}`, `set` replaces the whole file, and `listen()` refuses to start on any unknown key. v0.1.6 defaults (`/model`, `/cd`) need merge semantics. | read | listed |
| L7 | Low | snapshot cost | `mirror.ts:33-43` | 6,000 styled lines at 200 columns take about 393 ms of synchronous serialize on the daemon loop, on every preview switch, attach and catch-up. The halving search keeps 675 lines where about 1,000 fit. | probe | listed |
| L8 | Low | preview ordering | `server.ts:148-164`, `:123-125` | A drain-triggered catch-up refresh for S1 that finishes after the client switched to S2 clears `peer.refreshing` in its `finally`. S2's live output can then pass before S2's snapshot, and the preview shows that text twice. | hunter stub-manager repro (`refresh-race.mts`) | listed |
| L9 | Low | terminal restore | `client/terminal-modes.ts:3`, `attach.ts:75`, `homepage.ts:86` | After any exit, an attached agent's window title, OSC 4/10/11 colors, cursor shape (DECSCUSR) and `?1007` stay changed. SIGHUP or SIGQUIT while attached skip the reset entirely (alt screen, mouse, paste and focus stay on). SIGTERM while attached returns home instead of quitting. | hunter PTY run (`modes.mts`) | listed (doc line corrected in `docs/architecture.md` §6) |
| L10 | Low | debug log | `attach.ts:39,103` | With `AI_TERM_DEBUG=1`, `ai debug attach` logs the first 64 input bytes as hex, type-ahead included. `export ANTHROPIC_API_KEY=sk-…` decodes back exactly, and `redact()` can't see hex. Opt-in, in a 0600 log. | hunter canary repro | listed |
| L11 | Low | titles | `validate.ts:15-17` | `isTitle` accepts whitespace-only, NBSP, U+2028/2029 and a lone U+FE0F, so a card can look blank. Controls, bidi and zero-width are correctly refused. | `isTitle('   ') === true` | listed |
| L12 | Low | logs | `connection.ts:112`, `main.ts` | Daemon stdout/stderr go straight into `daemon.log`, so a raw stack trace bypasses `redact()`. There is no `uncaughtException` handler. This matters from v0.1.7, when keys exist. | read | listed |
| L13 | Low | state loader | `session-manager.ts:35` | The loader is looser than the client's `validateSession`: a relative `cwd` or a bad `createdAt` loads, then breaks the homepage. One malformed record stops the daemon from starting, and a 16 MiB state file can hold about 140k records, each with a mirror (10k records = 2.4 GB). | probes | listed |
| L14 | Low | FIFO in ~/.ai-term | `settings.ts:15`, `store.ts:37`, `connection.ts:105` | `open()` happens before the regular-file check and without `O_NONBLOCK`. A FIFO at `settings.json` or `state.json` hangs the daemon while it holds the lock; one at `daemon.log` hangs the client. Same-user only. | hunter `fifo.mts` | listed |
| L15 | Low | lock | `lock.ts:16-17` | An empty lock file (crash between create and write) is refused forever ("Invalid daemon PID"). | hunter | listed |
| L16 | Low | startup window | `main.ts:28` | Shutdown unlinks the socket first, stops sessions for up to 3 s, then releases the lock. A client starting in that window spawns a daemon that loses the lock, and the client reports "did not start within 3 s". | read | listed |
| L17 | Low | startup errors | `connection.ts:113` | The client doesn't watch the spawned daemon's exit, so any startup failure costs the full 3 s and shows a generic message. Examples: an `AI_TERM_HOME` whose socket path is over 104 bytes (`listen EINVAL`), or the lock cases above. | ran: long path gives EINVAL only in `daemon.log` | listed |
| L18 | Low | pre-hello | `server.ts:119`, `protocol.ts:155` | The 5 s hello timeout is an inactivity timeout, so a byte every few seconds keeps a non-hello client forever. The decoder pre-allocates up to 4 MiB from a header alone. Same-user only. | hunter trickle: still open after 12 s | listed |
| L19 | Low | remove race | `session-manager.ts:116` | A snapshot queued behind `remove()` runs on a disposed mirror. xterm prints a "disposable leaked" warning; there is no crash. | ran | listed |
| L20 | Low | platform | `session-manager.ts:26`, `lock.ts` | Defaults to `/bin/zsh -l` (debug shell only), and uses `/bin/ps`. | read | listed |
| L21 | Low | env | `env.ts:5` | `/^npm_/i` also strips `NPM_TOKEN` and similar (case-insensitive). The spec says `npm_*`. A shell that needs `NPM_TOKEN` to publish won't have it. | read | listed |

## Attack attempts that held

- **Frames (S2):**
  - 20,000 random split and coalesced inputs gave only `ProtocolError`s.
  - Zero length, over 4 MiB, a lying length, an unknown type byte, and a missing or bad session id are all rejected, and the connection closes without spinning or log flooding.
  - Client→daemon output frames (type 2) are refused.
  - Queues are capped at 128 requests / 8 MiB.
  - `validateRequest` allowlists fields per kind (`__proto__` and extras are rejected).
  - Sizes are bounded at 2–1000 × 1–500. The daemon never crashed.
- **Ownership and input routing:**
  - Input from the old owner after a takeover, from a never-attached client, from a preview subscriber, or sent before hello was dropped, and logged without its content.
  - A stale resize is rejected and a stale detach is ignored (`owned()` is re-checked inside the session queue). The old owner gets `session.detached`.
  - The homepage's connection type has no `input()`; only `attach.ts` sends input, and type-ahead before the attach reply is dropped.
- **Races:**
  - Attaching while the session exits ended as "session exited" in 10/10 runs.
  - A disconnect mid-attach left 0/12 sessions stuck attached.
  - Remove during attach: the queued attach sees the session is gone.
  - Two daemons starting at once gave exactly one daemon in 8/8 runs.
  - A stale pid plus a stale socket after SIGKILL recovered on its own.
- **S1:**
  - `~/.ai-term`, `run/` and `logs/` are 0700, and a symlinked, non-directory or foreign-uid directory is refused before `chmod`.
  - The socket is bound under umask 0177 and verified 0600; the client refuses a socket that isn't 0600, isn't ours, or isn't a socket.
  - Stale-socket handling probes, then re-checks the inode before unlinking.
  - Symlinked `settings.json`, `state.json`, `daemon.log` and `run/` are all refused (O_NOFOLLOW; the lock and temp files also use O_EXCL).
- **S5:** `redact()` covers `sk-…`, KEY/TOKEN/SECRET/PASSWORD assignments (quoted JSON too) and bearer tokens, and strips control characters. Nothing logs `process.env` or a spawn env.
- **S8:** no `exec`, `execSync`, `shell:true` or string commands. Every spawn uses an argv array: `execFile('/usr/bin/pbcopy', [])`, doctor's `execFile`, `spawn(execPath, [...])`, `pty.spawn(exe, args)`, and the new `execFile('/bin/ps', [...])`. ESLint blocks `exec`/`execSync`.
- **S9:** cwd must be absolute, free of NUL, ≤ 4096 bytes and an existing directory, checked in both validator and manager; EACCES becomes an error response.
- **S11:** no reference to `.claude`, `.codex`, `auth.json`, `.credentials.json` or the keychain in `src/`. Doctor runs only the CLIs' own status commands and prints allowlisted fields.
- **S15 (background bytes):** in a real PTY run, none of the following from a background session reached the homepage output: OSC 52, OSC 0, OSC 8, OSC 1337, BEL, DCS, APC, C1 (UTF-8 and raw 0x9b), CSI 21t, RLO. Every rendered character passes `safeText` (Cc/Cf/Cs stripped). The client preview's xterm has no reply path. `debug peek` strips `\p{C}`.
- **Titles and names:** `isTitle` rejects C0, C1, bidi overrides, zero-width characters, surrogates, private use and tag characters. A cwd containing ESC or OSC 52 renders harmlessly. Nothing in AI Term writes the window title.
- **Settings:** an unknown theme or a `__proto__` key is rejected. The file must be ≤ 1 KB, a regular file owned by the user, and is written atomically at 0600. A corrupt file is refused, never overwritten.
- **pbcopy:** absolute path, argv array, text over stdin from sanitized cells, 2 s timeout, only on a user mouse release (now only after a real drag).
- **Terminal restore:** home key, session exit, daemon death, and an uncaught exception or unhandled rejection on the homepage or while attached all reset the standard modes. Exceptions are listed in L9.
- **Flow control:** a stalled attached client pauses the agent (by design, §5) and it resumes afterwards. A slow attached client was not disconnected by events in 3/3 runs. Preview subscribers never pause a PTY.
- **Swallowed errors:** there is no empty `catch {}` and no `.catch(() => {})` in `src/`.
- **Leaks:** timers and listeners are cleared on every path. Mirrors and previews are disposed on remove and shutdown. `owners` and `preview` are cleaned on remove and close.

## Questions for Yaniv

1. **Q1, socket trust.** Should a process inside a session be able to drive the daemon? Any same-user process can create shells and type into other sessions. My recommendation, before v0.1.6: a per-launch secret held only by the `ai` client, never put in a session's env, required on `hello`. The alternatives are to accept the risk (same-user equals trusted, as with tmux) or to refuse clients that descend from session PTYs, which Node can't detect without a peer pid.
2. **Q2, restart.** After a daemon restart, should already-finished sessions keep their real status and exit code (`failed · exit 3`)? Today everything becomes `exited · background service restarted`. Changing it means changing an existing test. I'd keep finished records as they were and use "background service restarted" only for sessions that were live.
3. **Q3, failure policy.** Should a failed `state.json` or log write keep agents running and show an error, instead of shutting the daemon down and stopping every agent? I'd keep running, surface the error on the homepage, and add an `uncaughtException` handler that logs (redacted) and exits cleanly.
4. **SIGTERM while attached** (part of L9). Today it returns to the homepage. Should it quit `ai`, as it does on the homepage?

## Prompt vs code

- PROGRESS.md's checkpoint said `651dfc3`; the actual tip was `609d23b`, the handover commit itself, as PROGRESS explains.
- The architecture doc said snapshots may be up to 4 MiB, but the server's 2 MiB cap is what applied (fixed, M6).
- The doc said only SIGKILL skips terminal cleanup; SIGHUP and SIGQUIT do too (L9, doc corrected).
- The doc said a stale pid is checked only with `process.kill(pid, 0)`; it now also uses the start-time check (M3, doc updated).
