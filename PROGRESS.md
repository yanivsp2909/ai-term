# PROGRESS

## Checkpoint
Last commit: 651dfc3 docs: record verified v0.1.5 homepage and security evidence
Roadmap step: v0.1.5 done
Private remote: https://github.com/yanivsp2909/ai-term (main)
This handover is committed last; its own hash is in git log.

## What works
- `ai` with no args opens the approved homepage: status counts, 36-column Agents panel, 3-line SH/shell cards, waiting-first/newest sorting, visible selection, live read-only mirror preview, Usage/This Mac placeholders, command field and keyboard hints.
- Enter with an empty field uses v0.1.4 attach. Ctrl+E or session exit returns home, restores homepage modes, redraws and resubscribes. Typing at home never sends input or starts sessions; text submission explains v0.1.6.
- Preview toggle, PgUp/PgDn/wheel scroll, End follow, anchored scrollback and new-line banners. SGR mouse selection highlights with the approved tint and copies plain visible text via execFile/pbcopy; copied feedback lasts 1.2 seconds. Banner rows and clipped remote-terminal columns are excluded from copying.
- Stop asks y/n; rename edits inline; remove is restricted to exited/error records. Slash menu filters as typed. /exit and double Ctrl+C leave agents running. Ctrl+C works during stop/rename too.
- Graphite default plus slate/ink/auto/light. Theme-only settings.get/settings.set persist atomically in 0600 settings.json; symlinks/malformed settings fail visibly. Build embeds token/doc palette data; source tsx works too. Auto keeps OSC11 detection, 200ms fallback and SGR49 ground.
- Synchronized diff frames; idle homepage emits no redraws, live preview capped at 30fps, immediate input redraws use cached preview cells. SIGWINCH forces full redraw/reports preview dimensions. Remote attach/detach/resize and another homepage resizing detached sessions trigger fresh dimensioned snapshots.
- Below 100×30, list/command area only; below 60×16, centered resize message. Fixed background paints are explicit; only auto inherits terminal bg.
- Canonical final verification: typecheck exit0 (`tsc --noEmit`); lint exit0 (`eslint .`); npm test: 125 passed across 22 files, 4.47s; build success10ms. Coverage run: 125 passed, 6.64s; 85.27% statements,91.07% lines,84.74% functions,74.98% branches. Nothing skipped. git diff --check and security pattern checks clean.
- Final built-client CPU: 30.2002s with spikes/renderer/noise.js in a real temporary shell session, 6.8167% average,12.3% maximum of one core. All 30 samples under 15%; 3281 stdout bytes/s;noise visible;exit0;canonical/signals/mouse/alternate screen restoration confirmed. Raw evidence in docs/testing/v0.1.5-homepage-cpu.json.
- Real source CLI outer-PTY journey ran: homepage→shell→generated text→Ctrl+E→preview→theme→shrink/grow→/exit; shell still running. Security-reviewer performed read-only security/code/TypeScript/harness review; all real findings fixed with RED/GREEN regressions and final re-review has no remaining issues in targeted fixes.
- v0.1.3 daemon and v0.1.4 attach remain working, including the prior B1 fixes. All original 86 tests retained. Complete TDD ledger, limits, tests, corrections and manual checks: docs/testing/v0.1.5-homepage.md.

## What's next
- v0.1.6: agent starting, model and cwd selection, only after a new prompt. Login/keys remain v0.1.7; Usage/This Mac data remain v0.1.8. No further roadmap step started.
- Yaniv: run the eight physical-terminal checks below. Stop the old daemon first so it loads the new settings/event handlers. Physical keyboard feel, top rendering and actual Mac clipboard remain unverified by automation.

