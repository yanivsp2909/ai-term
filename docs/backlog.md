# Backlog: open suggestions and unfixed findings (2026-10-19 sweep)

Every open suggestion and unfixed review finding recorded in PROGRESS.md (all runs, v0.2 to the live-suite run at
3f2d81c) and docs/architecture.md ("not fixed", "explained", "left as"), checked against the code at 3f2d81c.
Manual checks that need Yaniv are not repeated here: they are one list at the top of PROGRESS.md.

Verdicts:
- **fix now**: small, clearly useful, no new decision from Yaniv. Each gets a failing test commit, then a fix commit.
- **later**: useful, but bigger, needs a machine or account this Mac doesn't have, or needs a decision.
- **drop**: not worth it, with the reason. "D35" is the pinned same-user boundary: another process running as you
  can already do what the finding describes, so closing it alone changes nothing (decision log, not reopened).

`PROGRESS.md:<n>` points at the line in PROGRESS.md as of 3f2d81c.

## Fix now (6)

| # | From | What | Why now |
|---|---|---|---|
| F1 | 2026-10-17 batch 1 suggestion (337d255, PROGRESS.md:536/556); B33 security LOW-3 (a02f191, PROGRESS.md:187) | A running /bisect or /perf A/B can't be stopped: it runs up to an hour (a clone up to 10 minutes per folder) with no key to stop it. | `runTests` already takes an `AbortSignal` and stops the whole process tree; the run only has to pass one through. `x` stops it, the temp copy is removed, the popup says "stopped". |
| F2 | v0.7 gate LOW (fe7fb28, PROGRESS.md:1447); B33 suggestion (1802d90, PROGRESS.md:187); B33 LOW-3 (a daemon that exits mid-clone) | Temp copies and clones a dead daemon left behind (`ai-term-clone-*`, `ai-term-test-*`, `ai-term-deps-*`, `ai-term-diff-*` in the temp folder) are never removed. | A sweep at daemon start, limited to folders AI Term marked as its own, owned by you, whose run is dead. It never follows a link. |
| F3 | live-suite Part C suggestion (3f2d81c, PROGRESS.md:31) | A /study result can't be reopened once its popup is closed: `/study` alone always shows the due list, and `/study <topic>` starts a new paid session. | Every other add-on reopens. Here the due list offers it instead: `r` reopens your last session. |
| F4 | live-suite Part C follow-up review, 2 LOW (PROGRESS.md:93) | `o`/`s` on a made file: when a folder on the way was replaced by a file (ENOTDIR), or the agent's worktree is gone, you see "Session operation failed". A `..` path the jail refuses says "never opened through a link". | Same pattern as the Part C fix: AI Term's own words in place of the masked error. |
| F5 | v0.9+v1.0 gate LOW (c164d05, PROGRESS.md:255) | Queue and dev-server failures are logged without the error's class or code ("Queue check failed"), so the log can't say why. | Add the class and code, nothing else: AddonService.runFailure already does this. |
| F6 | v0.9+v1.0 gate LOW (c164d05, PROGRESS.md:255) | Queue items AI Term couldn't read are kept aside and logged, but the /queue panel doesn't say so. | One line in the panel: how many, and where they were kept. |

## Later (needs a decision, a machine, an account or more than half a day)

### Made files, o and s (decision: what o and s should do with active content)
- `s` saves an SVG exactly as the agent wrote it. From the v1.0 gate (c164d05, PROGRESS.md:255), and documented in the README. `o` already opens it inert. Sanitizing it would change "save a copy", so that is Yaniv's call.
- A meta refresh in an inert HTML copy can navigate. From the v1.0 gate (c164d05). CSP can't block it from a meta tag; stripping tags means parsing HTML. This goes with the open suggestion "should o open .html at all, or show it in Finder" (PROGRESS.md:419): a decision.
- Pin the folder chain for o/s with an fstat-versus-lstat check after open. A security LOW (9742357, PROGRESS.md:419/437). Node has no openat; it needs a design.

