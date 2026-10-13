# PROGRESS

## Checkpoint
Last commit: 8e7b717 test: await the stopped homepage's done promise in the L2 case
Roadmap step: v0.2.7 done (notification click-through) + v0.2 release gate done. **v0.2 is closed** on automated evidence; the click/banner and Foundry re-add checks below are Yaniv's manual checks.
Branch: main. This handover is the last commit; its own hash is in git log.
Started at 70fdae4 after git pull --ff-only (already up to date). Baseline 118 files / 720 passed / 2 opt-in Keychain skips. Final 126 files / 767 passed / same 2 skips. Session: Claude Code, Opus 5.5.
Prompt vs code: B12 and B21 are not recorded anywhere in the repo (no Bugs section has them); the prompt's descriptions were used. architecture §12.1 said a click "brings your terminal forward", which needs Automation; not done, and §12.1 now says so.

## What works
- Part A, click-through (pushed before part B):
  - Helper (RED 307d59d → GREEN 7e20924). userInfo carries the session UUID. Delegates are set before app.run(), so a cold relaunch gets the click. Only the default action counts. It sends exactly `{"clicked":"<uuid>"}\n` to `<home>/run/click.sock` after these checks: home and run are 0700, owned and not symlinks (lstat); the socket is 0600 and owned; the peer uid matches. One-second bound, SIGPIPE off, fixed errors. `--click <uuid>` runs the same send. No click and no argv: exit 2 after 3 s.
  - Daemon (RED 21a6f4d → GREEN 5bb1f00). `click-receiver.ts` gives the click socket its own listener, bound through the shared `private-socket.ts` (extracted from server.ts, B6 temp-bind and rename). Limits: 128 bytes, one line, strict JSON, lowercase UUID, 1 s deadline, 4 connections. Unknown and finished agents are dropped with a log line; at most one action per second. A homepage that sent `clicks.subscribe` gets `session.select`; otherwise `terminal-launch.ts` handles D43. The `.command` is `/bin/sh` + the absolute node/ai paths + the UUID, written 0700 in a mkdtemp folder under the 0700 `launch/`. The daemon runs `execFile('/usr/bin/open',['-a','Terminal',file])`; the file deletes itself when it runs, with a 60 s fallback and a sweep at start.
  - Client (RED cb10ced → GREEN 5e5ddcc). The homepage selects only and never attaches; an unknown id is ignored. `ai --attach <uuid>` validates the UUID before connecting, then opens the homepage inside that agent; a gone or finished agent stays home with a note. README and architecture §12.1/§3/§4 are updated (1e93ef6).
