# PROGRESS

## Checkpoint
Last commit: 5ebb5fa test: verify official account login commands without live credentials
Roadmap step: v0.1.7 done
Branch: main. This handover is committed last; its own hash is in git log.
Baseline: 66618d8, clean, 328 passed / 1 existing TODO. Account agents and v0.1.8f working.

## What works
- Secrets live only in OS Keychain through keys.ts; service ai-term, account provider:UUID. Settings contain validated metadata only. Unavailable Keychain refuses clearly; failed metadata add rolls back new entry. Tests use unique ai-term-test-* services only.
- All six keys.* handlers and runtime contracts, keyed auth refs/views, metadata-only responses. Foundry models appear only after ready tests. Remove does not stop running sessions; restart keeps key metadata/results.
- Foundry HTTPS Responses ping, 16-token cap, 15s deadline, bounded body, no redirects; 400/404 chat fallback labels unsupported. Result only status/provider code; no body/secret.
- Read-only env import of selected known names from bounded owned regular files; no symlinks/FIFO/evaluation/writes, mtime/content unchanged. Foundry import requires endpoint/deployment fields; UI suggests deleting source. Multi-key failure rolls created entries back.
- Keyed spawn reads the secret immediately around env build/PTY creation and clears recipe env. Anthropic normal config; Foundry overrides; OpenAI direct key route for required UI. Explicit Ask and Codex no-daemon/update flags retained.
- /login provider/account/key flows and masked Foundry save/test; /settings keys/engines/default engine/model/folder/theme; /model keyed rows/resource groups; key cards display API key suffix. First-run login decision finishes before initial draw.
- Masked form clears before sending; request cleared after serialization; cancelled/disposed input cannot revive it. Coalesced Enter/paste regression fixed so keys cannot appear in label. Oversized input refused; short credentials have empty suffix; metadata cannot contain full credential.
- L10 debug retains input counts only. L12 auto-start raw stdout/stderr ignored; uncaught/rejection errors use redactor and clean shutdown. Opaque keyed spawn errors use fixed text.
- README full command/key list and AGENTS.md upkeep rule added. No usage/hooks work.
- Final required checks: typecheck tsc --noEmit exit 0; lint eslint . exit 0; tests 47 files, 361 passed / 1 existing TODO; build success in 14ms; diff check clean.
- Latest coverage before final passing login argv assertion: statements 86.64%, branches 80.57%, functions 87.95%, lines 94.29%.
- Security review and verification-loop completed. Evidence, TDD pairs, grep results and manual commands: docs/testing/v0.1.7-keys-login.md.

## What's next
- Yaniv real Anthropic/Foundry Keychain approval, deployment test, session replies and production-home canary scan; exact commands in docs/testing/v0.1.7-keys-login.md. Implementation step done; real-key checks require Yaniv.
- v0.1.8b usage/cost remains deferred. No further step started.

## Manual checks
- Native Keychain test service: ran. Socket add, last4-only list, remove, native absent, recursive test-home/log scan clean. Every created test entry deleted.
- Local HTTPS stub: ran. Five requests for ready, Responses 404 plus chat success, 401 code, 302 refused. Canary only api-key header to stub, never body/result or redirected host. Server/CA/temp files cleaned.
- Account login argv: ran through real PTY stubs, Claude auth login and Codex no-daemon/update-off login, no prior login required.
- Real keys, provider replies, browser login and macOS access prompt: needs Yaniv. /login masked input only; no keys in chat.
- Real-home canary grep: needs Yaniv. Start with cd ~/ai-term, add fake canary via /login then rg -l AITERMCANARY ~/.ai-term; expect no output, remove in /settings.
- Physical terminal settings/model/form: needs Yaniv; automated cell/PTY checks pass.

## Gotchas
- Running daemon keeps old code. Manual isolated /tmp setup provided; Yaniv chooses safe production restart. Real daemon untouched.
- Whole-repo canary grep is deliberately nonempty in required fake tests/supplied docs; literal empty output is impossible. Production src, all test-home files/logs/state/settings and responses are clean; no real secrets read.
- Short keys remain valid but have empty suffix. JS immutable strings cannot be securely zeroed; owned references are cleared after send/use/dispose.
- Keychain tests use only unique ai-term-test-* service. keys.ts is sole native API boundary; no production-service enumeration.
- Keychain and JSON are not an atomic OS transaction. Failed add rolls back; remove failure is explicit. Metadata/settings share per-file serialization.
- Client keys.test timeout covers up to 40 sequential 15s probes plus fallbacks. Key add/import have 60s for OS prompts; ordinary operations 5s.
- Env import handles simple assignments only, no expansion. Foundry requires AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENT in file or use /login form.
- Initial first-run check exposed a shell fixture startup race, fixed by checking before initial draw and dismissing no-CLI login popup where appropriate.
- One existing replaced-socket-path TODO remains. .claude, spikes, docs/spikes, docs/reviews, real ~/.ai-term, CLI credential files and real .env untouched.
- No concurrent agents used; full diff reviewed directly to honor AGENTS.md.

## New dependencies
- @napi-rs/keyring 2.1.1: Node and existing dependencies cannot access OS credential stores; D24 selected this native bridge. AsyncEntry used; Linux explicitly requires Secret Service without in-memory/plain-file fallback.

## Concepts introduced
- Keychain boundary (src/daemon/keys.ts): OS owns secrets; JSON owns public metadata. Provider plus UUID addresses exactly one item; tests use a separate service.
- Secret lifetime (keys.ts, session-manager.ts, credentials.ts): read immediately around permitted request/spawn, pass only to that env/request, clear references afterward. Immutable runtime strings cannot be securely zeroed.
- Cross-store rollback (keys.ts/settings.ts): Keychain and JSON cannot commit together. Native save then metadata; if metadata fails remove the new item. Shared queue prevents unrelated patches erasing metadata.
- Probe classification (providers/foundry.ts): Codex requires Responses. Successful chat fallback is unsupported; redirects/error bodies never return credentials to client.