### Sandboxes and processes
- A deny-by-default bash sandbox would close the persistence spots that D57/B29 leave writable: shell rc files, LaunchAgents, editor and tmux configs, `~/.npmrc`, `defaults write`, `launchctl submit`. Raised at the v0.7 gate MEDIUM, the v0.8 gate and B29 (PROGRESS.md:1406/1177/1358). It is a large redesign. `~/.local/bin` stays writable at Yaniv's request.
- A process that double-forks inside 250 ms escapes the test-run process tree (still inside the sandbox). So does a server that runs `setsid`. From the v0.7 gate, v0.7.4 and v0.9.2 (PROGRESS.md:1456/1704/1040). Seatbelt has no inescapable process group, so fixing it needs a different mechanism.
- Dev servers, and stdio MCP servers that ignore EOF, keep running after a daemon crash (PROGRESS.md:1039/2527). A start-up sweep of processes, unlike temp folders, needs a pid-and-start-time record and a kill decision; that is riskier than F2.
- The repo's `.git` stays readable to sandboxed tests; hiding `.git/config` makes git fatal (PROGRESS.md:1441).
- The test sandbox relies on `/usr/bin/sandbox-exec`, which Apple deprecated (PROGRESS.md:1558). Watch for it across macOS updates.
- Dependency clones for /perf's before copy, as /bisect has (PROGRESS.md:536). Small, but it's a feature, not a fix.
- The free-port check and the bind for /dev aren't atomic, and DEV_PORT_TAKEN is nearly unreachable (PROGRESS.md:1041/31). Only one refusal text is needed; that's cosmetic.

### Git isolation
- The worktree removal flow's `git status` still reads the repo's config (PROGRESS.md:1827). This prompt says not to touch the worktree deletion logic.
- The private git dir for diffs lacks `core.ignorecase`/`autocrlf`, so a case-only rename on APFS shows as modified plus untracked (PROGRESS.md:1822). It also doesn't read `info/exclude`. Both are by design: the repo's config is never read. A fix means probing the file system the way git init does.
- The index copy has no size cap (PROGRESS.md:1446).
- gh picks the base repo from agent-writable config. `http.proxy` and `sslVerify` aren't pinned, and `core.sshCommand` is ignored (PROGRESS.md:1740). This is gh's design; changing it needs a decision.

### Secrets and redaction
- A ZWJ or ZWNJ inside a secret survives `cleanNote` and can split a redaction pattern (PROGRESS.md:1869). They are kept on purpose for emoji and Persian/Arabic/Indic text (src/shared/handoff.ts:28). A fix needs redaction on a mapped copy.
- The secret scan's entropy check skips values with a slash, plus hex-only tokens. /review redaction is pattern-based (PROGRESS.md:1706/1741). It is a heuristic by design; tuning it needs real data.
- Stale project-MCP Keychain values remain after an entry is edited (hash-bound, unusable) (PROGRESS.md:2530). Removing them touches the Keychain flow.

### Linux, Windows and the desktop app (no machine or decision here)
- Every Linux and Windows "explained" item: bwrap tmpfs size, filesystem sockets, the Secret Service having no per-app access, the Linux network shared with bash, /reverse on Linux, `notify-send` with no click, Windows notifications, owner checks and `O_NOFOLLOW` on Windows, the Credential Manager blob limit, net and CPU stats, PID reuse with taskkill, UNC paths, Constrained Language Mode, the case of `~`, node-pty quoting, trusting a PATH `git.exe`, and the D59/D60 decisions still Proposed (PROGRESS.md:1169–1341). There is no Linux or Windows machine here, and CI is off by Yaniv's choice.
- Desktop: a missing preload leaves a blank window; launcher.c's failure line doesn't name its step; build-notifier doesn't restore `previous.app`; the packaged app adopts any daemon speaking the same protocol; the packaged binary honors `--inspect` (reverted, D35); hardened runtime; universal build; ligatures and vibrancy (PROGRESS.md:2183–2188/2224/2315). It needs a desktop step and Yaniv's eyes.
- The theme re-probe can garble one escape between two raw chunks (bar off) (PROGRESS.md:2184).

