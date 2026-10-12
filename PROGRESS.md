# PROGRESS

## Checkpoint
Last commit: 3a876b5 docs: record v0.1.10 failure handling and command behavior
Roadmap step: v0.1.10 done (B13–B20 bug pass; no v0.2 work)
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at 97f0521 (v0.1.9 gate), baseline 81 files / 526 passed / 2 native Keychain opt-in skips, 7.47 s. Final 88 files / 547 passed / same 2 skips, twice consecutively (8.01 s, 7.64 s). No new dependencies, env.ts or Keychain storage format changes.

## What works
- B13 done — cause: settings.get rejected each export on corruption. RED 653beb5 → GREEN 86dcb73. Cache last validated settings for usage, fall back to bundled prices before any good read, continue recording, publish one persistent homepage warning and fixed log while failing, clear on recovery. Refresh reads remain so repaired settings/new prices take effect.
- B14 done — cause: mirror errors emitted fatal and exposed raw exception text. RED ea25bd9 → GREEN b0e68d4. Only that session becomes error with `terminal mirror failed`; revoke usage, discard subsequent output, stop its child, preserve the failure across exit callbacks and log fixed text. Review RED b161481 → GREEN a2ea69a: removal must complete the stop, so failed stops keep the record for retry instead of orphaning a child.
- B15 done — cause: Promise.all rejected before cleanup and the post-SIGKILL wait was unbounded. RED e14445a → GREEN 5afaf91. allSettled awaits every stop, disposes all mirrors, logs failed session IDs only, bounds both waits to 3 s, and uses a fixed signal failure. Correction to the prompt: Promise.all already starts all stops; its early rejection skipped subsequent cleanup, not invocation of the other stops.
- B16 done — cause: a narrow server allowlist hid manager reasons and logs exposed unknown messages. RED eb98a31 → GREEN 4f0ec35. Exact fixed manager/key reasons pass, near-misses and arbitrary KeyError messages do not; socket, operation and lifecycle logs are fixed text. Canary tests cover responses and retained logs.
- B17 done — cause: failure categories were discarded and whole-array metadata validation blocked good keys. RED 6d1e267 → GREEN 9e467d6. Fixed Foundry timeout/connection/reply-size/request reasons and engine executable/version/login reasons survive through validated protocol fields and existing notes. Keyring exceptions retain only fixed read/write/remove/cleanup causes. Unknown provider error codes are dropped. Malformed metadata warns once, good entries remain listable/removable. Review RED 1659858 → GREEN dd0acee: skipped metadata stays on disk across theme and key writes, excluded from client views, so cleanup information is preserved. Warning lasts until daemon restart; malformed entries require correction before they can be used or removed normally.
- B18 done — cause: /clean overwrote each failure and showed no counts. RED fcf1236 → GREEN 3829ec8. Shows `removed N, M failed` and the first failure; continues attempts and preserves keyboard confirmation.
- B19 done — cause: unlimited unique authorized records reached disk. Valid RED 95d7a0f (126 recorded versus expected 120) → GREEN f66a8c6. Cap 120 accepted unique records per session per 60-second window; excess records drop, one fixed log per window, independent sessions/windows and revoke cleanup. Judgment: 120 leaves room for 20 points per ordinary ten-second Claude export. Initial test commit 6959875 omitted required output tokens and is not valid RED evidence; corrected without rewriting history.
- B20 done — cause: asynchronous stdout EPIPE had no handler. RED 225037b → GREEN 24dfb13. Review RED a8222ff → GREEN d9ed787 scoped the handler to debug stats, preserving interactive terminal cleanup. Stats exits 0 quietly on EPIPE; other stdout failures exit 1 with fixed text. The regression drives actual stats CLI routing with a fake sampler and separately confirms attach restores raw mode and alternate screen.
- Gate assertion/lint alignment: fd500ec. README commands and architecture updated in 3a876b5.
- typescript-reviewer, serial read-only review: initial HIGH B14/B20 and MEDIUM B17 findings all fixed with RED/GREEN pairs; re-review approved with no remaining findings. Parent did no edits while reviewer ran. Typecheck/lint and 30 affected tests passed in re-review.
- Final verification (all exit 0):
  - `npm run typecheck`: `> tsc --noEmit`
  - `npm run lint`: `> eslint .` (no diagnostics)
  - `npm test`: `Test Files 88 passed (88)` / `Tests 547 passed | 2 skipped (549)` / `Duration 8.01s`
  - `npm test` again: same counts / `Duration 7.64s`
  - `npm run build`: `ESM ⚡️ Build success in 17ms`
  - `npm test -- --coverage --maxWorkers=4`: same counts, 16.50 s; statements 87.58%, branches 82.03%, functions 89.51%, lines 92.25%.
  - S8 grep: no exec(, execSync( or shell: true in src. S4 grep: no getPassword outside keys.ts. git diff --check clean; forbidden paths absent from the diff.

## What's next
- Next roadmap gate: Claude review/fixes for B12 and B21 before v0.2; neither belongs to v0.1.10.
- B12 remains open: settings.json can repoint Foundry routing; bind endpoint/deployments to the secret through authenticated storage. env.ts and the Keychain format were untouched here.
- B21 remains open: compare credential/routing env lists with current CLI docs. No external network/doc lookups in this pass.
- v0.1 real-session exit criteria, physical paste/copy and Notes checks still need Yaniv (docs/testing/v0.1.7-keys-login.md, v0.1.8e-paste-copy.md). This bug pass does not establish those results.

## Manual checks
- B13 cached prices, repeated corruption warning/recovery, B14 isolated failure/stop rejection/removal retry, B15 failed stop and bounded wait, B16 response/log canaries, B17 cause/metadata/socket recovery, B18 counts, B19 disk cap/windows, B20 pipe/attach cleanup: ran with own temp roots, fake vaults/transports/PTYs or headless TTYs. All passed.
- Built stats process with own unused AI_TERM_HOME, consumer closed after first numeric sample: ran; exit 0, empty stderr, no home created. No daemon connected or stopped.
- `cd ~/ai-term && node dist/cli/index.js debug stats | head -n 1` — needs Yaniv for physical shell observation; expect one numeric JSON line and no stack trace.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv for physical UI: `/clean` then y on existing finished records shows removed/failed totals; `/settings` retains readable fixed failure notes. Running sessions/files stay untouched.
- `cd ~/ai-term && npm test -- tests/usage-settings.test.ts tests/session-failures.test.ts tests/manager-errors.test.ts tests/credential-causes.test.ts` — needs Yaniv only to replay visible failure/warning scenarios with isolated fakes; no real settings/key edits required.
- Native Keychain, real provider tests, real Claude/Codex sessions, subscription billing and actual daemon restart: not run; needs Yaniv under the earlier exit-criteria plan.

## Gotchas
- RTK.md remains referenced and absent. AGENTS.md and this prompt are the working instructions; no other agent edited this repo.
- Normal tests skip exactly two native Keychain tests. Never enable AITERM_NATIVE_KEYCHAIN_TEST in an automated bug pass; use fake vaults and isolated roots.
- Limit is a per-session fixed 60-second window from its first accepted record, not a sliding window. Over-cap usage is intentionally lost, including cumulative deltas already consumed by the parser; historical data is not repriced.
- Settings fallback is usage-only. Other invalid settings still fail validation. Metadata recovery exposes only valid entries; malformed originals are preserved on disk and its warning lasts until restart. Correct those entries before normal key removal; never infer provider/routing from invalid fields.
- Stop waits at most 3 s after TERM and 3 s after KILL. A signal failure can still leave a child alive, but mirror-failed removal refuses to forget it and shutdown reports its ID. No real stored PID is signalled after restart.
- Serial final suites pass; earlier v0.1.9 stress tail under three concurrent suites remains (live vim attach, source CLI homepage and a client-signals Esc wait). Poll observable state rather than adding sleeps.
- Receiver discards oversize bodies up to 4 MiB to deliver 413 without reset; never buffer past 1 MiB. Private temp socket rename prevents close from deleting a replacement socket.
- validateRequest is async because cwd is checked on disk. D52's Codex telemetry credential remains visible in same-user argv; this step limits record writes, it does not change that pinned boundary.
- User requested no network except the explicit final push. Tests use only local sockets/stubs; real ~/.ai-term, CLI credentials, Keychain and protected directories were untouched.

## New dependencies
- None.

## Concepts introduced
- Safe error causes (src/daemon/keys.ts, providers/foundry.ts, engines.ts): retain the operation/category with a fixed string instead of attaching the original exception, which can contain secrets or child output. Protocol validators restrict the new reason fields to those same fixed values.
- Settled fan-out and bounded waits (src/daemon/session-manager.ts, pty-host.ts): allSettled waits for every stop even when one rejects. Separate TERM and KILL deadlines prevent an exit callback that never arrives from hanging shutdown indefinitely.
- Fault containment (src/daemon/session-manager.ts): a broken mirror invalidates one session rather than the whole daemon. Its failure marker suppresses later output/exit overwrites; removal confirms stopping before discarding the record.
- Last-good cache and per-session window (src/daemon/usage-service.ts): a read failure uses the last validated prices while a warning tells the user estimates may be stale. Each session also has a count/reset time so unlimited unique exports cannot produce unlimited disk appends.
- Recovering views without deleting originals (src/daemon/settings.ts): reads split validated metadata from skipped entries. Updates write both back but return only validated entries, keeping clients safe and preserving the information needed to clean up a malformed key later.
- Asynchronous pipe errors (src/cli/index.ts): stdout.write can return before the stream reports EPIPE. The diagnostic command listens for that event and exits quietly, while interactive flows keep their own terminal cleanup handlers.
