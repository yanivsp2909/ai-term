# PROGRESS

## Checkpoint
Last commit: 2581c51 docs: record provider tabs auth labels and stats calibration
Roadmap step: v0.1.7f done
Branch: main. This handover is committed last; its own hash is in git log.
Started at 97cca26, clean; baseline 361 passed / 1 existing TODO. Keys/login and v0.1.8f were present.

## What works
- Slash menu ↑↓ moves selected-card highlight through filtered commands with wrapping; typing/paste resets first match; Enter picks, /theme inserts argument prefix; Esc closes. Outside arrows still select sessions. No input reaches agents.
- /model opens current provider tab, ←→ switches provider (Tab also right), ↑↓ selects model, Enter chooses, Esc cancels. Typing searches across tabs and jumps to first matching provider. Foundry remains tested-ready deployments only.
- CLI-managed auth says own login, with sub/API key when engine check knows it. Saved keys show last4 only. Cards separate model and auth, include status word plus red Don’t ask marker; defaults show auth before start, with long model/folder text clipped first.
- /login providers already had arrows/Enter/Esc; method labels now own login. /settings keys/actions/defaults all reachable via arrows/Enter/Esc; letter shortcuts retained.
- RAM investigation: current snapshot purgeable 7,430 × 16,384 = 121,733,120 bytes = 116.094 MiB / 0.113373 GiB. App+wired+compressed 27.995529 GiB versus anonymous+wired+compressed 28.108902 GiB. Ten samples purgeable 64.688–127.203 MiB; not close to reported ~1 GiB headline gap, so formula retained. Headline mismatch remains unproven.
- CPU comparison: 30 aligned busy-machine intervals; ours mean 43.852536%, top 44.159667%, difference -0.307131 percentage points, mean absolute difference 0.311869. No CPU math change justified; normal homepage 1s sampler unchanged.
- ai debug stats: independent of socket/daemon, ten bounded pairs started 1s apart; prints numeric JSON RAM parts/candidate sums and our/top CPU over same interval. First top startup delays initial output; ten readings complete around 11s. No process names/commands/users/PIDs or raw output.
- README command/key list and docs/design.md updated; architecture calibration limitation documented. Numeric evidence: docs/testing/v0.1.7f-calibration.json; TDD/security/manual details: docs/testing/v0.1.7f-navigation-calibration.md.
- Final checks: typecheck tsc --noEmit exit 0; lint eslint . exit 0; all 51 files, 380 passed / 1 existing TODO; build success 14ms; diff check clean. Coverage: statements 86.34%, branches 80.60%, functions 87.47%, lines 93.88%.
- Final npm test invocation uses temporary config /tmp/ai-term-7f-verify/vitest.config.mts to alias native Keychain to memory; no tests skipped. This adapter honors the task no-Keychain limit; no persistent test config changed.
- Security grep no exec( / execSync( / shell:true in src; top absolute execFile argv -l 2 -n 0 -s 1, bounded timeout/output, numeric parse only. Protected code/folders unchanged.

## What's next
- Yaniv checks new menu/tab/auth UI and debug stats alongside Activity Monitor. Commands in docs/testing/v0.1.7f-navigation-calibration.md. Activity Monitor RAM headline gap still needs simultaneous evidence.
- v0.1.8b usage/cost deferred; no next step started. Existing socket-replacement TODO retained.

## Manual checks
- Thirty busy-machine CPU pairs: ran, close agreement, no math change. Own three Node CPU workers stopped afterward.
- RAM vm_stat counters and both candidate sums: ran; purgeable far below 1 GiB. Activity Monitor simultaneous headline read: needs Yaniv.
- Source diagnostic and real CLI isolated-home test: ran, ten number-only readings, no AI Term directory/socket created.
- Menu arrows/wrap/filter/Enter, provider tabs/filter/Esc, auth/card/default line, settings rows: ran headlessly; physical UI feel needs Yaniv.
- User restart command needs Yaniv: cd ~/ai-term, then ai daemon stop && ai (stops existing sessions; this agent never ran it). Then /model tabs and auth labels.
- Calibration command needs Yaniv: cd ~/ai-term, open -a 'Activity Monitor', then ai debug stats. Memory headline and candidates at the same moment; CPU topBusyPercent vs cpuPercent.

## Gotchas
- Execution mistake: initial plain full-suite runs executed existing native Keychain tests, contrary to the step no-Keychain limit. Fresh ai-term-test-* services only, entries removed; production service untouched. After discovering, all remaining full-suite runs used temporary in-memory dependency alias; every test still ran. No real .env read; inherited import tests used synthetic files.
- Do not call the Activity Monitor RAM headline calibrated. Formula matches requested App/Wired/Compressed sum; purgeable amount here cannot explain its ~1 GiB gap. Both sums visible for investigation.
- Our/top CPU windows align at top output lines; intervals about 1.09s, tiny output/capture delay and rounding explain sub-point differences. Diagnostic top costs do not affect normal sampler architecture.
- debug stats starts staggered bounded pairs to avoid ~1.6s top startup serial delay; no recurring diagnostics beyond ten pairs. First line arrives later than 1s.
- Auth refs remain protocol kind account/key; only human label changed to own login. No CLI credential/config inspection, no keychain product code edits.
- Foundry selection tab inferred from active key ref; opens on current/default engine/model tab. Custom filter IDs in Anthropic/OpenAI use own login, Foundry only tested rows.
- Narrow card layout puts auth on third row and status word on first, with red ! plus selected preview Don’t ask word; long defaults paths/models clipped before auth.
- Running daemon keeps old code; Yaniv decides safe restart. Real ~/.ai-term untouched, no real daemon stopped. env.ts, keys.ts, spikes, docs/spikes, docs/reviews, .claude unchanged.
- One pre-existing replaced-socket-path TODO remains. Direct diff review, no concurrent agents used.

## New dependencies
- None.

## Concepts introduced
- Provider tabs (src/client/tui/homepage.ts and agent-box.ts): provider selects a small model list; filtering searches every provider and moves to the first match. Keeping provider and row selection separate avoids scrolling past unrelated groups.
- Own-login auth label (src/shared/models.ts): CLI-managed authentication can be subscription or API key. A public engine check chooses the wording; no credentials or provider config are read to infer it.
- Aligned CPU windows (src/daemon/sysstats.ts): rates only compare meaningfully when measured over the same interval. Capturing os.cpus at top's two output samples aligns the before/after counters, avoiding comparisons taken at different moments.
- Candidate RAM totals (src/cli/debug-stats.ts): a hypothesis should predict the observed gap. Printing purgeable and both formulas permits a test of that prediction; a small measured amount is evidence against changing the total blindly.