### Tests and tooling
- Timing tests with fixed waits (split hold, output-events throttle, agent-send Enter delay, v093-perf, homepage-stats) need fake clocks inside those modules (PROGRESS.md:600).
- Flakes to watch: gate-v06 reserve, v091-queue "after a named agent", LSP startup deadline, gate-silent, PTY tests under heavy load (PROGRESS.md:299/558/649/2554/1182). None reproduces on demand.
- Under coverage only, `Screen.fit` is quadratic on a 16 KB bash summary (PROGRESS.md:2157).
- More tier 2 checks as stub-driven tier 1 checks: LSP with a stand-in server, /mcp with a tiny local server (PROGRESS.md:31).
- There's no DST test for the queue's `nextLocalTime` (PROGRESS.md:1106).
- The two opt-in native Keychain tests are never enabled (PROGRESS.md:2709). They would touch Yaniv's Keychain.

### Features and design questions
- Inventory add-ons not built: /network, /deploy, /migrate, /scaffold, /launch, /benchmark, /triage, /hook, /database, /sdk (PROGRESS.md:636).
- A `/model` account column; an opt-in Codex `cli_auth_credentials_store`; Electron Node mode for the dev app's daemon (PROGRESS.md:1973/2183).
- `/usage` broken down by model or agent (PROGRESS.md:3160); resume from the transcript (PROGRESS.md:2558).
- Asks that run code confirming with y rather than ⏎ (kept on y on purpose, PROGRESS.md:945).
- homepage.ts is far over the 800-line guideline (128 KB). Splitting it is a refactor of its own.
- A trigger that fires while the queue is off is lost; `after` matches by title (PROGRESS.md:1102–1103). Both were the agent's own reading when the spec was cut off, so they need Yaniv's call.

### Needs Yaniv (not code)
- PID 83116, a packaged `AI Term.app` from build/desktop/dist started by an old smoke run, is still running (PROGRESS.md:1949). It may hold your state, so it is stopped only by you: `cd ~/ai-term && kill 83116`.
- Old temp folders from earlier runs without AI Term's mark (`/tmp/ai-term-native-baseline.*`, `$TMPDIR/ai-term-desktop-*`, `$TMPDIR/ai-term-b31-batch1-*`). F2 never touches unmarked folders: `cd ~/ai-term && ls -d "$TMPDIR"/ai-term-desktop-* /tmp/ai-term-native-baseline.*`, then remove them if they're yours.
- OpenAI's terms page on rate limits (unread: 403 to automated fetches) (PROGRESS.md:1952). Whether Codex's keyring keeps accounts apart per `CODEX_HOME` (PROGRESS.md:1962).

## Drop (not worth it, with the reason)

- **D35 same-user boundary.** Each of these needs a process already running as you, which D35 accepts. Closing one alone changes nothing.
  - races between a check and a rename, write or diff (restore, merge, undo, the private git dir, the realpath before an open, an agent-rewritten setup);
  - `ps -E`/`ps eww` showing a status token, the app-control token or a key in an agent's start env;
  - an agent that reads checkpoint.key;
  - the Keychain ACL trusting node;
  - another macOS user answering on Ollama's port;
  - hard links in the agent's folder;
  - Claude's Bash children inheriting AITERM_STATUS_TOKEN.

  (PROGRESS.md:1438, 1737, 1783, 1786, 1830, 1831, 1519, 2188, 3021, 3073, 3575, 1866, 2532)