## Manual checks
1. `ai daemon stop; ai debug shell ~; ai debug shell ~/ai-term`, then `ai`: needs Yaniv — both shells listed, selected shell live.
2. ↑/↓ between them: needs Yaniv — instant selection/preview switch.
3. ⏎, run `top`, Ctrl+E: needs Yaniv — attached input, return home and top continues in preview.
4. Preview PgUp, End; drag text, paste elsewhere with ⌘V: needs Yaniv — anchored scroll/live follow and actual Mac copy.
5. `p` hides/shows; shrink then grow the window: needs Yaniv — preview toggle and size breakpoints.
6. `/theme slate`, then `/theme graphite`: needs Yaniv — colors change and persist when reopening.
7. `s` on one shell, `y`, then `x`: needs Yaniv — confirmed stop, exited status and removal.
8. `/exit`, then `ai`: needs Yaniv — normal Mac shell/mouse return and other shell survives.
- Automated source CLI outer-PTY journey: ran — generated shell text persists after Ctrl+E, theme saves, compact/full layout returns, /exit leaves shell running.
- Built-client 30s noise/termios measurement: ran — final CPU and restoration values above.

## Gotchas
- The existing user daemon was left running; first manual command explicitly stops it. New settings requests are unsupported by an old daemon. Never signal a user process merely to refresh code during automated checks.
- Each npm command used the created /tmp/ai-term-homepage-cache.ONRHQe cache, removed after final push. Temporary tests/measurement homes and their own children were cleaned. No key, login, .env, personal agent configuration or SSH reads. Spikes and daemon/env.ts are unchanged; no dependency added.
- There is no RTK.md in this checkout. README's stale "nothing to run" text and architecture attach/settings/event outline now match code. Palette background inheritance means auto only; fixed palettes paint their ground.
- The initial renderer measurement was 12.49% average / 18.2% max and did not meet the maximum gate. Grapheme caching lowered cost; the reported final code result is 6.82% average / 12.3% max, not the intermediate 4.28% / 6.8% run. ps is smoothed and excludes the daemon/noise/physical display cost.
- Existing beta node-pty 1.2.0-beta.15 remains pinned because 1.1.0 shipped a non-executable macOS helper. No install/chmod was needed this step.
- Snapshot correlation id and sessionId are distinct; catch-up snapshots reuse a preview request id. Loading-object identity prevents older snapshots consuming newer buffers, including during startup parsing. Remote dimension events are additive in protocol 1.
- Ages refresh on actual changes; there is no idle timer solely to age cards. Real process states in v0.1 remain starting/running/exited/error; waiting/done/idle are supported vocabulary, without v0.2 hooks.
- Auto's inherited spike luminance threshold may still have weak contrast on intermediate-gray terminal backgrounds. Preserve that approved decision unless Yaniv asks to change it.
- Branch coverage remains 74.98%, below 80%; statement/function/line coverage exceed 80%. Real clipboard and physical terminal behavior require the manual checks, not fake/pseudo-terminal assertions.
- B1 historical immediate-return cause remains unconfirmed; current attach/home behavior was confirmed by Yaniv earlier. Do not equate the separate fixed socket-at-bind race with historical home-key returns.

## New dependencies
- None. Existing @xterm/headless, Node APIs and the pinned renderer design were sufficient.

## Concepts introduced
- Cell frame diffing — src/client/tui/grid.ts represents each screen position as a character/style/width. It compares frames and writes changed runs inside synchronized output, so the terminal reveals a coherent frame and idle output is empty.
- Client-side read-only mirror — src/client/tui/preview.ts parses snapshots/live bytes into its own xterm buffer. It sends only sanitized cell text and reconstructed styles to the renderer, keeping background OSC clipboard/title/bell commands away from the physical terminal.
- Marker anchoring — preview.ts uses xterm markers to track viewed lines as old scrollback trims. Scroll events count new lines even when baseY has reached the 5000-line cap; ED3 clearing resets following rather than masquerading as new output.
- Snapshot generations — homepage.ts associates each pending snapshot with a loading object and request/session identity. A newer catch-up owns its own subsequent bytes, so an older asynchronous parse cannot clear or consume the new buffer.
- Private atomic settings — src/daemon/settings.ts validates a theme-only record and delegates replacement to atomicWrite. A new 0600 file is synced and renamed, so interruption leaves an intact old/new record; file/owner/symlink checks precede reading.
- Build-time palette embedding — theme.ts gets base tokens from JSON and dark overrides from approved design text. tsup embeds that text when building; source runs read the same repository document without requiring a Vite loader.
- Event-driven preview sizing — session-manager.ts broadcasts changed dimensions while homepage.ts requests a fresh snapshot. This matters because another attached client or homepage can control a session’s actual terminal size.
