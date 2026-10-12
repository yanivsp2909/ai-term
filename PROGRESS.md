# PROGRESS

## Checkpoint
Last commit: e4d7233 docs: record v0.1.6f verification and manual checks
Roadmap step: v0.1.6f done; v0.1.6 still partial (its live reply and effective-permission checks need Yaniv)
Branch: main, started from 08de6d5 (clean, 162 tests). This handover is committed last; its own hash is in git log.

## What works
- v0.1.6f fixes B2 and B3 from the v0.1.6 live checks, per D40 and D41 (both in the architecture decisions log):
  - Every Codex session's argv starts with `--no-daemon`, exactly once. Codex rejects a duplicate, so only `src/daemon/env.ts:35` adds it, and the Foundry path no longer does.
  - `AZURE_OPENAI_API_KEY` passes through to Codex account sessions. The other 7 Codex variables stay stripped, and the dormant Foundry key row still strips Azure (a key session gets only its own key, D16).
  - Ask passes explicit ask flags: Claude Code `--permission-mode=default`; Codex `--ask-for-approval=on-request --sandbox=workspace-write`. Don't ask is unchanged. All permission flags come from the `PERMISSION_ARGS` table in env.ts.
- Every argv `buildArgs` emits parses in the installed Claude Code 2.1.296 and Codex 0.160.1.
- Commits, RED then GREEN: 8515293/b11d286 (no-daemon), 77ac368/19a1dfd (Azure), 6f3ca80/d730815 (Ask). Then cfb4da6 (D40/D41 docs), 804a2a0 (spawn-level argv check), e4d7233 (verification docs).
- The code reviewer and security reviewer found no CRITICAL, HIGH or MEDIUM issues. Their LOW doc notes were fixed.
- Required final output:
  - npm run typecheck: tsc --noEmit, exit 0
  - npm run lint: ESLint: No issues found, exit 0
  - npm test -- --coverage: Test Files 30 passed (30); Tests 165 passed (165)
  - coverage: statements 85.19%, branches 77.09%, functions 85.92%, lines 91.45%; env.ts 100% branches
  - npm run build: ESM Build success in 10ms, exit 0
  - git diff --check 08de6d5..HEAD: no output, exit 0
- Evidence (CLI facts, greps, TDD table, exact manual commands): docs/testing/v0.1.6f-fixes.md.

## What's next
- Yaniv runs the v0.1.6f manual checks below. When the replies and effective Ask permissions pass, mark v0.1.6 done; then v0.1.7 (login/keys). Do not start v0.1.7 before that.

## Manual checks
- Flag spellings in the installed CLIs: ran. All exist. Claude's help lists `manual`, and the binary maps it to the canonical `default`.
- Parse check of every emitted argv (Claude ask/dontAsk, Codex ask/dontAsk, Foundry ask): ran, all accepted.
- `codex login status` with and without `--no-daemon`: ran. Same result. The flag works only before the subcommand. With an empty temp `CODEX_HOME`, both forms say "Not logged in" while the logged-in daemon runs, so the status command reads its own env's `CODEX_HOME`. The engine check is unchanged.
- Mutation check of the spawn-level argv assertion (ask flags removed; `--no-daemon` doubled): ran, it failed both times, then env.ts was restored from git.
- Codex account reply with no Azure error (B2): needs Yaniv.
- Codex effective Ask, `/status` shows on-request + workspace-write instead of YOLO (B3): needs Yaniv.
- Claude Ask mode shows the normal ask mode, plus the `ok` reply after you answer folder trust: needs Yaniv.
- S6 manual env check, names only (`env | cut -d= -f1 | grep ...`): needs Yaniv.
- Don't ask unchanged (optional): needs Yaniv.
- Terminal title/palette/cursor after Ctrl+E and `/exit` (carried over from v0.1.6): needs Yaniv.

## Gotchas
- Codex errors with "the argument '--no-daemon' cannot be used multiple times". Never add the flag anywhere but env.ts:35.
- `--no-daemon` is a top-level Codex option: `codex --no-daemon login status` works, `codex login status --no-daemon` exits 2.
- The shared Codex app-server daemon on this Mac runs 0.162.1 while the CLI is 0.160.1. That's the "started elsewhere" server D41 avoids.
- Claude 2.1.296 accepts `--permission-mode=default` but its help shows only `manual`. If a later Claude drops the `default` alias, Claude sessions fail to start with an invalid-choice error. Then switch PERMISSION_ARGS to `manual` (same mode).
- Codex 0.160.1 adds `--approve-for-me` (automatic approval review). We never pass it, and the exact-argv tests would catch it. It isn't on the architecture's "never passed" list; add it if Yaniv wants.
- `codex login status` prints a masked key hint. One manual comparison this session printed that masked hint into the session transcript (no file, commit or doc); later checks printed only the leading phrase. Always filter that command's output.
- The Bash tool runs zsh: an unquoted `$var` is one argv element, not word-split. That made one early check pass "login status" as a Codex prompt.
- "Key rows are unchanged" was read as unchanged behavior: the Foundry key row still strips Azure. Tests pin it.
- An idle `codex --no-daemon` TUI was open in ~/ai-term during this session (0% CPU, no file changes; its v0.1.6 handover was already committed). Close it before the next agent starts.
- The prompt text ended mid-sentence in SECURITY CHECKS ("Add it to the canary test with a fake"). Nothing after that was visible, so the handover followed AGENTS.md.
- Branch coverage is still below 80% (77.09%); statement/function/line coverage is above.

## New dependencies
- None.

## Concepts introduced
- Shared background server (src/daemon/env.ts, `--no-daemon`): by default the Codex TUI attaches to one long-lived app-server process that may have been started by another app with a different env and version. A session on that server doesn't use the env and `-c` settings AI Term built. `--no-daemon` makes each session run its own process, so the recipe really applies.
- Flags beat config (src/daemon/env.ts, `PERMISSION_ARGS`): a CLI reads your config file first, then command-line flags override it for that run. Passing explicit ask flags pins Ask behavior whatever your own config says (for example YOLO), without AI Term reading or editing that config.
- Mutation check (tests/agent-spawn.test.ts): to prove a test guards a fix, you break the fix on purpose and watch the test fail, then restore it. Here, removing the ask flags or doubling `--no-daemon` turned the spawn test red.
