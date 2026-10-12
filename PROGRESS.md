# PROGRESS

## Checkpoint
Last commit: e7a23f8 docs: record final usage verification outputs
Roadmap step: v0.1.8b done; B9 fixed
Branch: main. This handover is committed last; its own hash is in git log.
Started at clean 2d19257. Native Keychain gate committed before the first full suite; baseline 378 passed / 2 native skipped / 1 existing TODO, 51 files. All usage work, checks and isolated smoke are complete; real export/billing checks need Yaniv as requested.

## What works
- B9: both native Keychain tests require AITERM_NATIVE_KEYCHAIN_TEST=1; ordinary npm test visibly prints the skip reason. Fake-vault tests still run. Safety fix e6a131e; visible reason be0926a.
- Loopback HTTP receiver starts with the daemon on a random port; exact Host, Origin rejection, JSON only, POST metrics/logs only, 1 MiB bound including chunked bodies, 32-byte runtime per-session credential, byte-length check/timingSafeEqual, revoked on end/failed spawn/restart. OTLP success is 200 {}. Main receiver commit 38245b3; byte-length fix 4de29fe.
- Claude reads only allowed token/cost metrics. Delta, cumulative increases/drops/new series, mixed temporality and full-session export dedupe are covered. Codex reads only completed-response token fields, accepting numeric strings, with model fallback; reasoning is not counted twice. Parser 4d29cd7; follow-ups 03b758a, 5fdb420, 342b507, c3a3181.
- Telemetry added only to effective API-key agent sessions (all saved-key providers and own-login API key); subscriptions, unknown auth, login and debug shells excluded. Claude uses env, Codex invocation-local -c HTTP JSON exporter headers, before positional first message. Existing --no-daemon/update/Ask/auth hygiene unchanged. Spawn 74ccd87; all-recipes coverage ed6ff06; fixed private spawn-failure logs eb6ab03.
- Trimmed public list prices: Models.dev one fetch on 2026-10-12, Anthropic 17/OpenAI 49/Azure 95 models. Regeneration offline from a downloaded catalog. Foundry deployment match/override; unknown model/cache rate stays null and price ?. Explicit input/output overrides price all input at that input rate without guessing a cache discount. Prices 0db543d, d9cd2e3, 576d5d6.
- Private usage/YYYY-MM.jsonl (0700 folder/0600 files), incremental local-day buckets and Monday-week/month summaries rebuilt at startup; local midnight refreshes period selection. Write failures retain unsaved records, warn without stopping agents and retry on next export; partial append rolls back. Storage b3b7440/a181ff4/25f44e3, midnight d030b5e, live PTY recovery coverage 3b2d4dd.
- Protocol-first usage.subscribe/usage.summary/usage.updated and diagnostics carry metadata/numbers only. Homepage subscribes while home, unsubscribes attached/closed. Safe diagnostics allow only fixed token/cost names. Contracts 2f039ed, daemon wiring ae3d3cc, diagnostic whitelist 996e9ee, privacy round-trip d811c2f.
- Usage panel has single ≈ estimate marker, bold spend, compact tokens, price ? and daily/week/month budget limits. Empty-field b form saves advisory USD limits; amber warning never blocks. /settings p/selectable price row saves deployment/input/output per-million overrides while preserving other settings. Panel/forms 0298c77/76dc00b, narrow borders 24f73d3, settings row 9a1cd02, form-save coverage 3922a66.
- ai debug usage prints receiver port and last-ten-minute candidate numeric fields, never strings/bodies/credentials. Debug b468d50; README current command/key list and architecture §4/§9/D52 updated.
- Final typecheck/lint/test/build all exit 0: 62 files, 427 passed / 2 native skipped / 1 existing TODO, 10.98s; build success 14ms. Coverage statements 87.13%, branches 81.5%, functions 88.18%, lines 94.26%. Security greps no exec/execSync/shell:true or getPassword/setPassword outside keys.ts. Full diff whitespace check clean.
- Detailed task/RED/GREEN commit mapping, exact checks, source links, decisions and manual commands: docs/testing/v0.1.8b-usage.md. Numeric isolated smoke: docs/testing/v0.1.8b-usage-smoke.json.

## What's next
- Yaniv runs the real Codex usage export test #6 and checks Usage/candidate diagnostics after a tiny Ask turn; compare real billing later. CLI source matches, but live exports were not run on a real login/key.
- v0.1.8c commands-pass is next; not started. u-details deferred as permitted. One existing socket-replacement TODO remains.

