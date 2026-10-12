# PROGRESS

## Checkpoint
Last commit: 59972da docs: record socket rename, receiver drain and usage caps in architecture
Roadmap step: v0.1.9 done (release gate: review, break, fix with tests, verify; no features)
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at cf18bed with 503 passed / 2 native Keychain opt-in skips / 1 TODO (B6), 76 files. Final 526 passed / same 2 skips / 0 TODO, 81 files. B6 fixed. B10 fixed for its named tests; a residual load tail is listed under Gotchas. v0.2 not started.

## What works
- B6 fixed. RED 725d5a4 → GREEN 5c52eff. The daemon socket is bound under a random temp name in run/, set to 0600, then renamed into place. libuv unlinks a pipe server's bound path on close whatever is there, so close() now only unlinks the temp name. The inode check decides about the real path, and a replacement daemon's socket survives.
- B10, receiver part. RED e469458 → GREEN c55dec3. An oversized body up to 4 MiB is read and discarded before the 413 is sent; nothing past 1 MiB is kept, and anything larger is cut. Decision: the 413 must be delivered. Closing with unread bytes made the kernel send a reset that destroyed the 413, and OTLP exporters retry a reset but not a 413.
- B10, test part. 9f055db.
  - Esc-close assertions poll for the state Esc produces instead of sleeping past the parser's 30 ms lone-Esc timer.
  - The debug stats CLI test drives the entry in-process with a fake sampler. It used to run real top ten times, and top outlived its 2 s timeout under load. A mutation check proved the spies catch a wrong route.
  - Real-process waits got headroom, and the paste canary test polls for the full digest line.
- Usage forgery. RED ccc5fab → GREEN d0f2397.
  - A receiver credential holder could post two 2^53 token points whose sum failed summary validation on every client, and the damage persisted across restarts. Points over 1e9 tokens or 10,000 USD are now dropped and totals saturate.
  - The dedupe maps are bounded, evicting in batches to avoid quadratic cost.
  - One unsafe month file no longer hides the other months. Its warning is no longer cleared by a later successful write.
- Keys. RED → GREEN a14c68d.
  - `KEY="v" # note` no longer imports the quotes as part of the secret.
  - Keys shorter than 16 characters show no last4.
  - A failed import rolls back each created entry separately and names any entry it could not remove, instead of masking the original error.
- /copy (S15). RED → GREEN bf197f2. Copy text and the client validator drop bidi overrides, zero-width characters, Unicode tag characters and line/paragraph separators. ZWJ stays for emoji.
- Client. RED → GREEN ea9ecba. sessions.create and sessions.resume get a bounded 60 s client timeout; the old 5 s one fired while the daemon still started the agent. A daemon that never comes up now names its log path.
- Key panel. RED → GREEN 3dd7a80, f5872d9.
  - It shows the daemon's fixed error reasons, including the orphaned-Keychain-entry text.
  - A saved key whose follow-up test fails still says saved.
  - A removed key leaves the list even if the refresh fails.
  - An engine status failure says "status unavailable" instead of "not installed".
- ai doctor. RED → GREEN 53ecba4. It checks CLI logins with the same account-session env cleanup as the daemon.
- Gate pins in a761506. x and /clean remove records only: project files are untouched and running sessions are refused. auto and Don't ask can't become saved defaults by patch, and a hand-edited settings.json fails closed.
- Verification exits 0:
  - build: success in 16 ms
  - typecheck: tsc --noEmit
  - lint: ESLint: No issues found
  - npm test twice in a row: 81 files / 526 passed / 2 skipped, 6.60 s and 6.89 s
  - coverage (4 workers): statements 87.37%, branches 81.67%, functions 89.59%, lines 92.12%

## What's next
- v0.2. The real-session exit-criteria checks below are still for Yaniv.
- Open bugs found at the gate, left because a fix needs a design change or is beyond a gate fix:
  - B12 (MEDIUM): settings.json is a trust root for Foundry endpoints. A same-user writer can repoint a key's endpoint and mark it ready, and the next test or session sends the Keychain secret there. Fix: bind endpoint/deployments to the secret, either stored with it in the keychain or under a MAC whose key lives in the keychain.
  - B13 (MEDIUM): usage ingestion calls settings.get on every export. A corrupt settings.json gives repeated 500s with no homepage warning, and no usage is recorded.
  - B14 (LOW-MEDIUM): any mirror-write failure emits fatal and stops the daemon and all agents. It should fail only that session.
  - B15 (LOW-MEDIUM): manager.shutdown uses Promise.all. One failed stop skips the rest, and the wait after SIGKILL has no bound.
  - B16 (LOW): the server error allowlist hides fixed manager texts such as "Only exited sessions can be removed" and "Session not found".
  - B17 (LOW): causes are dropped for Foundry test failures, keyring errors and engine-check failures. One invalid key metadata entry blocks list and remove.
  - B18 (LOW): /clean reports only the last failure, without counts.
  - B19 (LOW): forged usage records still append to disk without a rate limit.
  - B20 (LOW): `ai debug stats | head` dies with an unhandled EPIPE stack trace.
  - B21 (LOW): the env scrub lists are exact names. Check the current Claude/Codex docs for newer credential or routing variables before relying on them.

