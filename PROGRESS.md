# PROGRESS

## Checkpoint
Last commit: b1558ad docs: record Claude status limits and skipped agent guide sync
Roadmap step: v0.2.2 done (Claude status core; physical CLI checks need Yaniv)
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at 72d981d after git pull --ff-only (already up to date); baseline 88 files / 547 passed / two native Keychain opt-in skips, 8.03 s. Final 95 files / 576 passed / same two skips, twice consecutively, 7.78 s and 7.76 s. No Codex ingress, homepage card/notification UI or bar; v0.2.3 not started.

## What works
- Task 1, protocol first: RED 47ab8b7 → GREEN 1c15606. Six planned statuses (idle removed), context 0–100/null and lastActivity {tool, at}/null validate in responses and events. Legacy records may omit activity. Added explicit sessions.text lastReply boolean and an optional copy source; ordinary session responses have no reply. Removing the unused idle renderer entry is the only card-renderer edit.
- Task 2, reducer/Claude mapper: RED e54b03b → GREEN d60e7cc. Pure status-reducer.ts handles sequence order, running/waiting/done/context and exit precedence; terminal state ignores later events. claude-status.ts reads only mapped hook fields, restricts tool/error metadata and separates bounded replies from status. Late permission_prompt is backup only, suppressed after tool completion/done. Startup correction RED f830de0 → GREEN 5f22987, then review RED dbc568c → GREEN 5f2755d covers context before output and queued output after exit.
- Task 3, one local server: RED da2d159 → GREEN 035a9cb. Existing usage-receiver gains POST /v1/status/claude; separate timing-safe status credential map resolves session identity. Every status/unknown-route reply is bodyless 204, including auth/Host/Origin/type/JSON/oversize/wrong method/errors. Usage paths preserve their 200 {} contract and existing rejection codes. Cap 4 MiB; parse only to map allowed fields, no bodies logged. Seq assigned at request arrival; slots consume in order.
- Tasks 4–5, env/hooks: RED f92b5c0 → GREEN 826fa25; integration RED 6d5a112 → GREEN 7e88fea. Every new Claude agent (subscription included, login sessions excluded) gets its own random AITERM_STATUS_TOKEN and numeric AITERM_STATUS_PORT in env via env.ts. Token never enters argv/settings/state/logs; base env drops stale status values. sessions/<id>/claude-settings.json is 0600 under 0700 directories, passed as one --settings=<path> argument before first-message delimiter and deleted on record removal. All hooks have timeout2, literal $AITERM_STATUS_TOKEN header and allowedEnvVars. No writes to CLI configuration.
- Task 6, D37 status line: RED b11a6e7 → GREEN f729fa2. Internal ai status-line reads at most 1 MiB stdin, prints safe model · ctx N%, sends only numeric context to 127.0.0.1 with env credential and one-second request bound. Unsafe command paths omit statusLine. Review RED 465fbda → GREEN 387d876 includes validated absolute tsx loader for source sessions; actual generated source command executes in a child test. Built JS command smoke passes too, without daemon/home creation.
- Task 7, last reply: RED 2b14069 → GREEN 923ae91. Stop.last_assistant_message stays in Live memory only, UTF-8 cap256KB; explicit c and /copy prefer Claude last reply, preserving whitespace after control stripping. /copy all retains mirror behavior; unavailable reply retains cleaned whole text and today's fallback note. Chunk source validated by client; no reply reaches lifecycle/session metadata or disk.
- Task 8, L4: 7e88fea plus runtime tests. All nonterminal sessions, including waiting and done, count live and remain sampler roots. Restart marks previously live statuses exited; saved PIDs never signalled. Stub tests assert permission/done activeCount1.
- Task 9, debug/docs: f729fa2, 7e88fea, d5d2e00, b1558ad. ai debug ls prints id/status/statusDetail/ctx=<used% or ?>/title. README command inventory, copy behavior and status-line semantics updated; architecture S12/S15 and §12.1 updated.
- Review fixes: security-reviewer initially found source loader and body overtaking; RED bd1de5a → GREEN 208b3de preserves request order. RED ecb44b0 → GREEN 200da55 preserves failed-slot predecessor order and closes half-open reads after empty204. Re-review approved with 25 focused tests and no remaining findings. Final typescript-reviewer found startup output/state divergence; 5f2755d fixed it, re-review approved with 51 targeted tests plus separate output/exit regression. Reviews serial/read-only; parent did no edits while reviewers ran.
- Final verification, all exit0:
  - `npm run typecheck`: `> tsc --noEmit`
  - `npm run lint`: `> eslint .`, no diagnostics
  - `npm test`: `Test Files 95 passed (95)` / `Tests 576 passed | 2 skipped (578)` / `Duration 7.78s`
  - `npm test` again: same counts / `Duration 7.76s`
  - `npm run build`: `ESM ⚡️ Build success in 16ms`
  - Coverage: statements87.82%, branches82.51%, functions89.66%, lines92.54%.
  - Built status-line child: exit0, claude-sonnet-4-6 · ctx25%, empty stderr, unused AI_TERM_HOME never created.
  - S8 grep no exec(, execSync( or shell:true; permission flags only env.ts. Diff excludes keys.ts, spikes/, docs/spikes/, docs/reviews/, .claude/. git diff --check clean.

## What's next
- v0.2.3 Codex ingress only when Yaniv asks: notify/OSC9/title handling not implemented here. v0.2.4 owns card/notification UI; bar later.
- Physical Claude permission/run/done/context/copy checks below need Yaniv. New sessions need the new hooks; restart daemon first. Trust dialog must be accepted before Claude enables HTTP hooks.
- v0.2.1 notifier remains partial; its permission/display/click checks unresolved. B12/B21 remain open for the Claude gate, untouched here.
- agent-and-skills.md Project upload sync: skipped per Yaniv's final instruction because neither target nor uploaded source was found in allowed workspace. SYNC_NOTES.md records the request and skip; no replacement contents invented.

## Manual checks
- Stub Claude account/subscription lifecycle, private settings/env, permission→running→done, context/activity, active waiting/done, exit revocation, memory-only reply/explicit copy, source command execution, endpoint empty204/reordered/abort/half-open/canary checks: ran headless in own temp homes, no real agents or credentials. Passed.
- Security/type reviews and full type/lint/tests/build/coverage: ran, passed as above. Built status-line smoke ran independently.
- `cd ~/ai-term && node dist/cli/index.js daemon stop` — needs Yaniv: explicitly stops his daemon/agents; agent did not run it. Then restart with the next command.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv: start Claude on account, accept workspace trust, ask for a command needing permission and leave the prompt open. Use Ask, not auto/Don't ask.
- `cd ~/ai-term && node dist/cli/index.js debug ls` — needs Yaniv: while permission prompt is open expect waiting permission; approve in Claude, then re-run to observe running and done. No new card design is claimed.
- `cd ~/ai-term && node dist/cli/index.js debug ls` — needs Yaniv: compare ctx=<used%> with Claude's model · ctx N% status line after a turn; status line replaces the user's only in this session.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv: Ctrl+E home from that Claude session, press c or /copy, paste in a scratch editor and confirm only the last reply; /copy all keeps whole-session scope.
- Native Keychain, real keys/logins, other providers, actual CLI hook timing, billing, physical clipboard and live UI: not run; needs Yaniv. No computer use used in this step.

## Gotchas
- Prompt §12.1 has correct status cap/empty errors, but older S12 row still said64KB/413; updated to4MiB/204. Usage exporters still require200{}, so “every response204” applies to status/unknown routes, not usage endpoints.
- HTTP status read deadline1s stays under hook timeout2s. Over-cap bodies retain no bytes beyond4MiB; delayed/half-open requests flush204 then close. Queue predecessors settle on abort/timeouts before later callbacks execute. Connection/header parser failures also use bodyless204.
- Seq is daemon request-arrival order, not native CLI sequence; hook requests themselves may be concurrent. No raw/native sessionId or seq is trusted. Context cannot overtake an earlier Stop body. PTY startup promotion preserves ingress seq and cannot overwrite terminal state.
- StopFailure uses fixed allowlisted errors; unknown error values become unknown. Tool names must pass a strict80-character identifier rule; no tool input/reply appears in activity. LastActivity keeps the last tool, not arbitrary prose.
- Last reply UTF-8 truncation retains the first256KB and is memory-only; daemon restart loses it along with mirror history. Older sessions/no reply and Codex still use today's fallback note. c scopes to the selection when queued, and copied content is never rendered in homepage notes.
- Source statusLine uses an absolute validated tsx import path; built mode uses JS directly. Spaces/metacharacters in node/entry/loader omit the status line rather than shell quoting. Hook --settings path is always one argv element and may contain spaces safely.
- Claude Esc interrupt fires no hook; trust gate can withhold hooks. No heuristics added; status may remain running until a later event. Codex ingress not silently added.
- session settings file removal checks directory type/owner and unlinks only generated claude-settings.json; unsafe paths fail visibly. Empty session directories can remain. Existing private root protections remain mandatory.
- PROGRESS baseline had v0.2.1 partial; this step was explicitly authorized on synced72d981d. RTK.md still absent. No other agents edited; requested reviews were serial/read-only.
- No real ~/.ai-term, ~/.claude, ~/.codex, ~/.ssh, keychain, .env, native Keychain tests or real Claude/Codex sessions accessed. No external network except explicitly requested git pull/push. Stub env/key hygiene tests remain unchanged and pass.

## New dependencies
- None. Existing tsx handles source-mode status-line; Node HTTP, crypto, filesystem and existing PTYs provide the implementation.

## Concepts introduced
- Ordered reducer (src/daemon/status-reducer.ts): each session has explicit state and a monotonic ingress sequence. Process exit is terminal even if its sequence is older; later hook/context updates cannot revive it.
- Dual contracts on one listener (src/daemon/usage-receiver.ts): usage exporters require200{} but Claude status hooks require204 with no body because JSON can be a permission decision. Separate credentials/routes let subscriptions report status without becoming billable usage.
- Ordered asynchronous slots (src/daemon/usage-receiver.ts): request bodies can finish out of order. Each callback waits for its predecessor, and abort/timeouts release the slot only after that predecessor, so a large reply cannot be superseded by a tiny context request.
- Per-session generated settings (src/daemon/claude-settings.ts, env.ts): a private file contains hook configuration and an env-variable name, not the secret value. argv selects the file while the fresh session env supplies the token; the helper's command string uses only strict absolute paths.
- Explicit reply export (src/daemon/session-manager.ts, client/tui/homepage.ts): the full reply is not session metadata. It stays in one memory field until a user asks to copy it, then travels through the bounded existing text-export protocol, keeping automatic events/logs/state free of reply content.
