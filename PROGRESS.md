# PROGRESS

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
