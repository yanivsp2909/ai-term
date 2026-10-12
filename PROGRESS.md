# PROGRESS

## Checkpoint
Last commit: ab222ff docs: record agent contracts verification and live check limits
Roadmap step: v0.1.5f done; v0.1.6 partial (implementation and automated checks done; real replies/effective permission checks need Yaniv)
Branch: main. Part A handover 7961ce3 was pushed before Part B began. This Part B handover is committed last; its own hash is in git log.

## What works
- Part A: preserves finished restart results, nonfatal log/state writes with homepage warnings, TERM/HUP client quit with 143/129, full appearance reset on all attach exits. D32–D35 pinned exactly in architecture.
- Part B: account-only Claude Code/Codex create and engine-status protocol; runtime field checks; compatible shell-state loader; fresh session recipes; merged settings preserve unknown stored keys and only accept supported patch keys; saved permission only ask.
- Pure argv/env builders implement account and dormant key rows; model uses single --model=id, null omits it, first message is -- plus one argv element. Engine checks use own-provider-cleaned env, argv arrays, 5s timeout; no raw auth output retained.
- Homepage start confirmation, model groups/default/custom, folder completion/errors, Ask/Don't ask marker, actual auth method, selected live preview and attach/Ctrl+E home.
- Actionable missing-engine/login errors are allowlisted. Security fixes reject extra auth/status fields and unknown secret-bearing patches; handler canary tests cover every socket handler.
- Required final output:
  - npm run typecheck: tsc --noEmit, exit 0
  - npm run lint: eslint ., exit 0
  - npm test -- --coverage: Test Files 30 passed (30); Tests 162 passed (162)
  - coverage: statements 85.19%, branches 77.09%, functions 85.92%, lines 91.44%
  - npm run build: ESM Build success in 11ms, exit 0
  - git diff --check: no output, exit 0
- Part A output: 144 tests / 23 files; typecheck/lint exit 0; Build success in 14ms; statements 85.8%, branches 75.67%, functions 85.29%, lines 91.42%.
- TDD/security/live evidence: docs/testing/v0.1.5f-followups.md and docs/testing/v0.1.6-agents.md.

## What's next
- Finish v0.1.6 manual checks: Claude trust prompt/real reply; Codex effective Ask permission and routing/real reply; physical terminal UI/reset check. Do not start v0.1.7 until those are resolved.

## Manual checks
- Live run count: Claude 1/3, Codex 2/3. All AI Term requests were Ask, no permission flags added.
- Each engine: homepage start in temp folder, preview, Enter attach, Ctrl+E home, still running, s/y stop: ran. Claude once, Codex twice. Client /exit returned 0; isolated daemon cleanup completed.
- Claude reply: needs Yaniv. Live session paused on “Yes, I trust this folder”; left unanswered, no permission/trust bypass.
- Codex prompt argv: ran, exact “reply with ok” displayed. Completed ok reply: needs Yaniv. First run reported missing AZURE_OPENAI_API_KEY; second gave no completed reply during observation.
- Codex effective Ask: needs Yaniv. CLI displayed inherited “permissions: YOLO mode” even though default buildArgs contains no permission flag. No CLI config was read or changed.
- Child account-recipe env: ran with real Node stub children, output [] for own-provider auth/routing variables; other-provider pass-through unit checks green.
- Terminal palette/title/cursor and keyboard/UI appearance: needs Yaniv. Exact isolated-home commands are in docs/testing/v0.1.6-agents.md, starting with cd ~/ai-term.

## Gotchas
- Initial checkpoint was c52a59d atop bbb7c8a, 134 green tests; prior PROGRESS branch reconciliation text was stale. No protected repo folders touched.
- Own-provider env cleanup cannot override user CLI config (architecture known limit). Codex account means its CLI-managed API-key login per D31; it may route a provider requiring stripped env credentials. Effective permission also inherits config because Ask adds no flags. Do not work around either by reading/patching CLI files or auto-approving trust.
- Second Codex check was already underway when first run's inherited policy/routing issue was recognized. No further live runs were made.
- No successful model reply claimed. Keep v0.1.6 partial until manual checks finish.
- Test homes/socket paths under /tmp; only started processes killed. Real ~/.ai-term and Yaniv's daemon untouched.
- A3 initial harness resolution failure was corrected and valid RED recorded at e7d2ddc before restoring fix. No history rewritten.
- Initial r/s/p are homepage shortcuts with an empty field per approved design; paste “reply with ok” for this check.
- Title cleanup resets empty/default, not the exact previous custom title. Null model = CLI default. Default folder = ai's launch folder.
- Security review was direct, no concurrent agents to honor AGENTS.md. Branch coverage remains below 80% (77.09%); statement/function/line coverage above 80%.

## New dependencies
- None.

## Concepts introduced
- Spawn recipe (src/daemon/session-manager.ts): argv and env are assembled fresh for each PTY. Only metadata is persisted, so a later session cannot share a mutable environment or retain a secret through state.
- Auth status projection (src/daemon/engines.ts): the CLI's own status command is reduced to five public fields. Account means whatever that CLI reports, while discarded email/key hints never become logs or protocol fields.
- Patch merge (src/daemon/settings.ts): supported incoming keys overwrite the same stored keys; unrelated stored values survive. Validation distinguishes an incoming patch from a loaded document so preservation cannot become a secret-writing API.
- CLI default (src/shared/models.ts and env.ts): null is explicit absence of a chosen model. The argv builder emits no model flag so the official CLI decides using its normal configuration.