- Part B, release gate. Three fresh-context reviewers (security-reviewer, security-bounty-hunter via general-purpose, silent-failure-hunter) worked on a read-only snapshot of 1e93ef6; a researcher read the official docs for B21. Every confirmed finding below has a failing test commit, then a fix commit:
  - **HIGH (bounty), source-mode code execution.** tsx read tsconfig.json from the agent's project folder, so a repo's `paths` could make the Claude status line or Codex notify (which runs outside Codex's sandbox) execute repo code. Reproduced (marker file). RED e3fcf00 → GREEN e636574: in source mode, `/usr/bin/env TSX_TSCONFIG_PATH=<repo>/tsconfig.json` is pinned in the status line, the notify argv and the `.command`; daemon auto-start uses the absolute loader with the repo as cwd. Built mode is unaffected.
  - **MEDIUM, B12.** RED de0475c → GREEN ac48a28, docs c0f8d17. Details below.
  - **MEDIUM-LOW (security), notification starvation.** One flapping agent could fill the global 10-a-minute budget. RED c66af09 → GREEN 1d6a662: each agent is also capped at 3 a minute.
  - **MEDIUM (silent-failure):**
    - M1: an orphaned Keychain entry wasn't named anywhere; the log now names the `provider:uuid` account.
    - M2: a failed request is logged with its kind and the fixed reason.
    - M4: the Claude status line being left off is logged.
    - M5 (part): click-route startup failures log a fixed cause.
    - LOW L2: only an older daemon's `DaemonRequestError` for `clicks.subscribe` is ignored.
    - RED 9be64de → GREEN 8ec5b01; test follow-up 8e7b717.
  - **LOW (bounty), S12/S15.** `Expect: <other>` got Node's 417, and cell text kept U+2028/2029. RED f4e603e → GREEN 38b9482.
  - **B21.** RED 438f87a → GREEN 6bf35dc (+ d6653a5 for the pinned list). Details below.
- **B12 outcome.** A Foundry Keychain entry is `{v:1,secret,endpoint,deployments}`. withSecret refuses a changed settings.json copy (`Foundry key details changed outside AI Term; add the key again`) or an unbound or legacy entry (`Foundry key must be added again to bind its endpoint`), with no trust on first use. `keys.test` probes only the bound values. A spawn refuses argv whose base_url or deployment isn't bound, which also closes a time-of-check/use gap between two reads.
- **B21 outcome** (code.claude.com/docs/en/env-vars and learn.chatgpt.com/docs/config-file/environment-variables, 2026-10-13). Each list is scrubbed for its own CLI only:
  - Claude: `CLAUDE_CODE_USE_ANTHROPIC_AWS`, `CLAUDE_CODE_USE_MANTLE`, the five `CLAUDE_CODE_SKIP_*_AUTH`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`, `CLAUDE_CODE_CLIENT_CERT/KEY/KEY_PASSPHRASE`.
  - Codex: `CODEX_ACCESS_TOKEN`, `OPENAI_FEDERATION_RULE_ID`, `OPENAI_IDENTITY_TOKEN_FILE`.
  - Not added: `ANTHROPIC_UNIX_SOCKET` and the `*_FILE_DESCRIPTOR` names are not on the official page. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` stay inherited per the §7.3 table. Generic AWS/GCP/proxy/CA variables stay too.

### Not fixed, with reasons
- **Silent M3** (a corrupt state.json stops the daemon with only "Daemon failed"): v0.1 startup path outside the v0.2 surface. Logging raw errors risks S5; it needs per-stage fixed reasons. Next step.
- **Silent M5 (rest).**
  - The helper can't report a failed click: a GUI app's stderr is lost, and a fallback launch would need ai's state.
  - A homepage attached to another agent counts as "open": the prompt says select, and the selection waits for Ctrl+E (documented).
  - No visible note on select: calmer option.
- **Silent L1:** `open` without -W can't see a helper failure. Already documented in v0.2.4b.
- **L3:** status bodies dropped by size, timeout or JSON get no log; a log line wouldn't restore the lost Stop.
- **L4:** stage-specific spawn logs; diagnostic only.
- **L5:** the importEnv rollback message hides the first reason.
- **L6:** a post-rename fsync failure in atomicWrite.
- **L7:** Foundry readiness on any 2xx; the user chose the host.
- L3–L7 are rare, low-impact or need a design. Listed for later.
- **Bounty LOW 3:** another macOS user can read agent argv via setuid `ps`, including the Codex usage credential (D52, pinned) and the first message (v0.1.6 argv delivery, pinned). Forging only inflates that session's usage. Reopening needs Yaniv.
- **Bounty LOW 6:** clicks always reach `~/.ai-term`; a daemon on another AI_TERM_HOME gets none. Documented in §12.1, and the wrong helper-env comment is corrected (32fd75a).
- **Security note:** a project's own `.claude/settings.json` `env` or Codex config can still reroute a key session after folder trust. This is the documented §7.3 Known limit; AI Term doesn't read CLI config.

### Final checks (all exit 0)
```text
npm run typecheck   > tsc --noEmit
npm run lint        > eslint .
npm run build       ESM ⚡️ Build success in 22ms
npm run build:notifier  Notifier built and ad-hoc signed: /Users/yanivsp/ai-term/build/notifier/AI Term.app
npm test -- --reporter=dot (3 consecutive runs, exit 0 each)
 Test Files  126 passed (126)
      Tests  767 passed | 2 skipped (769)
   Duration  11.00s / 10.83s / 10.92s
S8 grep: no exec( / execSync( / shell: true (only RegExp .exec in mouse-rows.ts:56, passthrough.ts:121)
sk- in src: only redaction/filters (log.ts, validate.ts, status-line.ts, usage-parse.ts) and "--ask-for-approval" in env.ts
permission flags outside src/daemon/env.ts: none
git diff --check 70fdae4..HEAD: clean
```
One earlier run exited 1 on an unhandled rejection from a new test (fixed in 8e7b717); the node-pty EBADF stderr is the known baseline line.

## What's next
- v0.2 is closed. Next roadmap step: v0.3 (splits + worktrees), only when Yaniv starts it.
- Carry-overs: silent-failure M3 startup reasons; L3–L7 above. The Terminal.app bar spike exit stays open (bar default off, nonblocking per Yaniv).

## Manual checks
- Rebuild and restart, needs Yaniv (stops running agents): `cd ~/ai-term && npm run build && npm run build:notifier && node dist/cli/index.js daemon stop && node dist/cli/index.js`
- Click with ai open, needs Yaniv: `cd ~/ai-term && node dist/cli/index.js`. Start two agents and select one; when the other's banner appears, click it. The other agent is selected, and Enter attaches.
- Click with ai closed, needs Yaniv: `cd ~/ai-term && node dist/cli/index.js`. Start an agent with a task, `/exit`, wait for its `done` banner and click it. A new Terminal window (or tab, per Terminal preferences) opens `ai` inside that agent; Ctrl+E goes home.
- Same without a banner, needs Yaniv: `cd ~/ai-term && node dist/cli/index.js debug ls` and copy an id, `/exit` any ai, then `cd ~/ai-term && "build/notifier/AI Term.app/Contents/MacOS/AITermNotifier" --click <id>`.
- Click for a removed agent, needs Yaniv: `cd ~/ai-term && "build/notifier/AI Term.app/Contents/MacOS/AITermNotifier" --click "$(uuidgen | tr A-Z a-z)" && tail -1 ~/.ai-term/logs/daemon.log`. Nothing opens; the log says `Notification click for unknown agent dropped`.
- Foundry key after B12, needs Yaniv: `cd ~/ai-term && node dist/cli/index.js`. In /settings, test (`t`) the existing Foundry key: it must refuse with `Foundry key must be added again to bind its endpoint`. Remove it (`x`), add it again (`a`), then `t`: deployments test as before.
- Ran headlessly: built-helper click payload and refusals (temp socket); daemon receiver, routing branches and the exact `.command` (stub launcher); homepage select and `--attach` (fake connection); B12/B21/source-mode/Expect cases. No banner was posted, no Terminal was opened, no real key or login was used.

## Gotchas
- Older Foundry keys refuse until re-added; that's deliberate (no trust on first use). Re-adding needs the key again, or an .env import.
- The Keychain item ACL trusts the node binary, so a same-user node process could still read entries (D35 boundary). B12 binds where a key goes; it doesn't hide the key from the user's own processes.
- The click socket is `~/.ai-term/run/click.sock`. The helper honours AI_TERM_HOME only for direct `--click` runs; real clicks always use `~/.ai-term`.
- `server.ts` now binds through `private-socket.ts`; `socketAnswers` is re-exported from server.ts for existing imports.
- In source mode, status commands depend on `/usr/bin/env` and the repo's tsconfig.json path passing the strict path alphabet; otherwise they're left off (logged).
- Review snapshot worktree was in the session scratchpad and has been removed; the unrelated `/private/tmp/ait-review` worktree from an earlier session is untouched.

## New dependencies
- None.

## Concepts introduced
- Cold-launch delivery (`native/notifier/Notifier.swift`): when a banner is clicked after its app exited, macOS relaunches the app without argv and delivers the click to whatever UNUserNotificationCenter delegate exists while launch finishes. That's why the delegate is set before `app.run()`, and why the route to the daemon must be a fixed path rather than an argument.
- Document launch (`src/daemon/terminal-launch.ts`): `open -a Terminal file.command` asks Launch Services to open a file with Terminal, as a double-click would. Terminal runs it in a new shell. No Apple Events and no Automation permission are involved, unlike AppleScript `do script`.
- Peer credentials (`native/notifier/Notifier.swift`, `getpeereid`): a Unix socket can report the uid of the process at the other end. The helper checks it's the user's own, in addition to the file's owner and mode.
- Secret binding (`src/daemon/keys.ts`): data that decides where a secret may go is stored inside the secret's own protected entry. A writable side file (settings.json) can then only be compared against it, never trusted.
- Module resolution pinning (`src/daemon/env.ts` `sourceTsconfig`): tsx resolves path aliases from the tsconfig.json of the current folder. Commands that run inside someone else's project pin their own tsconfig with `TSX_TSCONFIG_PATH`.

---
## Previous checkpoint (v0.2.6, retained)

## Checkpoint
Last commit: 7186961 docs: record measured product bar latency gate on this Mac
Roadmap step: v0.2.6 done — tasks 2–6 delivered; task 1 Terminal.app spike exit remains open by Yaniv's explicit nonblocking override.
Branch: main. This handover is the last commit; its own hash is in git log.
Continued at 112839b after git pull --ff-only (already up to date), preserving the existing 114-file / 672-passing baseline and two native Keychain opt-in skips. The original 540ebe8/670 checkpoint and later 3a0c949 prompt are historical; the checkout was further ahead. Session is Codex, not Claude Code/Opus.

## What works
- Task 2: d22de29 confirms existing shared Unicode 11 registration in daemon and attached client mirrors. Snapshot/cell tests agree on CJK, skin tones, ZWJ families and flags. No width dependency added; Unicode 11 already existed. This proves mirror agreement, not every terminal's grapheme shaping.
- Tasks 3–4: eda9fe0 / 0bbb675 / 6d7e778 implement opt-in client mirror/cell rendering and saved bar setting. Default **off** per latest instruction. Off preserves full-height raw passthrough and skips probing; on gives the daemon PTY rows−1, including resize. Failed DA1 probe (250 ms) falls back raw and logs once; one-row terminals also use raw. Early probe input survives fallback.
- Bar: surface tokens, glyph + status word, bold name, engine · model, other-session counts and ^E home. Counts drop first, then model; engine is retained when it fits (cc39ab5). Name/home are clipped or omitted when needed to keep the status word. No animation; unchanged bar bytes aren't emitted or rebuilt. Branch in the design was future worktrees data, absent in current code; explicitly deferred to v0.3 in design.md.
- Renderer: synchronized changed-cell output, same-tick idle draw after the public xterm user-input hint, one frame per 8 ms under floods, agent sync waits at most 150 ms (including a sync begin after a frame was already scheduled). Palette/default/RGB colors and accessible cell attributes stay intact. Cursor is restored after bar-only updates. All four mouse encodings shift rows, bar clicks/releases drop, arbitrary split reports and paste markers survive. Home keys are filtered before mouse rewriting; lone Escape retains its 30 ms ambiguity timeout.
- Exact spike query table covered: screen-relative queries answered by the mirror; CSI 18 t reports rows−1; input/title/cwd/theme/copy modes forward; OSC 52 reads, unsupported color/window queries, pixel mouse and inline images drop. Title-stack operations require enabled xterm windowOptions (covered). Reattach carries validated cursor shape, sanitized title, kitty root/push flags and theme reports.
- Task 5: README, design.md and architecture.md document the setting, shortcut, narrow layout, raw fallback and losses: OSC 8 targets (text stays), curly/dotted/colored underlines (plain underline stays), inline images. Product attach has no client-owned child: the daemon owns its PTY; client EOF detaches, cleanup never stops the agent. The spike's client child.onExit callback therefore has no equivalent in product attach. Unexpected input could still make vim quit; the unknown cause isn't declared fixed. Daemon-owned vim was observed staying alive and retaining text across attach/resize/Ctrl+E/reattach with bar both off and on.
- Task 6: RED 64fbf1d → GREEN ab66666. Signed helper --status reads getNotificationSettings without prompting, emits exactly allowed/denied/not-asked/unknown and exits 0. Real direct binary and open -W -n -g --stdout launches each returned **denied**, exit 0, for the same signed bundle on this Mac; direct identity parity confirmed. Native --status test ran, helper rebuilt and signature verified.
- Daemon execFile argv-only status reads: timeout 3 s, maxBuffer 128, fixed PATH; daemon start and once per minute timer, in-flight deduplication and cached state. Settings overlay explicitly requests refresh; ordinary settings reads used by attach return cached state immediately (b60d1bc RED → e3f4b80/2e40abd fix). No helper wait in session paths. Cached denied suppresses notification launches and logs once. Failed/unrecognized/unverified reads are unknown. All four wording states have stub-helper coverage; instructions wrap and scroll to selected rows in short settings (64ae92c RED → 0b33fc8 GREEN).
- Read-only performance-optimizer: confirmed input hint, identified deferred daemon parsing shared by raw/redraw and 8 ms busy-frame delay. No daemon typing changes made. Used actual separate daemon/socket/client/outer PTY measurement rather than claiming spike timing applies to product.

### Latency evidence (milliseconds, this Mac, bar forced on)
Method: scripts/measure-bar.ts, 120×40 outer PTY; raw agent 120×40, bar-on agent 120×39. Actual daemon SessionManager/DaemonServer and configured attach; temp HOME/cwd/AI_TERM_HOME, fixed echo/vim argv. 50 warmup + 500 measured keys per run, 15/20/25 ms gaps; raw/on order reversed in round 2. Output arrival timestamp validated against new body cell and cursor. Eight runs: 4,000 measured keys, zero timeouts. Artifact: docs/testing/v0.2.6-bar-latency.json; Node v26.3.0 darwin arm64.

| Program | Round | raw p95 | on p95 | delta | gate ≤2 ms |
|---|---:|---:|---:|---:|---|
| echo | 1 | 2.48 | 2.88 | +0.40 | pass |
| echo | 2 | 2.27 | 2.66 | +0.39 | pass |
| vim | 1 | 2.47 | 3.20 | +0.73 | pass |
| vim | 2 | 2.70 | 2.85 | +0.15 | pass |

These are headless PTY delivery measurements, not Terminal.app pixels or subjective feel. Gate does not cover input arriving just after a bar/output frame; the mandated 8 ms throttle can delay that busy path. Final review fixes affect Escape/probe fallback/kitty root restoration/narrow layout, not the quiet measured ASCII typing path.

### Final reviewer and checks
One fresh-context high typescript-reviewer pass through 7186961, read-only, no remaining material correctness/security/requirement findings. Initial review preflight caught a test mock type; fixed before review continued. Three real findings:
- Lone Escape buffered by mouse filter: feb6f14 RED → d1af1ac GREEN.
- Early typing discarded on failed probe: 99837eb RED → fcb4994 GREEN.
- Nonzero root kitty flags reset on reattach: 99837eb RED → fcb4994 GREEN (separate failing test in same commits).
Reviewer independently ran three targeted files / 44 passed, typecheck/lint exit 0, diff check clean. During implementation ran touched test files only; final suites include all files.

Final output tails, all exit 0:
```text
npm run typecheck
> tsc --noEmit
npm run lint
> eslint .
npm run build
ESM ⚡️ Build success in 18ms
npm test -- --reporter=dot (run 1)
Test Files 118 passed (118)
Tests 720 passed | 2 skipped (722)
Duration 10.26s
npm test -- --reporter=dot (run 2, immediately consecutive)
Test Files 118 passed (118)
Tests 720 passed | 2 skipped (722)
Duration 10.26s
```
Two skips are unchanged opt-in native Keychain tests; not enabled under the no-keychain constraint. Existing node-pty flood test still prints EIO/EBADF stderr as baseline did; both suites green. No additional tests skipped. git diff --check clean.

## What's next
- v0.2.6 tasks 2–6 complete. Next roadmap step: notification click-through, only in a new explicitly requested step.
- Yaniv runs the still-open Terminal.app trace later, then chooses when to enable bar and perform subjective feel/agent checks. No request to wait for trace; no block imposed.

## Manual checks
- Daemon-owned vim, typing, resize, Ctrl+E and retained text on reattach: ran headlessly with real isolated PTYs, both bar off/on. Product benchmark echo/vim: ran, gate pass. Cell/query/mouse/paste/settings/denied suppression: ran targeted tests. Native status and signed bundle checks: ran; no notification posted or permission prompted.
- Trace — needs Yaniv: `cd ~/ai-term && node scripts/diagnose-bar.mjs redraw --trace` (hands off; auto-quits surviving vim after 2.5 s).
- vim feel — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — /settings → bar on (h), /shell, `/usr/bin/vim -Nu NONE -i NONE -n`, type, Esc, :q.
- top — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — bar on, /shell, `/usr/bin/top`, q.
- Claude Code — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — bar on, select Claude Code, type and check permissions; no real login accessed in this session.
- Codex — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — bar on, select Codex, type and check permissions; Ctrl+C skips an update notice, never approve an update during this check.
- Paste — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — bar on, multiline paste including Ctrl+E remains text.
- Mouse — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — bar on, vim `:set mouse=a`, click/wheel, bar press/release ignored, Esc immediate after normal ambiguity delay.
- Resize — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — bar on, resize during vim/top; agent has rows−1.
- Ctrl+E — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — bar on, Ctrl+E home, agent keeps running, reattach retains text.
- Bar off — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — /settings h → bar off; next attach raw/full-height.
- Notification parity repeat — ran; optional Yaniv command: `cd ~/ai-term && node --input-type=module -e 'import {execFileSync} from "node:child_process";import {mkdtempSync,readFileSync,rmSync} from "node:fs";import {tmpdir} from "node:os";import {join,resolve} from "node:path";const app=resolve("build/notifier/AI Term.app"),dir=mkdtempSync(join(tmpdir(),"ai-status-")),out=join(dir,"status");try{process.stdout.write("direct: "+execFileSync(join(app,"Contents/MacOS/AITermNotifier"),["--status"],{timeout:3000}));execFileSync("/usr/bin/open",["-W","-n","-g","--stdout",out,"-a",app,"--args","--status"],{timeout:3000});process.stdout.write("open: "+readFileSync(out,"utf8"));}finally{rmSync(dir,{recursive:true});}'`
- Benchmark repeat — ran: `cd ~/ai-term && node --import tsx scripts/measure-bar.ts 500` (temp daemon only; takes about two minutes; writes the measurement artifact).

## Gotchas
- Mac spike exit cause remains **unknown**. Successful probe, 4,430 vim bytes and clean exit 0 do not prove why vim quit. Prior exact replies/sizes/late focus/mouse/query headless replay did not reproduce it. Trace remains available and nonblocking per Yaniv; default bar off is deliberate.
- The product's daemon ownership avoids client EOF/child lifetime coupling, but cannot guarantee against a terminal report being interpreted as editor input. Never report task 1 fixed without a proven reproduction.
- The original design had `· branch`; current session data has no branch until worktrees v0.3. Current task specifies engine/model; docs now explicitly defer branch. Old spike report claims D39/2031 absent; current architecture and RESET_MODES already include them. Trust current code.
- No new npm dependency. No protected source/status/env/notifier-spike/review/config directories edited. No real ~/.ai-term touched or user daemon stopped. No ~/.claude, ~/.codex, ~/.ssh, keychain or .env access; no computer use or network except git pull/push. Review/performance agents read-only; root alone edited.
- Existing daemon processes need the new build before recognizing new settings/protocol fields. This session built code but did not restart Yaniv's real daemon.

## New dependencies
- None; @xterm/addon-unicode11 was already installed.

## Concepts introduced
- Client mirror (`src/client/session-screen.ts`): the agent's escape sequences update an in-memory terminal at its own rows−1 dimensions. The renderer draws its cells one row lower, so clears and cursor moves cannot overwrite AI Term's bar.
- Input fast path (`src/client/session-screen.ts`): xterm normally parses on a later timer; its public input('', true) hints that the next write is a typing echo. Idle rendering runs in that same tick; floods keep the 8 ms cap.
- Permission cache (`src/daemon/notification-permission.ts`): authorization is a separate fact from whether an app could launch. A bounded background read caches one fixed enum; session transitions only consult it and never wait on a process.
- Probe fallback (`src/client/terminal-probe.ts`): DA1 confirms that startup queries completed; missing optional colors/kitty support do not fail it. A timeout selects raw for this attach while preserving ordinary input, which keeps startup keystrokes from disappearing.

---
Previous handovers (historical; the checkpoint above supersedes their blocking/default statements):

## Checkpoint
Last commit: 1aa2d47 fix: restrict exit trace to terminal response formats (GREEN)
Roadmap step: v0.2.6 partial — BLOCKED at task 1 (hands-off Terminal.app exit trace pending)
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at 3a0c949 after git pull --ff-only (already up to date). Baseline: 114 files / 671 passed / two existing opt-in native Keychain skips (9.45 s).

## What works
- Existing product behavior remains unchanged. Read PROGRESS first, then current diagnostic/test, AGENTS, README, full bar spike report and spike startup/exit/query/mouse/renderer paths, design/tokens, architecture, current attach and daemon/shared width modules. No product changes or notifier changes.
- Yaniv supplied the first real Terminal.app diagnostic: OSC 10 `rgb:e6ce/e6ce/e6ce`, OSC 11 `rgb:213d/2743/33e7`, DA1 `CSI ?1;2c`; no extra probe bytes, kitty false, startup 6.745 ms, child 4430 bytes, child exit code 0/signal 0, reason program exited. This proves the probe succeeded, but does not show post-probe input, EOF, size or elapsed time to exit. The clean exit alone cannot name what made vim quit.
- Replayed those exact three replies through an outer node-pty driver on this Mac; unchanged spike and diagnostic both kept vim open, accepted typing and only quit after explicit Esc + :qa!. Also tested 20x4, 120x40 and 220x60 outer PTYs, plus late DA1, CPR, OSC colors, focus in/out and SGR mouse reports. None reproduced the spontaneous exit. These are headless startup checks, not pixel/feel verification or latency measurements.
- Read node-pty's macOS spawn and exit handling: it allocates its own PTY/termios and rows/cols; its macOS kqueue/waitpid callback is the source of the reported exit. The new trace checks whether the PID is still alive at that callback, without claiming this bookkeeping is the cause.
- Task 1 diagnostic expansion: RED c1d8a05 → GREEN c36b7ea.
  - `cd ~/ai-term && node scripts/diagnose-bar.mjs redraw --trace` is hands-off: do not type, paste, click or resize. If vim survives, it sends Esc + :qa! automatically after 2500 ms; autoQuitSent distinguishes that from an earlier exit.
  - One BAR_DIAGNOSTIC JSON line now includes PTY size; timestamped recognized post-probe terminal reports from outer stdin and child.write; omitted-byte counts; stdin end/close; child close/exit timing; input-read-error presence; whether the child PID was alive at node-pty's exit callback; kill signals; and vim's VimLeavePre values (dying, exiting, actual lines/columns, an allowlisted qa/q/other command category).
  - Captures at most 4096 bytes across both streams, in memory only, during the first second. Explicit response grammars only; ordinary or encoded typed keys are count-only. The optional VimLeavePre file is temporary, numeric/category-only, removed with the temp directory; no runtime keys, accounts, agents or real daemon used.
  - Headless exact-reply trace ran: 120x39 child PTY; no outer input after probe; mirror CPR/DA2 replies; autoQuitSent true; vimLeave dying 0/exiting 0/quitCommand qa; exit after 2513 ms; PID no longer alive at callback. No spontaneous exit.
- Fresh-context TypeScript reviewer at high: two real findings, both got failing-test and fix commits.
  - MEDIUM fragmented replies disappeared from the trace: RED 8fd05e8 (ESC[ / I split across reads loses focus reply) → GREEN df2de77 (bounded per-stream assembly recognizes it).
  - HIGH broad CSI grammar could print kitty-encoded typed letters; bare ZZ/ZQ also matched ordinary text: RED 0fc1167 (synthetic encoded text leaked) → GREEN 1aa2d47 (exact terminal response formats, no ordinary keys). No additional material findings.
- Final verification after all review fixes, all exit 0:
  - `npm run typecheck`: `> tsc --noEmit`
  - `npm run lint`: `> eslint .`
  - `npm run build`: `ESM ⚡️ Build success in 17ms`
  - Targeted tests/bar-diagnostic.test.ts: 2 passed.
  - `npm test -- --reporter=dot` twice consecutively: `Test Files 114 passed (114)` / `Tests 672 passed | 2 skipped (674)` / 9.82 s then 9.67 s.
  - Existing daemon-core flood test still emits node-pty EIO/EBADF stderr in baseline/final suites. Both exit 0. Unchanged native Keychain opt-in skips not enabled.
  - git diff --check clean. Only scripts/diagnose-bar.mjs, tests/bar-diagnostic.test.ts and this handover changed. No new dependencies; no protected paths or product code changed.

## What's next
- BLOCKER: no spontaneous-exit reproduction or proven cause. Yaniv explicitly authorized one more diagnostic run and requires stopping for its result.
- Need the single BAR_DIAGNOSTIC line from `cd ~/ai-term && node scripts/diagnose-bar.mjs redraw --trace` in Terminal.app, with no input during the run. The diagnostic automatically quits surviving vim after 2.5 s. Do not label task 1 fixed until its actual cause is reproduced and covered by a test.
- Then finish original tasks 2–5 and task 6 in order: shared width agreement in attached client mirror (table already exists), renderer/query/mouse/input fast path, themed bar/rows−1, saved bar on/off and failed-probe raw fallback, docs; notifier --status + verified identity or unknown fallback + asynchronous cached permission checks/settings/denied suppression.
- Performance agent and product latency gate remain unreached; echo/vim raw/redraw p95 not measured. No bar ships. Next roadmap step after v0.2.6 remains click-through notifications; not part of this session.

## Manual checks
- Exact Terminal.app replies, varied sizes and late query/focus/mouse reports: ran headlessly; no spontaneous exit. Trace, fragmented reports, encoded-key omission: ran with real outer PTYs.
- `cd ~/ai-term && node scripts/diagnose-bar.mjs redraw --trace` — needs Yaniv now: hands-off Terminal.app exit trace; it auto-quits. Reply with one BAR_DIAGNOSTIC line.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: /shell then vim, typing and :q.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: /shell then /usr/bin/top, q quits.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: Claude Code typing/permission checks; real login not run.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: Codex typing/permission checks; real login not run.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: multiline paste, Ctrl+E in pasted text stays text.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: vim mouse click/wheel, bar press/release ignored.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: resize preserves rows−1 PTY.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: Ctrl+E goes home, agent keeps running.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: /settings bar off, attach original raw path; setting not built.
- Notifier direct-launch authorization parity: not reached; no --status mode exists yet, no permission conclusion made.

## Gotchas
- No cause is established. Optional query absence, a clean PTY exit code, and 4430 drawn bytes do not show why vim exited. Do not invent a fix from these observations.
- Trace mode adds only an exit autocmd and controlled delayed quit to vim; spike files remain unchanged. It retains bounded input in memory to assemble replies but emits only known terminal reports. The user must use a hands-off run for this trace to distinguish unexpected input.
- Shared Unicode 11 table already exists in daemon/preview mirrors; confirm attached client integration later. D39 and 2031 reset already exist. RTK.md absent. These stale notes remain documented in preceding handover.
- No real ~/.ai-term, ~/.claude, ~/.codex, ~/.ssh, keychain or .env access; no computer use; no network except git pull/push; no user daemon stopped. No other editing agent spawned; reviewer read-only. Session is Codex, not Claude/Opus.
- Follow the original task-6 notifier override only after task 5, the 2 ms latency gate, two final quiet full suites, high fresh-context review and separate RED/GREEN commits for real findings.

## New dependencies
- None.

## Concepts introduced
- Vim exit hooks (`scripts/diagnose-bar.mjs`): VimLeavePre runs immediately before vim exits and exposes v:dying/v:exiting. Numeric values and a small allowlisted command category help distinguish a regular quit from abnormal termination without exporting the editor's contents or command history.
- Incremental report capture (`scripts/diagnose-bar.mjs`): a PTY data event can end halfway through a terminal response. The diagnostic assembles up to 4 KB per combined streams in memory and emits only explicit response formats, so read boundaries cannot hide a reply or turn an encoded key into recorded text.

---

## Previous checkpoint (3a0c949, retained)

## Checkpoint
Last commit: 5167cad fix: keep diagnostic vim writes in temporary cwd (GREEN)
Roadmap step: v0.2 bar + notification authorization partial — BLOCKED at task 1 (Terminal.app diagnostic pending)
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at 540ebe8 after git pull --ff-only (already up to date). Baseline: 113 files / 670 passed / two existing opt-in native Keychain skips (9.81 s).

## What works
- Existing v0.2 status, homepage cards and v0.2.4b notifications remain at the previous checkpoint. No product code changed.
- Task 1 investigation: read the entire bar spike report, startup probe and all exit paths, current attach, daemon mirror, shared width code, design and architecture §12.1/D39.
  - The probe asks OSC 10, OSC 11, kitty and DA1. It finishes on DA1 or after 250 ms. Lack of kitty/color answers does not itself exit the harness.
  - `bar spike: program exited` is emitted only after node-pty's child onExit event, which the spike currently ignores the numeric code/signal for. No cause for Yaniv's immediate exit is established.
  - Headless outer PTY driver on this Mac answered DA1 as Terminal.app (`CSI ?1;2c`) and ignored kitty and OSC 10/11. Both raw and redraw vim stayed alive after 1.8 s, accepted `TERMINAL_APP_DRIVER`, and quit only after the driver sent Esc + `:qa!`. Redraw probe facts: kitty false; startup 8.54 ms. These are startup checks, not latency measurements or Terminal.app visual verification.
- Safe pending diagnostic: `cd ~/ai-term && node scripts/diagnose-bar.mjs`.
  - Runs the unmodified spike in Terminal.app with disposable vim, temporary HOME and cwd, literal child env. It instruments node-pty's CommonJS spawn before tsx loads the harness, so it can print numeric child exit/code, byte count, bounded recognized terminal probe replies (hex), probe facts and reason in one `BAR_DIAGNOSTIC {...}` line.
  - No raw typed-input trace, agent, login, real daemon, real ~/.ai-term or notification access. Temporary state is removed at normal exit. No writes to spikes/ or docs/spikes/.
  - RED ee2492b: diagnostic absent, 1 failing PTY test. GREEN ee2ab0f: DA1-only startup, typing and actual vim exit recording pass. The test uses an outer headless screen to inspect positioned text.
- One requested fresh-context high TypeScript reviewer pass on the code diff; one MEDIUM finding, no additional correctness/security findings.
  - Finding: diagnostic child cwd was the checkout; vim's `file bar probe` plus `:w` could create a file there.
  - RED bd15053: actual vim `:pwd` shows the checkout rather than the temp directory, 1 failing test. GREEN 5167cad: cwd is temporary HOME; the same test passes.
- Final verification after the review fix, all exit 0:
  - `npm run typecheck`: `> tsc --noEmit`
  - `npm run lint`: `> eslint .`
  - `npm run build`: `ESM ⚡️ Build success in 17ms`
  - `npm test -- --reporter=dot` twice consecutively: `Test Files 114 passed (114)` / `Tests 671 passed | 2 skipped (673)` / 10.09 s then 9.70 s.
  - Existing daemon-core flood test emits node-pty EIO/EBADF stderr in the baseline and final suites; both suites exit 0. The two skips are the unchanged native Keychain opt-in cases; did not enable them.
  - `git diff --check` clean. Only scripts/diagnose-bar.mjs, tests/bar-diagnostic.test.ts and this handover changed. No new dependencies.

## What's next
- BLOCKER: Yaniv's Terminal.app immediate-redraw-vim exit was not reproduced. Need the single BAR_DIAGNOSTIC JSON line from `cd ~/ai-term && node scripts/diagnose-bar.mjs` in Terminal.app. If vim stays open, type a few characters, then Esc + `:qa!` + Enter. Task 1 explicitly requires waiting for this result before building. Do not guess the cause.
- After the diagnostic establishes a cause and its regression test, finish tasks 2–5: shared width agreement in the attached client, session-screen renderer/query/mouse/same-tick path, themed bar + rows−1 resizing, bar on/off default on + failed-probe raw fallback, README/design/architecture. Then task 6: notifier --status, verified direct-launch identity or unknown fallback, cached asynchronous daemon checks, settings states and denied suppression.
- Typing-performance agent and latency measurements were not reached. No redraw/raw echo/vim p95 table is measured for a product implementation. The 2 ms gate is unresolved; no bar ships from this session.
- After completion, the next roadmap step remains click-through notifications per the preceding checkpoint; do not start it within the current bar/authorization step.

## Manual checks
- DA1-only headless raw/redraw vim startup + typing + explicit quit: ran; no immediate exit. Diagnostic PTY test: ran; actual temp cwd and exit report verified.
- `cd ~/ai-term && node scripts/diagnose-bar.mjs` — needs Yaniv: Terminal.app startup evidence. Reply with BAR_DIAGNOSTIC line; no credentials or screenshot needed.
- `cd ~/ai-term && node scripts/diagnose-bar.mjs raw` — needs Yaniv only if comparison is useful after the first result.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: /shell then vim, typing and :q; current product is raw passthrough.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: /shell then /usr/bin/top, q quits.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: Claude Code typing and permission flow; real login checks not run.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: Codex typing and permission flow; real login checks not run.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: multiline paste, Ctrl+E inside paste stays text.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: vim mouse click/wheel, bar press/release ignored.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: resize attached terminal, PTY gets rows−1.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: Ctrl+E goes home and agent keeps running.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: /settings bar off, attach uses original raw path (setting not built yet).
- Notification direct-launch authorization parity: not reached; status helper is not implemented, so there is no valid --status diagnostic yet. Do not claim permission is known.

## Gotchas
- Code disagrees with the spike's stale prerequisites: src/shared/unicode-width.ts already registers @xterm/addon-unicode11 in the daemon and preview mirrors. Existing unicode-width test covers CJK, skin tones, ZWJ families and flags with Unicode 11 semantics (separate emoji members, not grapheme shaping). Attached client mirror still needs integration and agreement tests; no dependency decision made yet.
- D39/§12.1 now exist and RESET_MODES already resets 2031. These spike findings are stale.
- design.md's bar includes `· branch`; the prompt excludes it, and worktrees start at v0.3. Follow the prompt for this step and document that decision when implementing.
- RTK.md is referenced by the supplied instructions but absent from the repository. No RTK command used.
- This session is Codex, not Claude Code/Opus; the requested high fresh-context TypeScript reviewer was used. No other repository editing agent was started.
- The pending diagnostic blocks subsequent tasks by explicit user requirement. Preserve the task-6 override allowing notifier changes only after task 5.
- No real ~/.ai-term, ~/.claude, ~/.codex, ~/.ssh, keychain or .env read; no computer use or network except git pull/push. No user daemon or sessions stopped.

## New dependencies
- None. The diagnostic reuses existing node-pty, tsx and @xterm/headless.

## Concepts introduced
- Diagnostic instrumentation (`scripts/diagnose-bar.mjs`): node-pty exposes a CommonJS module object, so a wrapper can observe its public spawn and exit events before loading the unchanged spike. This preserves the suspected startup path while recovering the exit evidence the spike discards.
- Terminal capability probe (`scripts/diagnose-bar.mjs`, existing spike): terminal reply bytes say which keyboard and color features the outer terminal implements. DA1 completes this spike's startup; absent optional replies mean unsupported/unknown capabilities, and are not proof of a program-exit cause.

---

## Previous checkpoint (v0.2.4b, retained for existing behavior and evidence)

## Checkpoint
Last commit: d8bffb0 fix: tolerant settings read for notifications, staged signed build swap, accept unassigned code points, compare waiting reasons (GREEN)
Roadmap step: v0.2.4b done (notifications without click-through; real banner, sound and Allow prompt need Yaniv)
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at 1b720c4 after git pull --ff-only (up to date). Baseline 109 files / 641 passed / two native Keychain skips. Final 113 files / 670 passed / same two skips, twice consecutively with the dot reporter (9.64 s, 9.44 s).

## What works
- Task 1, helper: RED 97fbc4e → GREEN 86f45a2 (+ lint fix 1420cc5).
  - `native/notifier/Notifier.swift` + `Info.plist` (bundle id `local.aiterm.notifier`, name "AI Term", LSUIElement). Argv only: `--session <UUID> --title --body` (+ `--check` = validate and exit). It requests alert+sound authorization and posts one notification: title, body, default sound, threadIdentifier = session id, no trigger. It exits 2 s later, and gives up after 120 s if the Allow prompt is never answered. No click socket, no time-sensitive/critical level.
  - No argv (a cold launch, e.g. after a click) or bad argv → `Invalid notifier arguments`, exit 2. The spike's argv cases are adapted (its click/socket/lifetime flags are now refused) and pass against the built app.
  - `npm run build:notifier` (`scripts/build-notifier.mjs`): xcode-select + `xcrun --find swiftc` check (fixed message and exit 1 without the toolchain). swiftc builds a staged bundle; it is ad-hoc signed and verified, then swapped in whole at `build/notifier/AI Term.app`.
- Task 2, policy (D42): RED 541e1fe → GREEN aae75d9. `src/daemon/notify-policy.ts`:
  - waiting (permission, question, turn failed) always; done only when no client is attached.
  - Same status and reason → no repeat; nothing for starting/running/exited/error; nothing when the setting is off.
  - The body is the name (cleaned, 60 code points max) plus `waiting: <reason>` or `done`.
- Task 3, sending: RED 0b9259b → GREEN cc685a6.
  - `SessionManager.applyStatus` emits `statusChanged(session, previous, next, attached)`, guarded so a listener can't break status.
  - `src/daemon/notifier.ts` reads the setting per notification and runs `execFile('/usr/bin/open', ['-n','-g','-a',app,'--args',…])` with `PATH=/usr/bin:/bin`, never awaited.
  - Failures are logged once per daemon run with fixed text. `engines.status` carries `notifier: ready | not built | launch failed`.
- Task 4, setting: RED 8b044b9 → GREEN 6441ab4. `notifications` (boolean, default on) in settings.json. `/settings` row `notifications: on|off (n)`, toggled by n or Enter. A fixed `notifications unavailable: helper not built · run npm run build:notifier` / `… helper failed to launch` line appears when needed.
- Task 5, docs: f5e3e7f. README covers `npm run build:notifier`, the notifications paragraph and the `/settings n` key row. architecture.md §12.1 says v0.2.4b ships without click-through and records the helper, launch, policy and failure details. design.md /settings DEFAULTS lists notifications.
- Reviews (fresh context, high): no critical/high findings from either reviewer. Each real finding got a failing test, then a fix.
  - Security: RED 9f59f69 → GREEN 59493ec.
    - MEDIUM: unbounded helper launches from a flapping Codex card, now capped at 1 per agent per 5 s and 10 a minute, logged once.
    - LOW: `launch failed` now clears after a success.
    - LOW: the helper now refuses separators, private use and surrogates.
    - Its fourth point (a denied or rejected helper is invisible behind `open`'s exit 0) is documented, not fixable from the daemon.
  - TypeScript: RED 66f8261 → GREEN d8bffb0.
    - MEDIUM: one malformed key entry made the notifier's settings read fail and silenced notifications; it now reads through a store that skips bad keys.
    - LOW: codesign ran after the swap; the whole bundle is now staged, signed and verified first.
    - LOW: refusing *unassigned* code points could silently drop names macOS tables don't know; now accepted (the daemon strips them anyway).
    - LOW: two failed turns with different error text re-notified; reasons are now compared.
    - Its design note, that a waiting alert inside an agent's 5 s gap is dropped, was kept as a trade-off.
- Final verification, all exit 0:
  - `npm run typecheck`: `> tsc --noEmit`
  - `npm run lint`: `> eslint .`
  - `npm run build`: `ESM ⚡️ Build success in 17ms`
  - `npm run build:notifier`: `Notifier built and ad-hoc signed: /Users/yanivsp/ai-term/build/notifier/AI Term.app`
  - `npx vitest run --reporter=dot` twice: `Test Files 113 passed (113)` / `Tests 670 passed | 2 skipped (672)` / 9.64 s and 9.44 s
  - The diff doesn't touch src/daemon/keys.ts, env.ts, spikes/, docs/spikes/, docs/reviews/, .claude/, .codex/ or .agents/. No secrets, raw hex or hidden bidi characters were added. `git diff --check` is clean. No new npm dependencies.

## What's next
- After Yaniv's replay confirms banner, name, icon and sound: click-through (callback socket via a fixed private path, select or attach the agent, D43 Terminal launch through a generated `.command`), as the next step. Not started.

## Manual checks
- Ran (headless): argv cases against the built helper (`--check` only, nothing posted), `open -n -g -a <helper> --args … --check` with a minimal env (exit 0; a missing app exits 1), policy, sender, setting and panel tests with stubs.
- `cd ~/ai-term && npm run build && npm run build:notifier && node dist/cli/index.js daemon stop && node dist/cli/index.js` — needs Yaniv: restarts the daemon (stops running agents) so it has the notifier.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv: start a Codex agent and make it ask for permission (e.g. a network command). Expect the Allow prompt for "AI Term" the first time. After Allow, a banner titled "AI Term" with `<name> · waiting: permission` and the default sound; record the icon.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv: let an agent finish while you stay inside it (attached) → no banner. Let one finish while you're on the homepage → `<name> · done` banner.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv: `/settings`, press n → `notifications: off`; trigger waiting → no banner; n again to turn it back on.
- If no banner: System Settings → Notifications → AI Term must allow alerts; the helper can't report a denial to the daemon.

## Gotchas
- The helper's permission belongs to `build/notifier/AI Term.app` in this checkout. Moving the repo means a new Allow prompt. The spike's `spikes/notifier/build/AI Term.app` has the same bundle id at another path.
- The launch method is `open -n -g -a` (Launch Services): `-n` because only a fresh instance gets `--args`; `-g` so the terminal keeps focus. `open` exits 0 once the app starts, so a helper denied permission still shows `ready`.
- One notification per agent per 5 s and 10 a minute in all; extras are dropped (homepage status still shows them) and logged once.
- Clicking a notification relaunches the helper with no argv; it exits 2. Nothing else happens yet.
- `tests/notifier-helper.test.ts` skips its helper-binary cases when the app isn't built; the path and swiftc-missing cases always run.
- The build-script review fix is tested by reading the script's step order; a real codesign failure can't be triggered without a fault-injection switch.
- No real ~/.ai-term, ~/.claude, ~/.codex auth, ~/.ssh, keychain, .env or agent sessions were accessed. No notification was posted. No network except git pull/push.

## New dependencies
- None (swiftc/codesign are system tools; the build is optional).

## Concepts introduced
- Launch Services launch (`src/daemon/notifier.ts`): `open -a` asks macOS to start an app the way the Dock would, so the app gets its own identity, permissions and parent (launchd). A plain child process of the daemon would be "responsible" to the daemon's terminal. `-n` forces a new instance so `--args` arrive, and `-g` keeps it in the background.
- Edge-triggered notifications (`src/daemon/notify-policy.ts`): notify on a *change* into a state, compared by what the user would be told (status plus reason), never on the state itself. Repeated hooks or repainted titles then can't produce repeated banners.
- Staged build swap (`scripts/build-notifier.mjs`): build and sign a complete copy aside, verify it, then rename it into the fixed path. Readers see either the old complete bundle or the new one, never a half-signed mix.