## Manual checks
- Own built daemon/temp home, ai debug usage and curl guards: ran, port 50955 then final-build port 51151; 421 wrong Host / 403 Origin / 401 no credential; private root/usage directories 0700; own process stopped and test home removed.
- Local authenticated OTLP ingestion, summaries after restart, every auth recipe via stub, canary secrecy across files/socket/debug, D33 warning/recovery with live own PTY: ran in tests. No native Keychain access.
- Installed codex --version under isolated temporary HOME/CODEX_HOME: ran, codex-cli 0.160.1. Matching source already in prior temp spike checkout; no source network request.
- Real daemon restart: needs Yaniv when existing sessions may be stopped. cd ~/ai-term && ai daemon stop && ai
- Real Codex Ask turn: needs Yaniv. cd ~/ai-term && ai, choose OPENAI own login/API key or tested FOUNDRY in /model, type reply with ok, Enter confirmation/start; preview, Enter in, Ctrl+E home. After 15s check Usage; cd ~/ai-term && ai debug usage. Exact curl commands and form checks in the evidence doc.
- b limits, /settings price form, physical terminal layout/feel and real CLI export cadence: needs Yaniv. Headless rendering/forms and width-border snapshots ran.

## Gotchas
- Prompt's 380-test checkpoint counted two native tests. Safe default now skips those two; current suite 427 passed plus 2 skipped and the existing TODO. No synthetic test aliases needed.
- Codex source rust-v0.160.1 confirms input_token_count/output_token_count/cached_token_count/reasoning_token_count; input/output may be numeric strings. Extra token/effort/tool/error data dropped. Missing timestamps are diagnostic-only because counting cannot be deduplicated safely.
- Prompt cited D52 but D-log stopped at D46; the explicit prompt allowance was recorded as D52. Codex exporter header remains -c because no documented env-header route was found. Usage receiver returns 200 {} per OTLP/S12/prompt despite AGENTS.md's generic local-endpoint 204 wording.
- Own-login engine status reveals API key but not provider. Codex own-login usage uses OpenAI attribution/prices; keyed Foundry uses Foundry/Azure. Do not inspect CLI credentials/config to guess the provider.
- Old sessions need restarting to receive telemetry. Restart revokes all credentials and old exporters cannot authenticate. Dedupe lasts while each session lives; keys are removed on session end.
- Unknown price means known-only spend and price ?. Catalog cache price absence remains unpriced; explicit override input rate applies to all input, optional cacheRead supported by validated settings. Overrides change future estimates only.
- D33 disk failures keep pending records in memory and agents alive; crash before disk recovery loses unsaved usage. History reader accepts monthly regular owner files at most 64 MiB; malformed lines log fixed text and skip. Diagnose warnings before treating history totals as complete.
- Direct serial security review fixed credential byte-length exceptions, unsafe arbitrary diagnostic names, authenticated spawn-log credential exposure, partial append corruption, prototype model-price lookups and cumulative/reset edge cases. No concurrent agents used.
- Some regression-test mock setup initially failed before the intended behavioral assertion; corrective test commits are kept in history. No rewrites/force pushes.
- Production ~/.ai-term, real CLI auth dirs/.env/keychain and Yaniv's daemon untouched. keys.ts, spikes, docs/spikes, docs/reviews, .claude, package manifests and dependency lock unchanged. Only one models.dev fetch, plus required origin push; live tests local HTTP only.

## New dependencies
- None. node:http/crypto/fs and existing renderer/test tools are enough; OTLP JSON parsed with a strict allowlist.

## Concepts introduced
- Per-session telemetry credential (src/daemon/usage-receiver.ts): a fresh random secret identifies the session without trusting payload session IDs. Constant-time comparison follows a byte-length check; revocation prevents a finished or old session from adding usage.
- OTLP allowlist and cumulative series (src/daemon/usage-parse.ts): only documented usage fields are read; private values and tool bodies are ignored. Delta points add their value, while cumulative points add only the increase in the same series; export timestamps deduplicate retries.
- Incremental calendar buckets (src/daemon/usage.ts): each saved event updates one local-day total, with per-provider cost/tokens. Today/Monday-week/month queries sum days instead of replaying every event; startup rebuild and midnight selection preserve calendar semantics.
- Estimated price with unknown cost (src/daemon/usage-prices.ts): token counts and billing dollars are different facts. A public price snapshot/explicit override estimates known models, while null preserves uncertainty instead of silently treating unknown usage as free.
- Advisory budgets (src/client/tui/usage-panel.ts and usage-forms.ts): limits compare known estimated spend against daily/weekly/monthly USD values. Crossing a limit changes the warning, while sessions remain usable; the ≈ and price ? labels expose the estimate's limits.