- **/commit's glob pathspec** (v1.0 gate). It couldn't be reproduced: runGit sets GIT_LITERAL_PATHSPECS=1, and a guard test pins it.
- **Bash background jobs outlive their tool call** (v1.0 gate). This is by design: agent bash is meant to start servers.
- **/remote residuals in §12.28.** A forged local header grants nothing; a cookie is shared across ports of one host; a serve entry left by a SIGKILLed daemon is cleared at its next start; Don't ask can be switched on later inside an agent. All are documented and accepted at the gate.
- **The test sandbox's denial wording is a heuristic both ways** (PROGRESS.md:1443). A misread only changes the note shown, never what is allowed.
- **Budget and usage edge cases.** These are documented in architecture §9/§12.13 and each is bounded or errs toward the worst case (PROGRESS.md:1865–1868, 2142–2144, 2630, 2932):
  - a usage record dropped at the 1,800-a-minute cap still releases its hold;
  - one grant covers the SDK's two retries;
  - a hold is re-armed while an agent waits on you;
  - a lost settle books the worst case;
  - a booking that finishes after close still writes;
  - turning taskCost off doesn't stop running sessions from reporting.
- **Display-only spoofs.** These all follow from showing what an agent prints (PROGRESS.md:1867, 1451, 1359):
  - a fake limit badge an agent prints;
  - a prompt-injected handoff note (the new agent starts in Ask);
  - a prompt-injected diff that steers its own review;
  - a fake "Operation not permitted" line.
- **Restored files get 0644/0755; `/compact`'s summary is a user message; a review is priced at ⏎** (PROGRESS.md:1445, 1452, 1453). Each is a design choice.
- **Logged once, by design** (PROGRESS.md:1448, 1449, 1450, 3072, 3529–3537). Each is pre-v0.3 or cosmetic, and the real failure is already shown elsewhere:
  - any `gh auth status` error reads as logged out;
  - an unreadable transcript exports as cut;
  - a stale `+N −M` stays after a failed refresh;
  - engines.ts says "not found in PATH" for any resolve error;
  - store close failures;
  - status bodies dropped without a log line;
  - stage-specific spawn logs;
  - the importEnv rollback message;
  - the fsync after a rename;
  - Foundry readiness on any 2xx.
- **/brain explained items.** Plans don't share a scan (each is bounded); UNC homes don't get the brain; a prompt injection in summaries is only reduced by quoting (PROGRESS.md:818–827).
- **MCP caps and v0.4 limits.** These are deliberate limits written down as gotchas (PROGRESS.md:2530, 2728–2733, 2839–2842):
  - 64 project servers;
  - a project server shadowing your own;
  - approval showing value names;
  - a failed stop being logged;
  - the extension parser's limits;
  - token estimates as bytes/3;
  - a subagent model on the parent's key.
- **Already fixed since it was written.**
  - AGENTS.md's "Until then, none exist" is gone.
  - package.json is 1.0.0.
  - The /worktrees panel shows its load error (src/client/tui/worktrees-panel.ts:32).
  - /compact shipped in v0.7.4.
  - The daemon budget ledger shipped as B25.
  - Prices became per provider in B27.
  - The live TUI theme re-probe shipped.
  - Tier 2 is prepared.
- **Historical notes.** These describe a past run, not the code:
  - cut-off prompts;
  - the `ui.ts` plan reference;
  - RTK.md;
  - commit 2aca570 not building on its own (history is never rewritten);
  - reviewer thread limits;
  - skills run as agents;
  - B12/B21 not recorded.
- **`/retry` of a pre-v0.4 Claude key session on `sonnet`** (PROGRESS.md:2531). Suspected, never reproduced, and such records are gone.
- **node-pty's "Unhandled pty write error"** (PROGRESS.md:2011). It comes from inside node-pty's write queue, which has no hook.
- **The bar spike's vim exit** (PROGRESS.md:3562). The bar is off by default and the Terminal.app trace is on Yaniv's manual list.
