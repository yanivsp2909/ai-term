# PROGRESS

## Checkpoint
Last commit: 4415994 test: remove canary-scan and idle-interval races exposed by a busier suite
Roadmap step: v0.2.3 done (Codex status core; physical Codex checks need Yaniv)
Branch: main. This handover is the last commit; its own hash is in git log.
Started at 2399e49 (Codex's earlier session had only deleted SYNC_NOTES.md, unpushed; no v0.2.3 code existed). Baseline 95 files / 576 passed / two native Keychain skips, 7.59 s. Final 100 files / 596 passed / same two skips, twice consecutively, 8.65 s each; ten further full runs all green.

## What works
- Task 1, endpoint: RED 890be41 → GREEN f4ae3ef. POST /v1/status/codex on the shared server with the S12 rules; every reply is bodyless 204 (success, auth, Host, Origin, type, bad JSON, oversize, unknown path, wrong method, errors). Status credentials are bound to an engine and reach only that engine's path. sessionId comes from the credential only. Codex cap is 2 MiB, not the planned 64 KB (Yaniv chose this: a 256 KiB reply can grow ×6 under JSON escaping). Only type and last-assistant-message are read; bodies are never logged.
- Task 2, `ai status-notify <json>`: same commits. Keeps type (agent-turn-complete only) and last-assistant-message (UTF-8 cap 256 KiB, shared `src/shared/last-reply.ts`); input-messages, cwd, thread ids and the rest are never copied. POSTs with AITERM_STATUS_TOKEN/PORT from env, 1 s bound, no output, exit 0 on any failure (built and source CLI checked).
- Task 3, argv: RED 6354a85 → GREEN 53e98d1. Only through buildArgs, each -c one argv element, right after the single --no-daemon and before `resume`: notify=[node, (--import, tsx loader in source mode,) ai cli, "status-notify"] only from paths passing isStatusCommandPath, otherwise notify is left off (and the daemon logs it); tui.notifications, tui.notification_method="osc9", tui.notification_condition="always", tui.terminal_title=["activity","run-state","context-remaining"]. Token never in argv.
- Task 4, mirror signals: RED bcb58ed → GREEN c91793f, review fixes RED 7e8f89d → GREEN 30c9f47 and RED b608b16 → GREEN 3b48beb. The daemon mirror (never the client) reports OSC 9, title and bare bell. Approval OSC 9 ("Approval requested", "Codex wants to edit"), a bell while running, or a change into `[ ! ] Action Required` → waiting permission; a change into Working/Thinking → running; Ready left to notify; whole-part `Context N% left` → ctx 100−N. Attached owner Enter (CR, CSI 13 u; never inside a bracketed paste, tracked across chunks) after done/waiting → running. Signals join the session's request queue so a notify still being read is applied first; they apply only when status/reason/ctx would change; exit still wins.
- Task 5, last reply: notify's reply stays in Live memory only; kept even if its done event was stale. c and /copy request it for Codex as for Claude (homepage asks for lastReply on any agent engine).
- Task 6: subscription and key sessions both register status (status is not billing); usage telemetry rules unchanged.
- Task 7: ai debug ls already prints status/statusDetail/ctx for every session, so Codex shows there unchanged. README (ai status-notify, Codex status paragraph, c and /copy for Codex), architecture S12 and §12.1 updated (7e549bc, 617493a).
- Codex config keys confirmed on installed codex-cli 0.160.1 without a session: `codex --no-daemon -c … features list` loads all five keys together; `tui.notification_method="osc777"` fails ("expected one of auto, osc9, bel"); a bad `tui.notification_condition` fails. `tui.terminal_title` items are not validated at load, so their names rest on the v0.2 spike's source reading. No naming difference from the prompt.
- Reviews: security-reviewer found no critical/high; typescript-reviewer found 2 high (Enter on empty composer, done lost to a later signal) and 4 medium. Fixed: lost done, paste, stray bell, dropped-notify log, signal failure isolation, title spoofing, OSC 9 not marked handled. Re-review: no critical/high; split-paste low fixed in 3b48beb. Reviews were read-only; no edits to reviewed code while they ran.
- Final verification, all exit 0:
  - `npm run typecheck`: `> tsc --noEmit`
  - `npm run lint`: `> eslint .`, no diagnostics
  - `npm test`: `Test Files 100 passed (100)` / `Tests 596 passed | 2 skipped (598)` / `Duration 8.65s`
  - `npm test` again: same counts / `Duration 8.65s`
  - `npm run build`: `ESM ⚡️ Build success in 19ms`
  - Coverage: statements 87.93%, branches 82.99%, functions 89.97%, lines 92.69%.
  - Security: S8 grep no exec(, execSync(, shell: true; permission flags only in env.ts; forbidden flags absent; no S11 paths. Diff excludes keys.ts, spikes/, docs/spikes/, docs/reviews/, .claude/. git diff --check clean. Canary in notify input-messages, OSC 9 and title text absent from logs, state.json, usage files and protocol responses; token absent from full spawn argv (incl. notify array), every file under the test home and logs.

## What's next
- v0.2.4 (homepage cards, notifications) only when Yaniv asks. Bar later.
- Physical Codex checks below need Yaniv. New sessions need the new argv; restart the daemon first.
- Physical Claude checks from v0.2.2 still need Yaniv. v0.2.1 notifier remains partial.

## Manual checks
- Stub Codex subscription and api-key lifecycle (argv, env-only token, OSC 9/bell/title/Enter/paste, notify done with in-flight ordering, ctx, memory-only reply and copy, exit precedence, canaries): ran headless in temp homes, passed. Built `node dist/cli/index.js status-notify` with bad JSON, input-messages canary and a closed port: exit 0, no stdout/stderr, no home created.
- `cd ~/ai-term && node dist/cli/index.js daemon stop && node dist/cli/index.js` — needs Yaniv: restarts the daemon (stops running agents).
- `cd ~/ai-term && node dist/cli/index.js debug ls` — needs Yaniv: after starting a Codex agent and asking it something, expect running then done and a ctx=N%.
- `cd ~/ai-term && node dist/cli/index.js debug ls` — needs Yaniv: ask the Codex agent to run `curl https://example.com` (sandbox blocks network, so Codex asks); expect waiting permission, then running after approving.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv: Ctrl+E home, press c on the Codex agent, paste in a scratch editor; expect only the last reply.
- Real Codex OSC 9/bell/title emission in our PTY and whether Esc interrupt fires notify: not run (no real sessions); needs Yaniv.

## Gotchas
- The prompt's 64 KB Codex cap contradicted its 256 KB reply; Yaniv chose 2 MiB. S12 and §12.1 updated.
- Enter on an empty Codex composer after done shows running until the next turn ends (prompt's Enter rule; no timer guessing). An Esc interrupt may leave running if Codex sends no notify (unverified).
- Anything rendered in Codex that emits an approval-looking OSC 9 or a bell while running can show waiting; display only. AITERM_STATUS_TOKEN is in every Codex tool's env (as for Claude): a tool can forge done/last reply for its own session only.
- Signals may lag up to the 1 s body deadline behind a slow status request (queue order). Status bodies and signals share one per-session sequence in UsageReceiver.
- ingressStatus now keeps a reply even when its done/Stop event is stale (shared code; applies to Claude too).
- The status-notify CLI child test runs once: several tsx children in parallel starved timing tests. Two pre-existing test races (canary scan vs atomic temp rename; idle interval registered after the socket appears) were exposed by the busier suite and fixed test-only in 4415994.
- No real ~/.ai-term, ~/.claude, ~/.codex, ~/.ssh, keychain, .env or real Claude/Codex sessions accessed. `codex --help` and `codex … features list` (config load only) were run.

## New dependencies
- None. Node http/crypto, xterm's existing parser hooks and tsx (source mode) cover it.

## Concepts introduced
- Terminal signals as status (src/daemon/mirror.ts, codex-status.ts): xterm's parser separates a real bell from OSC terminators and exposes title changes and custom OSC handlers, so the daemon's own mirror can read Codex's notifications without any raw bytes reaching the user's terminal (S15). Only enums and a number are derived; the text is dropped.
- Edge-triggered signals (src/daemon/session-manager.ts codexSignal): a title repaints often, so only a change into a run state counts. That stops a spinner's repeated "Working" from undoing the done that notify reported.
- One queue for two channels (src/daemon/usage-receiver.ts enqueueStatus): HTTP bodies and terminal signals for a session share a sequence and a promise chain, so whatever arrived first is applied first even when an HTTP body is still streaming. The chain never rejects, or one failure would block every later request.
- argv-only config for a CLI (src/daemon/env.ts codexStatusArgs): Codex's `-c key=value` takes TOML, so values built from paths are allowed only from a strict alphabet; anything else drops the feature instead of quoting.