## Manual checks
- Socket rename, receiver 413 delivery (whole-body sender, chunked, cut past 4 MiB), forged usage points, .env import edge cases, copy format characters, key panel errors, doctor env, and record-only removal with own temp roots, fake vaults and own stub PTYs: ran headless. All passed.
- Two and three concurrent full suites as a stress test: the B10-named tests held. The residual tail is in Gotchas.
- `node dist/cli/index.js debug stats` with AI_TERM_HOME pointing at scratch: ran. It printed numeric-only JSON and created no home.
- Exit 1. cd ~/ai-term && ai — needs Yaniv: start Claude Code on account, then on an Anthropic key; Codex on its own login, then on a Foundry key.
- Exit 2. cd ~/ai-term && ai — needs Yaniv: inside each, Ctrl+E goes home while it works, and ⏎ goes back in with the screen intact.
- Exit 3. cd ~/ai-term && ai — needs Yaniv: preview is live, PgUp scrolls back, drag-release copies, typing on the homepage never reaches the agent.
- Exit 4. cd ~/ai-term && ai — needs Yaniv: close the terminal window, open a new one, run ai; the same agents are still running.
- Exit 5. cd ~/ai-term && ai — needs Yaniv: API-key sessions show ≈ usage after a reply, subscription cards show sub, and cards show sub vs API key.
- Exit 6. cd ~/ai-term && ai — needs Yaniv: This Mac shows CPU, RAM and NET, and the preview header shows per-agent cpu/RAM.
- Exit 7. cd ~/ai-term && ai — needs Yaniv: inside each account session run `! env | grep -iE 'anthropic|oauth|api_key'`. Expect nothing, except AZURE_OPENAI_API_KEY in Codex if exported (D41).
- Exit 8. cd ~/ai-term && ai — needs Yaniv: /settings → add key with `sk-ant-AITERMCANARY0000`, then `grep -r AITERMCANARY ~/.ai-term`. Expect nothing; then remove the key.
- Earlier physical paste, copy and Notes checks from v0.1.8e still need Yaniv.

## Gotchas
- Under three concurrent full suites, a long tail of real-process tests can still miss: live vim attach, source CLI homepage, client-signals' 100 ms Esc wait inside a spawned client. Plain npm test and two concurrent suites pass. Don't paper over this with longer sleeps; poll for observable state.
- The receiver discards rather than refuses up to 4 MiB on purpose. Never buffer past MAX_BODY. Nothing past 1 MiB is kept.
- The temp socket name is `.xxxxxx.sock` in run/ to stay well under macOS's 104-byte sun_path. A crash between bind and rename can leave one stale temp socket file in run/. It is harmless and private.
- validateRequest is async because it checks cwd on disk. Assert rejects, not toThrow.
- `vi.spyOn` on ESM namespaces works here for in-process CLI routing tests. Reset modules before and after.
- D52 keeps the Codex telemetry credential in argv, visible to same-user `ps`. It is pinned; usage caps limit what a forger can do.
- RTK.md is still referenced by the global instructions and is absent. No other agent worked in the repo. The two read-only reviewers ran while the parent only read code or worked on separate files.

## New dependencies
- None.

## Concepts introduced
- Rename-into-place for sockets (src/daemon/server.ts): binding a Unix socket creates a file. Node's pipe server deletes the file it bound when it closes, even if another process has since put its own socket there. Binding under a private temp name and renaming it to the real path means our close() can only delete a name nobody else uses.
- TCP reset vs response delivery (src/daemon/usage-receiver.ts): if a server closes a connection while the peer's data is still unread, the kernel sends a reset instead of a normal close, and the peer can lose the reply already sent. Reading and discarding the rest of the request, up to a bound, lets the 413 arrive intact.
- Saturating sums and plausibility caps (src/daemon/usage.ts, src/shared/validate.ts): numbers from a less-trusted source get a per-item ceiling. Totals stop at the largest safe integer instead of overflowing into values that later validation rejects. One bad input then can't break every later read.
