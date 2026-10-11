# PROGRESS

## Checkpoint
Last implementation commit: 4e7b810 fix: drain benchmark output and include process startup
Roadmap step: v0.1.1 done; v0.1.2 done (manual terminal/key checks remain needs Yaniv)
Private remote: https://github.com/yanivsp2909/ai-term (main)
This handover is the final commit; its own hash is in git log.

## What works
- Strict Node/TypeScript scaffold and ai CLI: version 0.1.1, no-args placeholder, unknown command stderr/exit 2.
- Exact §7.2 validator; 13 tests pass. Typecheck, lint, tests and build pass; build contains only dist/cli/index.js.
- Read-only setup inventory and CLI facts in docs/spikes/. Private GitHub repo created and verified PRIVATE.
- Ctrl+E home-key docs committed; obsolete home-key setting removed.
- Ink and custom grid prototypes in spikes/renderer/ use real node-pty noise plus @xterm/headless cells. Preview paced ≤30 Hz, command input flushes immediately, resize and terminal restore tested.
- 30-second final measurements: Ink CPU average/max 46.17/60.00%, input latency average/p95 11.26/17.56 ms; grid 14.03/23.10%, input 2.40/3.13 ms. Recommendation: custom grid under D26 thresholds.
- Crash/resize/early startup Ctrl+C checks passed. Split UTF-8 and arrow-sequence handling fixed after review. Numeric measurement evidence retained; saved screen streams inspected then removed.
- Dummy keychain set/get/delete passed; entry verified absent and throwaway folder removed.

## What's next
- v0.1.3 (daemon), only in a new authorized step. No daemon code exists, no prototype moved into src/.
- Yaniv's planning chat should review architecture §7/§9 corrections in v0.1-cli-facts.md and renderer recommendation; D26 remains Proposed.
- Complete manual/key/telemetry checks below. No real model request was made in these spikes.

## Manual checks
- Ink: needs Yaniv. cd ~/ai-term && node spikes/renderer/main.js ink
- Grid: needs Yaniv. cd ~/ai-term && node spikes/renderer/main.js grid
- For both: report flicker, instant typing, clean window resize, and dark colors matching design.
- Optional visible crash: needs Yaniv. node spikes/renderer/main.js grid --crash (or ink).
- Claude API-key first/repeated approval and config-dir isolation: needs Yaniv, CLI facts commands 1–2.
- Foundry GPT/non-GPT real requests: needs Yaniv, CLI facts commands 3–4.
- Live telemetry payload/token fields and receiver OTLP/204 compatibility: needs Yaniv/later integration, CLI facts commands 5–6.
- Tool paths/versions/login status, native PTY/mirror, dummy keychain cleanup, synthetic resize/crash and early startup interrupt: ran.

## Gotchas
- node-pty 1.1.0 prebuilt macOS arm64 spawn-helper arrived mode 0644; targeted chmod u+x fixed posix_spawnp failed. A clean npm install may need an upstream/native install fix. No hidden workaround in product code.
- Current Codex rejects wire_api=chat. Arbitrary non-GPT Foundry routing is not proven; API v1 needs no api-version. Codex login status reports API-key auth, not ChatGPT subscription.
- Claude approval storage field/path remains unconfirmed. OTel cost is estimated; statusline context totals are not lifetime usage. Codex live context percent remains null pending documented source.
- The exact requested history grep has documentation-only matches (12 before this handover); it is not empty. Credential-shaped scan finds none. Existing docs contain dummy canaries, placeholders and permission text.
- Own prototype code reads no inherited env values or external files/network. Ink dependencies inspect env/runtime data internally, so a literal transitive no-env/no-external-file assertion is qualified in the report.
- Restoration covers Ctrl+C/SIGTERM/caught crashes; SIGKILL cannot run cleanup.
- Final 30-second runs were repeated after review fixes, including accurate startup timing and final PTY draining. Reviews found no remaining current material bug.
- Grid input width is approximate (emoji/ZWJ/full wcwidth not solved). Under 65×24, compact resize notice instead of five full cards.
- npm audit: one low Windows esbuild dev-server advisory under tsup; no affected server runs. audit fix did not resolve its constrained dependency.
- Coverage 100% applies to the validator only, not CLI/spikes. spikes is excluded from build/typecheck/lint as requested.
- RTK.md was absent in repo/parent. Installed definitions do not prove live callable roles.

## New dependencies
- typescript / @types/node: strict compiler and Node types.
- tsx: source execution; tsup: CLI bundling; eslint / @eslint/js / typescript-eslint: lint and process API restrictions; vitest: validator tests.
- ink / react (dev): measured React terminal renderer candidate; no built-in terminal layout equivalent.
- node-pty (dev): real pseudo-terminal needed for generated live preview.
- @xterm/headless (dev): safely parse generated terminal output into mirror cells.
- @xterm/addon-serialize (dev): native library serialization spike; retained for future planned mirror snapshots.
- @vitest/coverage-v8 (dev): verification-loop coverage report for tested pure logic.

## Concepts introduced
- Scaffold: package.json defines executable/scripts; tsconfig.json enforces strict types. tsup.config.ts builds only the CLI, keeping experiments out of dist.
- Validated argv: src/shared/validate.ts bounds ASCII ids before future spawning. Tests reject spaces, flags, shell syntax and oversize ids.
- Screen mirror: PTY bytes go into an in-memory xterm grid, never directly to homepage stdout. Both spikes render those cells, preventing background control bytes from owning the terminal.
- Cell diff: spikes/renderer/grid.js compares previous char/style cells and emits changed positions between synchronized-output markers. This reduces bytes while preserving scene layout.
- Render latency: measure.py samples process CPU while main.js timestamps input and awaited writes. Delivered bytes are measured; perceived paint/flicker is still a manual terminal check.
- Lifecycle cleanup: main.js restores terminal modes before diagnostics and guards asynchronous Ink startup after stop. input.js keeps fragmented UTF-8 and discards terminal key sequences.
- Fact status: docs/spikes separates verified commands, official docs and needs Yaniv checks; real keys stay outside reports and files.
