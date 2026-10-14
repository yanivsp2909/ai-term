# PROGRESS

## Checkpoint
Last commit: 027521c fix: deny only CLI and shell state names, not extensions named like git-log or analyze-logs
Roadmap step: v0.4 release gate — done. **v0.4 is closed** on automated evidence; only Yaniv's real-key and real-terminal checks below remain, as for v0.2 and v0.3.
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at 5896209 after `git pull --ff-only` (already up to date). Baseline 173 files / 1108 passed / 2 opt-in Keychain skips. Final 183 files / 1144 passed / the same 2 skips, twice in a row. Session: Claude Code, Opus 5.5.
Prompt vs code:
- "its cost shows on the card": the homepage card shows no cost (status, model, ctx %, activity, auth). Cost shows on the agent's own turn lines, which the card's preview mirrors, and in Usage. The exit check verifies those two and that they agree.
- `security-bounty-hunter` and `engineering:code-review` are skills, not agent types: they ran as fresh general-purpose agents told to load them. Seven fresh reviewers in all (keys, approval, jail/reader, money, MCP, silent failures, whole v0.4 diff), then one fresh reviewer on this session's own fix diff.
- The checkpoint otherwise matches the code. The plan's `ui.ts` is still stale (`app.ts` + `screen.ts`).
- Mid-session, Yaniv asked for the cap fix to size each request's output allowance to what is left, not just to send a 16k limit; done as asked (below).

## Gate findings (each: failing test commit, then fix commit)
No CRITICAL. Reviewers ran read-only on 5896209 with temp homes, stub models, stub vaults and local stub servers only.
- **HIGH (approval):** MCP call arguments, `task` job prompts and project MCP server previews reached the terminal raw: C1 controls (U+009B CSI), OSC 52 and bidi overrides could hide the real target or make a Don't ask job read as Ask. `AgentApp.approve` now passes every title and body through `visible()`. db69ccb → ce3f422.
- **HIGH (reader, D48):** a cloned repo's relative symlinks in `.claude/agents` / `.claude/commands` reached `~/.bash_history`, `~/.zsh_history`, `~/.pgpass`, private keys and any home Markdown; `task` or `/name` sent them to the model. Project roots now never resolve outside the project's real folder; shell history/sessions, `.pgpass`, `.s3cfg`, `.boto`, `.my.cnf`, `id_*` keys denied for user roots too. 33fb114 → 70891ec; over-broad first version (refused `git-log`, `analyze-logs`) caught by the fix review: 82640a4 → 027521c.
- **HIGH (money):** no `maxOutputTokens` was ever sent (the shipped catalog has no limits), so one checked request could cost more than the $5 cap (128k on Claude). Now, as Yaniv specified: before each request (parent or subagent) the allowance is the largest `maxOutputTokens` whose worst case (input + allowance × output price; reasoning is output under the same allowance) fits what's left of the run cap and of every budget, never above the model limit; under 1,000 tokens → pause; unknown price → pause, then the model's own allowance. d9085ed → 35ef2de, f4b5618 → 858526b.
- **HIGH (money):** a request that failed mid-stream was billed but counted $0. It now counts its worst case (only after the provider answered: `start-step`). d9085ed → 35ef2de.
- **HIGH (correctness):** a 240-character cut or a last-four suffix could split an emoji; the lone surrogate failed catalog validation and every agent turn failed (MCP: until daemon restart). `src/shared/text-cut.ts`. f381d20 → c25eae9.
- **MEDIUM (money):** a finished request without usage counted $0 → worst case plus a note. Usage the daemon never took (failed post, missing credential) keeps counting in the run's budget check, with a note. d9085ed → 35ef2de.
- **MEDIUM (approval):** a write over a file larger than 1 MB showed "no change" and truncated it → refused. Write/edit approvals hid changed lines past 200 → every line is paged. db69ccb → 27a9257, 4cf521b.
- **MEDIUM (D50/S22):** `/send` typed into an open agent popup; its Enter saved and authorized an MCP server. The popup reports waiting · question, then done. 7191c2e → 5c7f400.
- **MEDIUM (reader):** repos under `~/Projects`, or in folders named like `logs-viewer`/`history-app`, lost their extensions and `.mcp.json`; projects outside the home lost theirs. Fixed with the reader change. 33fb114 → 70891ec.
- **MEDIUM (correctness):** a folder with a ZWJ emoji or soft hyphen made every turn fail (extension/MCP queries refused the cwd validCwd accepted). c8baa41 → 994aaf3.
- **MEDIUM (MCP):** daemon shutdown didn't wait for MCP servers; `mcp_call` failed with a bare error after any Esc/Ctrl+K; `/cd` left the old folder's servers running; a failed Keychain rollback stopped at the first name and logged nothing. a5e5b85 → 22b7f8e.
- **LOW (keys):** a key streamed across two deltas reached the screen and the last reply (needs the model to know the key). Stream redactor. 4cedde8 → 6f24e13.

## Not fixed, with reasons
- **Budgets across concurrent sessions** (money MEDIUM): each agent reserves its in-flight worst case only in its own process, so two agents near the same daily budget can together cross it; a cut-off request's worst case never reaches Usage. Needs the daemon to hold reservations (a protocol change); proposed for the next step. A single agent never crosses a budget.
- **Daemon crash or SIGKILL leaves stdio MCP servers that ignore stdin EOF running** (MCP MEDIUM): a clean `ai daemon stop` now stops them all; killing persisted process groups at the next start risks killing reused pids. Most servers exit on stdin EOF.
- **A deployment whose real output limit is under 16k refuses requests** until its catalog model is marked (`/settings` → `m`) or the catalog refreshed: the price of never sending an unbounded request. README says so.
- **Reasoning billed outside output:** none of the three wired APIs does; if a Foundry Chat Completions deployment reported reasoning outside completion tokens, cost would read low. Manual check below compares one Grok/Kimi turn with Azure's numbers.
- **MCP LOWs:** approvals/overrides cap at 64 project servers; a project server shadows an own server of the same name (still needs approval, preview says "this project"); stale project Keychain values after an entry edit (hash-bound, unusable); project approval shows value names, not values (§12.8 "all values secret"); a failed MCP stop is only logged (suspected, not reproduced).
- **`/retry` of a pre-v0.4 Claude key session with model `sonnet`** starts the agent on `sonnet`, which the provider refuses (visible HTTP 404; suspected, not reproduced). Pick a model with `/model`.
- **Hard links in the agent's folder** (jail review): read/edit follow a hard link to an outside file; only a same-user process can make one (D35, S18's accepted boundary). Not reported as a finding.
- **Pre-existing:** `Screen.fit` is quadratic on a 16 KB bash summary (~1.5 s); the review test for it times out only under coverage, at 5896209 too.

## Exit check (headless, ran)
`tests/v04-exit-check.test.ts` (3280d9a): a temp HOME and temp git repo; the daemon's real SessionManager, usage receiver, facts/extension/MCP routes, D48 reader and McpService with a real stdio MCP server from the repo's `.mcp.json`; the agent in-process with a stub model, driven by typed keys. It loads a skill (`notes`), runs a subagent (`scribe`, which writes NOTES.md) and calls the MCP tool (`stub/echo`), then bash: five typed approvals (job, write, MCP server, MCP call, bash), nothing else runs. The MCP server sees no key. 16,700 tokens reach Usage (Foundry, priced) and the two turn lines add up to the same cost. A turn cap of 2 pauses the third request (card `waiting · question`, Esc sends nothing). Ctrl+K kills a running bash's whole process group within 2 s and nothing more is sent. 3 passed.

## Check output
```
npm run typecheck        > tsc --noEmit                         (exit 0)
npm run lint             > eslint .   ESLint: No issues found
npm run build            ESM ⚡️ Build success in 33ms
npm run build:notifier   Notifier built and ad-hoc signed: /Users/yanivsp/ai-term/build/notifier/AI Term.app
npm test (1)             Test Files  183 passed (183) · Tests  1144 passed | 2 skipped (1146) · 19.39s
npm test (2)             Test Files  183 passed (183) · Tests  1144 passed | 2 skipped (1146) · 20.17s
coverage (src/**)        Statements 87.44% · Branches 81.65% · Functions 88.74% · Lines 94.14%
grep exec(/execSync(/shell: true            none (two RegExp .exec only); the one /bin/sh -c is src/agent/bash.ts
grep sk-                                    only guards (isToolName, model ids, status line) and log redaction; env.ts "ask-for-approval"
grep key variable names                     src/daemon/env.ts and src/agent/main.ts (+ the .env import name table in validate.ts, unchanged since v0.1)
grep ~/.claude, ~/.codex, ~/.agents paths   only src/agent/extensions/reader.ts
grep permission flags                       src/daemon/env.ts only
git diff --check 5896209..HEAD              clean
```
- An earlier full run had one failure in `tests/gate-silent.test.ts` (M2+L6, v0.3, unreadable settings keeps worktrees on); it passed 6/6 alone and in the next four full runs. It touches nothing changed here; recorded as a load-dependent flake.
- verification-loop: build, types, lint, tests twice, coverage, security greps, diff review (fresh reviewer on 5896209..HEAD: one MEDIUM found and fixed, one LOW documented).

## What's next
- v0.5 per the roadmap. From this gate, proposed first: daemon-held budget reservations across sessions; resume from the transcript and opt-in /compact remain open from v0.4.
- Nothing blocks v0.4 except Yaniv's manual checks below.

## Manual checks (everything still open from v0.2 to v0.4, in one sitting)
Setup first (network and your keys on your side; keys stay in the Keychain):
- Catalog refresh: `cd ~/ai-term && curl -fsSL https://models.dev/api.json -o /tmp/models-dev.json && npx tsx scripts/update-prices.ts /tmp/models-dev.json && git diff --stat -- data/usage-prices.json` — commit it if the diff looks right (gives ctx % and real output limits).
- Rebuild and restart (stops running agents): `cd ~/ai-term && npm run build && npm run build:notifier && node dist/cli/index.js daemon stop && node dist/cli/index.js`
- Foundry key re-add (B12): `cd ~/ai-term && node dist/cli/index.js` — /settings, `t` on the Foundry key refuses `Foundry key must be added again to bind its endpoint`; `x`, `a` (re-add), `t` → GPT deployments `ready`, Grok/Kimi/DeepSeek/GLM `chat`.
- Mark models: `cd ~/ai-term && node dist/cli/index.js` — /settings → Foundry key → `m` → your Kimi and Grok deployments → their catalog models (cost lines show dollars, real output limits apply).
- Scratch repo: `cd ~/ai-term && rm -rf /tmp/ai-agent-try && mkdir /tmp/ai-agent-try && printf '# try\n' > /tmp/ai-agent-try/README.md && git -C /tmp/ai-agent-try init -q -b main && git -C /tmp/ai-agent-try add -- README.md && git -C /tmp/ai-agent-try -c user.name=you -c user.email=you@example.invalid commit -qm init`

v0.4, the real exit check (Kimi or Grok through Foundry, one of your skills, one real MCP server):
- Add a server: `cd ~/ai-term && node dist/cli/index.js` — `/mcp add`: a local MCP server you use (absolute executable, JSON argv, env names, masked values), review the paged preview, save.
- The task: `cd ~/ai-term && node dist/cli/index.js` — `/cd /tmp/ai-agent-try`, `/model` → FOUNDRY → your Kimi or Grok `· ai term`, Ask, then `Use the <your skill> skill, ask the <your subagent> subagent to add a line to README.md, and call <your MCP server>'s <tool>`: Enter confirms the job, `y` on each write/MCP call/bash; every approval shows markers, never raw escapes.
- Cost: same agent — after the turn, `turn · … in · … out · $…` lines (one per subagent too); Ctrl+E home → Usage shows the same Foundry spend; compare one Grok/Kimi turn with Azure's token numbers (reasoning billed as output).
- Session allow: `cd ~/ai-term && node dist/cli/index.js` — at the MCP Ask prompt type `a`; the next call to that tool doesn't ask; a fresh agent asks again.
- Project server: `cd ~/ai-term && node dist/cli/index.js` — `/cd` a project with `.mcp.json`, `/mcp`, `d` on one entry: approve once; edit its command, `d` again must ask.
- /mcp popup: `cd ~/ai-term && node dist/cli/index.js` — inside the agent `/mcp`; meanwhile from the homepage `/send <name> hi` is refused (asking a question); Esc closes; Ctrl+K during a slow call and after idle discovery.
- Sized allowance: `cd ~/ai-term && node dist/cli/index.js` — inside an agent `/caps spend 0.02`, ask for a long answer → it goes with a short reply; `/caps spend 0.001` → `● paused · cap reached … what's left fits under 1,000 output tokens`; `/caps spend 5`.
- Budget stop: `cd ~/ai-term && node dist/cli/index.js` — home `b` → daily `0.01` → in an agent `Read README.md and summarize it` → `● paused · budget: today …`, card `waiting · question`; Esc → `■ stopped`; clear the daily budget.
- Turn cap: `cd ~/ai-term && node dist/cli/index.js` — `/caps turns 2`, `Read README.md, then AGENTS.md, then PROGRESS.md one by one` → `cap reached: 2 turns this run · ⏎ allows 2 more`; ⏎; `/caps turns off`.
- Kill switch: `cd ~/ai-term && node dist/cli/index.js` — Ask, `Run sleep 120 && echo finished`, `y`, Ctrl+K → `✗ killed: the request and 1 running command`; then `cd ~/ai-term && pgrep -fl "sleep 120" || echo none` → `none`.
- Homepage stop: `cd ~/ai-term && node dist/cli/index.js` — same command, Ctrl+E home, `s`, `y` → exited; `cd ~/ai-term && pgrep -fl "sleep 120" || echo none` → `none`.
- Deny, Esc, jail, key: `cd ~/ai-term && node dist/cli/index.js` — `Run ls -la` → `n` → denied, no retry; Esc during a long stream → `■ interrupted`; `Read /etc/hosts with the read tool` → `Path is outside the folder`; `Run env | sort` → `y` → no AITERM/OPENAI/ANTHROPIC/key value.
- Card, `c`, notification: `cd ~/ai-term && node dist/cli/index.js` — card `✓ done` with the model `· ai term` and `API key ····last4`; `c` copies the last reply; going home before an approval gives `<name> · waiting: permission`.
- /model inside: `cd ~/ai-term && node dist/cli/index.js` — `/model` lists the key's tested deployments; `/model <other>` switches and the card follows.
- Context: `cd ~/ai-term && node dist/cli/index.js` — after the catalog refresh, `ctx N%` on the card and the bar; mark a deployment as a small-context model (e.g. `phi-4`), `Read PROGRESS.md in full` twice → `context 8x% · /clear or start fresh` once; `/clear`; unmark.
- Anthropic/OpenAI keys (if you have them): `cd ~/ai-term && node dist/cli/index.js` — `/login` → API key; `/model` → `claude-sonnet-5 · ai term` / `gpt-6.1-sol · ai term`, one turn each with a cost line.
- Fallback: `cd ~/ai-term && node dist/cli/index.js` — /settings `r` → `keys run on: the cli` (rows read `· claude code` / `· codex`); `r` back.
- Your skills and agents: `cd ~/ai-term && node dist/cli/index.js` — `/skills`, `/agents`: real Claude/Codex definitions, sources, token totals, a Codex TOML agent; Space one off and back; Enter reads the full file.
- A command: `cd ~/ai-term && node dist/cli/index.js` — inside an agent run one of your commands `/<name> README.md` and check the argument substitution.
- A repo under ~/Projects: `cd ~/ai-term && node dist/cli/index.js` — `/cd` a repo kept under `~/Projects` (or similar) that has `.claude/commands` → they appear in `/skills` → Commands.

v0.2 and v0.3, retained:
- Notifications, permission: `cd ~/ai-term && node dist/cli/index.js` — start a Codex agent and make it ask permission; first time the Allow prompt for "AI Term", then a banner `<name> · waiting: permission` with sound.
- Notifications, done: `cd ~/ai-term && node dist/cli/index.js` — an agent finishing while you're inside it gives no banner; one finishing while you're on the homepage gives `<name> · done`.
- Notifications off: `cd ~/ai-term && node dist/cli/index.js` — /settings, n → `notifications: off`; trigger waiting → no banner; n again.
- Click with ai open: `cd ~/ai-term && node dist/cli/index.js` — two agents, select one; click the other's banner → it's selected, Enter attaches.
- Click with ai closed: `cd ~/ai-term && node dist/cli/index.js` — start an agent with a task, /exit, click its done banner → a new Terminal opens ai inside it; Ctrl+E goes home.
- Click without a banner: `cd ~/ai-term && node dist/cli/index.js debug ls` (copy an id, /exit ai), then `cd ~/ai-term && "build/notifier/AI Term.app/Contents/MacOS/AITermNotifier" --click <id>`.
- Click for a removed agent: `cd ~/ai-term && "build/notifier/AI Term.app/Contents/MacOS/AITermNotifier" --click "$(uuidgen | tr A-Z a-z)" && tail -1 ~/.ai-term/logs/daemon.log` → nothing opens; log says `Notification click for unknown agent dropped`.
- Terminal.app raise: `cd ~/ai-term && node dist/cli/index.js` — with another app in front, click a live agent's banner; Terminal activates, the right ai window rises, the agent is selected.
- Raise probe: `cd ~/ai-term && printf '\e[5t'` — does this Terminal.app window come forward?
- Unknown terminal: `cd ~/ai-term && TERM_PROGRAM=unknown node dist/cli/index.js` — a click selects only and notes `selected <name> from a notification`.
- Bar trace: `cd ~/ai-term && node scripts/diagnose-bar.mjs redraw --trace` — hands off; reply with the BAR_DIAGNOSTIC line.
- Bar feel: `cd ~/ai-term && node dist/cli/index.js` — /settings h → bar on, /shell, `/usr/bin/vim -Nu NONE -i NONE -n` (type, Esc, :q), `/usr/bin/top` (q), a multi-line paste with Ctrl+E inside stays text, vim `:set mouse=a` click/wheel, resize (agent gets rows−1), Ctrl+E home and back; then h → bar off and the next attach is raw full height.
- Bar with the CLIs: `cd ~/ai-term && node dist/cli/index.js` — bar on, type into Claude Code and Codex and go through one permission prompt each (Ctrl+C skips a Codex update notice; never approve an update here).
- Two worktree starts: `cd ~/ai-term && node dist/cli/index.js` — /cd ~/ai-term, Codex, start two agents → `ai/codex` and `ai/codex-2` with distinct folders; then `cd ~/ai-term && git worktree list --porcelain && git status --short && git branch --show-current` (main stays checked out, no agent files) and `cd ~/ai-term && node dist/cli/index.js debug ls` (both branches).
- Non-repo start: `cd ~/ai-term && node dist/cli/index.js` — /cd a plain temp folder, start an agent → it runs there, card says `worktree off: not a git repo`.
- Worktrees toggle: `cd ~/ai-term && node dist/cli/index.js` — /settings w → off/on; /shell stays in /cd; x or /clean on a finished worktree agent keeps the tree (`worktree kept: <path>`).
- Removal, clean: `cd ~/ai-term && node dist/cli/index.js` — let a worktree agent exit, x → `remove worktree and branch ai/<slug>? k keep · d delete`; Esc keeps; again with d → `✓ deleted worktree and branch …`.
- Removal, loss: `cd ~/ai-term && node dist/cli/index.js` — in an exited agent's worktree add a file and a commit, x → `1 untracked · 1 commit not in main`; d only types; the branch name + ⏎ deletes.
- /worktrees and /clean: `cd ~/ai-term && node dist/cli/index.js` — /worktrees lists v0.3.1 leftovers as `✗ Not in AI Term's record` and never offers to delete them; /clean says `kept N worktrees · /worktrees reviews them`.
- Split, open and type: `cd ~/ai-term && node dist/cli/index.js` — Space, ↓, Space, v → two panes, marks gone; type in each; Ctrl+\ moves focus; Ctrl+\ twice sends one Ctrl+\.
- Split, mouse: `cd ~/ai-term && node dist/cli/index.js` — in a split, click the other pane (it takes focus and gets the click); wheel over an unfocused pane does nothing.
- Split, home and reopen: `cd ~/ai-term && node dist/cli/index.js` — Ctrl+E home with both running; v with nothing marked reopens the split.
- Split, vim: `cd ~/ai-term && node dist/cli/index.js` — /shell twice, mark both, v, `/usr/bin/vim -Nu NONE` in one pane; insert, move, :q; the other pane is untouched.
- Split, resize and exit: `cd ~/ai-term && node dist/cli/index.js` — drag the window narrower/wider (below 81 cols: `make the window bigger · ^E home`); /exit one pane's agent → `■ exited · exit 0 · ^\ closes`, Ctrl+\ turns the other into a normal attach.
- /send, idle: `cd ~/ai-term && node dist/cli/index.js` — after an agent shows ✓ done, `/send <name> ` + Tab, paste two lines, ⏎ → `✓ sent to <name> · 2 lines`, one message.
- /send, permission: `cd ~/ai-term && node dist/cli/index.js` — while an Ask-mode agent shows `waiting · permission`, `/send <name> 1` → `<name> is asking for permission, go inside to answer`.
- /send, tool running (gate fix): `cd ~/ai-term && node dist/cli/index.js` — while a Claude agent runs a long Bash command, `/send <name> hi` → `<name> is running a tool and may ask permission · try again when it finishes`.
- /send, trust prompt: `cd ~/ai-term && node dist/cli/index.js` — start an agent with no first message, `/send <name> hi` → `<name> may be asking to trust its folder · go inside first`.
- /retry: `cd ~/ai-term && node dist/cli/index.js` — select a failed agent, /retry → same `ai/<slug>`, old card gone.
- /find: `cd ~/ai-term && node dist/cli/index.js` — `/find error`, ↑↓, ⏎ → that agent selected, preview at the line with `↑ N lines back`.
- /open: `cd ~/ai-term && node dist/cli/index.js` — /open → Finder at the worktree; /open code → VS Code, or the note when `code` isn't on PATH.
- /doctor: `cd ~/ai-term && node dist/cli/index.js` — /doctor → the same lines as `ai doctor`; Esc closes.
- B24 (optional, a throwaway home): `cd ~/ai-term && AI_TERM_HOME=/tmp/ai-b24 node dist/cli/index.js` once and quit, then `cd ~/ai-term && AI_TERM_HOME=/tmp/ai-b24 node dist/cli/index.js daemon stop && printf '{"sessions":[' > /tmp/ai-b24/state.json && AI_TERM_HOME=/tmp/ai-b24 node dist/cli/index.js` → the note names `state.json.corrupt-…`; finish with `cd ~/ai-term && AI_TERM_HOME=/tmp/ai-b24 node dist/cli/index.js daemon stop`.

## Gotchas
- Every request now carries a `maxOutputTokens`: the model's limit (32k at most), 16k when the catalog doesn't know it, or less when the cap or a budget is close. A deployment with a smaller real limit refuses until its catalog model is marked (`/settings` → `m`).
- Near a cap the agent keeps working with shorter replies, and pauses only when under 1,000 output tokens fit. A subagent started while its parent's request is still open gets what is left after the parent's reserved worst case.
- A project's `.claude/*` and `.agents/skills` links must stay inside the project; a shared skill elsewhere in your home belongs in your own `~/.claude` or `~/.agents` roots.
- A failed, usage-less or unconfirmed request counts its worst case for the rest of the run, so a run can pause earlier than Usage suggests.
- Gate tests that need a log file create `<state>/logs` first: the Logger never creates its folder.

## New dependencies (v0.5 app in progress)
- electron: a native desktop window and isolated Chromium renderer are not provided by Node.
- electron-vite: builds the separate main, sandbox preload and renderer bundles.
- react: already present; owns the small search/error UI outside xterm's input path.
- react-dom: mounts that React UI in Electron's renderer.
- @xterm/xterm: displays the PTY as a full terminal rather than rebuilding terminal input/rendering.
- @xterm/addon-webgl: provides the pinned GPU renderer, with DOM fallback.
- @xterm/addon-fit: computes terminal columns/rows from its actual pixel area.
- @xterm/addon-unicode11: already present; shares the mirrors' modern width table.
- @xterm/addon-web-links: detects clickable terminal URLs for the narrow validated browser opener.
- @xterm/addon-search: searches xterm's scrollback without involving ai or its daemon.
- @playwright/test: drives the real Electron window and asserts runtime sandbox behavior.
- node-pty: already present and N-API compatible with Electron; no rebuild dependency added.

## Concepts introduced
- **Sized output allowance (`src/agent/limits.ts` `check`):** a cap only holds if the request can't write past it. So the agent turns "what's left of the money" into "how many output tokens may this request write", subtracts the input it is sending, and passes that number as `maxOutputTokens`. The worst case is then a real upper bound, not a guess.
- **Stream redaction (`src/agent/display.ts` `streamRedactor`):** a secret can arrive split across two chunks of streamed text. Replacing whole secrets first, then holding back only a tail that could still become one, makes chunked output as safe as a whole string without delaying ordinary text.
- **Project containment (`src/agent/extensions/reader.ts`):** a cloned repo is untrusted input, including its symlinks. Checking every resolved path against the project's own real folder stops a relative link like `../../.bash_history` from turning a repo file into a read of your home.

---

## Previous checkpoint (v0.4.4, retained)

## Checkpoint
Last commit: dd87b1b fix: quit immediately when no MCP cleanup is required
Roadmap step: v0.4.4 MCP servers and Codex discovery — done (real servers, Keychain and real-folder checks need Yaniv below)
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at 9ffac2f after `git pull --ff-only` (already up to date). Baseline: 169 files / 1079 passed / 2 existing opt-in Keychain skips. Final: 173 files / 1108 passed / the same 2 skips, twice consecutively. Session: Codex, GPT-6.1 Sol, high. No real daemon was stopped or real CLI folders/credentials/native Keychain entries inspected.
Prompt vs code and decisions:
- The checkpoint matches the code. S21 previously excluded Codex skills/agents; this step adds those two roots without relaxing the CLI config denial.
- The plan's ui.ts reference is stale; actual agent UI is app.ts and screen.ts. RTK.md is still absent.
- Literal source grep already contains four `sk-` redaction/rejection guards and two lines of RegExp `.exec`, not process execution or stored keys. They remain intact. No new such hits, execSync or shell:true were added.
- All configured MCP env/header values are treated as secret; there is no plaintext-value storage option. Masked user input follows the existing transient inward-only key-add socket pattern to the daemon. This is the documented interpretation of the prompt's protocol rule: no outward value, model prompt, transcript, settings or log contains a secret; the inbound secret-entry request necessarily carries the new value once.
- MCP servers are trusted third-party programs with cwd set to the agent folder; this is not an OS sandbox, like existing S19 bash. No new permissions or Don't ask bypass were introduced. HTTPS or loopback HTTP only, no URL query/userinfo/fragment, no redirects or OAuth. Approving an add form authorizes that own server; project servers require separate exact-entry approval.

## What works
- **Task 0 — Codex discovery** (`c153ab6`, S21 docs in `8120cca`): ~/.codex/skills and ~/.codex/agents through the same D48 reader and symlink/deny rules. Markdown and restricted TOML name/description/instructions or imported developer_instructions; operational TOML fields never grant models/permissions. Unsupported definitions skip with a note. Temp-home tests and adversarial alias/race probes ran; no real home inventory was read.
- **Task 1 — own/project MCP list** (`1c6eb19`, `8120cca`): `/mcp`, `/mcp add`, `/mcp remove <name>` on homepage and agent, configurations and switches in AI Term settings only. Bounded project `.mcp.json` goes through the reader, offered without starting anything. Exact command/argv or URL is paged for per-server approval; canonical config/value hash is rechecked on use, changed entries ask again. Unsupported/login servers have fixed notes. No CLI MCP configuration reads or project writes.
- **Task 2 — runtime** (`1c6eb19`, review fixes below): custom bounded stdio transport uses Node spawn with exact argv, fixed minimal env plus only server values, agent cwd, drained stderr and owned process groups. Streamable HTTP uses the AI SDK with an exact-URL/no-redirect guard and cancellation. Servers start on selection, homepage discovery probes stop immediately, agent exit/removal/server-off stop connections, Ctrl+K stops active, idle and pending MCP work including descendants. Errors are fixed lines.
- **Task 3 — secrets** (`1c6eb19`, review fixes below): keys.ts changes only add MCP accounts `mcp:<opaque server-id>:<name>`, payload bound to approval hash. Keychain stubs store values; settings and views have names/last four only (short secrets expose no suffix). Secrets duplicated in public config, including JSON text, are refused before writes. Schema/result/metadata redaction handles raw and JSON-escaped string spellings. Tests prove settings/logs/outward replies exclude values.
- **Task 4 — tools/cost/Ask** (`1c6eb19`, `8120cca`, `0802dd2`): only enabled server/tool names and capped descriptions enter the prompt. `mcp_tools` loads metadata or the selected tool's schema; `mcp_call` requires that schema and always Ask, even in Don't ask. Shows folder/server/tool/arguments; y/n or typed a for this exact configuration/tool/session, no permanent permission. Identity/hash and on/off rechecked after approval. Children share the parent's access/session/cancellation and existing budget reporter. Turning switches off clears stale content on the next turn; first discovery preserves task history. Token totals use the same deterministic UTF-8 bytes/three estimate; model requests still share caps/budgets.
- **Task 5 — popup/docs** (`8120cca`): same Skills/Agents/Commands/MCP popup on both surfaces. MCP rows show source, on/off, description and token estimate; total in header, MCP count/cost in banner. Arrows/Space/Enter/Esc, d explicit discovery, a masked add form; exact approval is typed and paged. README full command/key list, architecture S21/S22 and §12.8, implementation choices in v0.4 plan.

## What's next
- Next roadmap step: v0.4.5 according to the v0.4 plan. No product work from it started.
- Real-server/native-Keychain/real-Codex inventory checks below need Yaniv. Existing transcript resume, opt-in compact, catalog refresh and older manual deferrals are retained in the previous checkpoints.

## Reviews
Fresh high TypeScript, security and final general code reviews ran serially with root paused. Reviewers were read-only, used temporary homes/processes/stub HTTP/vault/model only, and reported concrete requirement/correctness/security findings. Every finding received a failing-test commit before its fix.
- TypeScript HIGH: escaped secrets in structured schema/result — `9718636` → `b4f9839`.
- TypeScript HIGH: escaped secret duplication in public config — `83788c7` → `4d8f0cf`.
- TypeScript HIGH: cancellation before pending selection starts a connection — `f42c7e2` → `72ca4f1`.
- TypeScript HIGH: close before spawn callback leaves child alive — `89fde17` → `b9096e8`.
- Security HIGH: secret inside ordinary JSON text in schema/result — `0dd8392` → `15a1f99`.
- Security HIGH: secret inside public JSON argv — `9b02ebd` → `67d65a4`.
- Security MEDIUM: Ctrl+K skipped idle connections/popup discovery — `810262d` → `69056ca`; `82302ad` supplies the missing extension catalog in the popup test fixture. Final focused test passes.
- Final MEDIUM: first discovery unnecessarily cleared conversation — `c2fcbee` → `0802dd2`.
- Full-suite compatibility regression: non-MCP Ctrl+C quit became asynchronous — `ee12094` → `dd87b1b`.
- Final follow-up verified both final fixes, 2 files / 16 tests, no remaining findings. Prior security fixes were also inspected by the general review.
- Reader probes: denied aliases, .., case/Unicode and final/parent symlink swaps yielded zero denied content reads. Project aliases escaping its folder, hard links and private CLI roots were refused. No further TOML/reader findings.

## Check output
Actual final output (commands exit 0):
```text
npm run typecheck
> ai-term@0.1.1 typecheck
> tsc --noEmit

npm run lint
> ai-term@0.1.1 lint
> eslint .

npm run build
ESM dist/cli/main-7POJ4EDF.js              225.93 KB
ESM ⚡️ Build success in 27ms

npm test -- --reporter=dot (1)
 Test Files  173 passed (173)
      Tests  1108 passed | 2 skipped (1110)
   Duration  17.70s (tests 92%, import 6%, transform 2%)

npm test -- --reporter=dot (2)
 Test Files  173 passed (173)
      Tests  1108 passed | 2 skipped (1110)
   Duration  17.36s (tests 92%, import 6%, transform 2%)
```
- Both full runs are consecutive after the last code fix. Earlier final run found the immediate-exit regression; repaired before restarting the pair. Implementation/review runs used only touched tests.
- The two skips are existing opt-in native Keychain tests, not enabled under the user's no-real-Keychain constraint. Existing passing PTY flood tests emit EIO/EBADF stderr, as in the baseline.
- Source grep: literal CLI extension-root paths occur only in the reader. No new `.exec(`, `execSync(`, `shell: true` or secret-prefix source hits; existing RegExp calls/redaction guards above are the only literal exceptions. No process exec/execSync/shell:true. `git diff --check 9ffac2f..HEAD` clean.
- Restricted source/trees unchanged (env.ts, notifier, worktree deletion, spikes and repo dot-agent folders). keys.ts changes only MCP entry support. All tests use temporary state and stub Keychain; no real ~/.ai-term, daemon stop, credential read, env-file read, external API request or computer use. External network only git pull/push and the authorized package install.

## Manual checks
- Temp-home Codex/TOML/denied aliases/races/project reader caps: ran; allowed definitions listed, denied files never content-read, malformed files skipped.
- Stub stdio/HTTP, exact URL/no redirects, no inherited provider/AI Term env, secret Keychain-only storage/redaction, hash approval/reapproval, server/tool toggles and deferred schemas: ran.
- Stub model Ask/deny/session allow including Don't ask, disabled metadata/token total, changed approval refused, preserved follow-up context: ran.
- Ctrl+K slow call, pre-selection cancel/exit, early spawn, descendants, idle and popup discovery, cleanup before quit: ran with temporary processes/stubs.
- Headless MCP tab/form/read-only/paged approval/token controls and isolated cancel transport: ran.
- `cd ~/ai-term && npm run build && node dist/cli/index.js daemon stop && node dist/cli/index.js` # reload when convenient; this stops running agents — needs Yaniv, not executed here.
- `cd ~/ai-term && node dist/cli/index.js` # /mcp add: enter a local server you use, exact executable plus JSON argv, env names and masked values; review and save — needs Yaniv.
- `cd ~/ai-term && node dist/cli/index.js` # keyed AI Term agent in Ask: ask for that server/tool, load schema, inspect server/tool/arguments, y allows and n denies — needs Yaniv.
- `cd ~/ai-term && node dist/cli/index.js` # at the same tool's Ask prompt, typed a allows for this session; invoke again, then start a fresh session to see Ask again — needs Yaniv.
- `cd ~/ai-term && node dist/cli/index.js` # /cd to a project with .mcp.json, /mcp, d on one entry: approve exact entry once; edit its command/URL, d again must ask — needs Yaniv.
- `cd ~/ai-term && node dist/cli/index.js` # /mcp: arrows/tab, d, token totals, Space server/tool off, Enter read-only details, Esc; Ctrl+K during a slow call and after idle discovery — needs Yaniv.
- `cd ~/ai-term && node dist/cli/index.js` # /skills and /agents: verify real Codex definitions/source/token totals and a TOML agent; no real inventory was inspected here — needs Yaniv.

## Gotchas
- CLI MCP files remain forbidden. Add AI Term's own server explicitly or use a bounded project .mcp.json offered for per-entry approval.
- Browsing caches is not server discovery. Use d to discover explicitly, or let the model select a server; schemas never join the initial prompt.
- Env/header values are all secrets, delivered inward once by the masked add form; no plaintext value option. Keychain payload hash binding prevents redirected configuration from reusing an old value. Own server IDs are opaque, project IDs include canonical folder/name.
- Stdio has host access, no OS sandbox; cwd/env/argv are controlled. Fixed PATH may require an absolute executable path for version-manager installations. HTTP is Streamable HTTP, not OAuth or legacy SSE login.
- Per-session tool allowances are not saved. Server/tool switches are saved, changing selection clears prior bodies; first discovery does not erase the user's task.
- Existing 16 KiB UTF-8 settings cap remains: an oversized configuration/switch set refuses atomically and preserves prior readable settings. Server count 16 own + 16 project, 64 tools/server, 240-char descriptions, 1 MiB transport, 64 KiB project/schema/result/arguments caps.
- Real manual checks must reload the daemon when convenient; this session deliberately left Yaniv's daemon untouched.

## New dependencies
- @ai-sdk/mcp 2.0.74: authorized AI SDK MCP client for negotiation/cancellation/Streamable HTTP. Node/existing AI SDK did not provide this client; its default stdio inherits ambient env/stderr, so a small custom transport enforces the required boundary. Installed with --ignore-scripts; npm reported one low vulnerability, no audit/upgrade network action performed.

## Concepts introduced
- **Approval hash (`src/daemon/mcp/project.ts`, `service.ts`):** approval names the executable configuration and values, not just a friendly name. Re-reading and comparing that hash keeps an edited project entry from inheriting permission.
- **Connection owner (`src/daemon/mcp/runtime.ts`, `service.ts`):** every live agent owns pending requests and server connections. Cancellation registers before asynchronous selection, so stopping the owner also stops work that has not spawned yet.
- **Hash-bound secret (`src/daemon/keys.ts`):** a MCP Keychain account stores its value together with the approved hash. A changed URL/argv cannot use the old value until explicitly approved again; only daemon-owned server requests receive it.
- **Deferred schema (`src/agent/agent.ts`, `src/shared/mcp.ts`):** a short manifest helps the model select a server/tool; a separate tool result supplies that schema only when selected. Discovery updates metadata without dropping task history, while explicit switches clear stale loaded content.
- **Structured redaction (`src/daemon/mcp/runtime.ts`):** redact strings and object keys before serializing, including the JSON-escaped spelling inside ordinary text. Comparing a raw secret against serialized JSON is insufficient because quotes/backslashes change its representation.

---

## Previous checkpoint (v0.4.3, retained)

## Checkpoint
Last commit: 2d905f3 test: select menu entries by their registered name
Roadmap step: v0.4.3 skills, subagents, slash commands and load controls — done (real folders and real-key turns need Yaniv's manual checks below)
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at a55f1de after `git pull --ff-only` (already up to date). Baseline: 164 files passed / 1 failed, 1046 tests passed / 1 failed / 2 existing opt-in Keychain skips. The failure was installed ripgrep's `./a.txt` prefix; reproduced and fixed without changing matching contents. Final: 169 files / 1079 passed / the same 2 skips, twice consecutively. Session: Codex, GPT-6.1 Sol, high.
Prompt vs code:
- The plan's `src/agent/ui.ts` is stale; the actual UI is `app.ts` plus `screen.ts`, both inspected and changed.
- File tools were folder-jailed; existing bash runs `/bin/sh -c` with argv, timeout, keyless env and process-group cancellation, without an OS sandbox (S19). Children inherit this exact permission mode; their confirmation describes Don't ask accurately. No new permission flags or env changes.
- `RTK.md`, referenced by the supplied instructions, is absent in this checkout.
- The requested literal allowlist includes `~/.codex/prompts`, not `~/.codex/skills` or `~/.codex/agents`; the latter remain excluded. No real CLI folder was inspected during development.

## What works
- **Task 1, D48 reader** (`9340a82`, hardened by the review fixes below): one reader under `src/agent/extensions/`, five user roots and four project roots, resolved symlinks under canonical home, logical/resolved case-folded denylist, known credential stores denied, hard links refused before opening, Darwin O_NOFOLLOW_ANY / Linux held directory descriptors, bounded reads and sanitized skip notes. Temp-home tests exercise allowed roots, denied aliases, outside-home symlinks, malformed frontmatter/UTF-8, huge files, total caps and hard links.
- **Task 2, lazy skills** (`2a590ec`): enabled names and descriptions only in the manifest; `skill` loads instructions on use; 240-character descriptions. Disabling an item clears prior conversation bodies before the next message. A failed refresh stops model work until fresh selection is available.
- **Task 3, subagents** (`2a590ec`, `d0ac1fd`, `dc92a81`, `fd0320d`): own conversation and instructions, same folder, permission mode, Ask IO, usage and RunLimits; serial tasks with no recursive task tool. D49 job confirmation shows model, permissions and token/price range, typed Enter runs; child writes/commands still ask in Ask. The approved file/model/prompt are snapshotted; the enabled switch is rechecked. Only the final answer returns. Parent in-flight cost is reserved while the child runs; Ctrl+K kills both conversations and command groups.
- **Task 4, slash commands** (`2a590ec`, `f446f2b`): discovered enabled command/prompt files run as `/name`, literal `$ARGUMENTS` substitution; built-ins win. Esc invalidates pending lookup before dispatch.
- **Task 5, controls** (`9340a82`, `2a590ec`, `2cdea07`): per-item on/off in AI Term settings only, default on for project/user definitions; no extension file edits. Banner shows enabled count and manifest tokens/request. Settings overflow refuses the write and preserves readable prior settings.
- **Task 6, popup** (`2a590ec`): shared `ExtensionsPanel` on homepage and inside the agent; Skills / Agents / Commands / MCP, tab/item keys, persisted Space toggle, read-only full-file view, Esc close; source, description, on/off and estimate per row, total in header. Headless xterm/shared-panel checks ran. MCP is empty until v0.4.4.
- **Task 7, docs** (`2a590ec`, `dc2ddea`, `ebfcd46`): README command/key list, architecture S11 exception plus exact S21 allowlist/denylist and §12.7, implementation judgments in the v0.4 plan.

## What's next
- v0.4.4: MCP, not started in this session.
- Real-folder popup, toggle and real-key skill/task/command checks below need Yaniv. No product implementation from this step is left open.
- Existing v0.4 deferrals remain: transcript resume, opt-in /compact, catalog context-window refresh and older real-key/manual checks retained below.

## Reviews
Fresh high TypeScript and security passes ran serially; root paused repo work during reviews. A required final general code review also ran serially and verified its fixes. Reviewers used temporary homes/mocked models, no real credentials or repo edits. Every concrete finding received a failing-test commit followed by a fix commit.
- TypeScript: auth-related skill directories wrongly denied — `720f2d9` → `e0b78ec`.
- TypeScript: rejected UTF-8 reads bypassed total cap — `77156c8` → `2d8723f`.
- TypeScript: oversized model metadata invalidated catalog — `5654cf2` → `920f1fb`.
- TypeScript: task body/model changed after confirmation — `8713e34` → `d0ac1fd`.
- TypeScript: Esc dispatched a pending slash lookup — `a9cf815` → `f446f2b`.
- TypeScript: parent abort leaked a child reservation — `b7e174e` → `dc92a81`.
- TypeScript: inherited key-reader test expected arrows to be dropped — `8a4ced5` → `84462d6`.
- Security HIGH: symlink aliases opened known credential stores — `acd0b93` → `3971710`.
- Security HIGH: hard-link alias opened a denied auth file — `d199d33` → `4351b99` (test observes zero content reads).
- Security MEDIUM: valid JSON-escaped files/500 multibyte rows exceeded reporter response cap — `d1ee4b7` → `5b08a5b`.
- Security MEDIUM: toggles made UTF-8 settings unreadable — `8c9a462` → `2cdea07`.
- Final review MEDIUM: refresh failure retained stale disabled bodies — `642624d` → `d37f88c`.
- Final review MEDIUM: task confirmation misreported inherited Don't ask — `a3d8512` → `fd0320d`.
- Baseline ripgrep prefix — `99a8005` → `8cc62db`; final full-run fixed-index menu assertion — `973ca7b` → `2d905f3`.
- Final follow-up: no remaining findings in these fixes, 18 focused tests green. Security's temp symlink / `..` / case / Unicode / parent and final-component swap probes found no other content opens.

## Check output
Actual last output lines (all commands exit 0):
```text
npm run typecheck
> ai-term@0.1.1 typecheck
> tsc --noEmit

npm run lint
> ai-term@0.1.1 lint
> eslint .

npm run build
ESM dist/cli/chunk-AP5EDM2O.js             1.26 KB
ESM ⚡️ Build success in 38ms

npm test -- --reporter=dot (1)
 Test Files  169 passed (169)
      Tests  1079 passed | 2 skipped (1081)
   Duration  16.83s (tests 93%, import 5%, transform 2%)

npm test -- --reporter=dot (2)
 Test Files  169 passed (169)
      Tests  1079 passed | 2 skipped (1081)
   Duration  17.02s (tests 93%, import 4%, transform 2%)
```
- The two skips are the existing opt-in native Keychain tests; not run under the no-Keychain limit. The existing PTY flood test still prints EIO on stderr while passing (also present in baseline).
- While implementing, only touched tests were run; the final full-suite failure was the inherited fixed menu index, repaired before the two consecutive green runs.
- Source grep: literal `.claude/`, `.codex/`, `.agents/` paths only in the reader; no filesystem-open calls to them outside it. No `exec(` / `execSync(` / `shell: true` process calls (the two `.exec` hits are existing RegExp calls). `git diff --check a55f1de..HEAD` clean.
- Restricted files/trees unchanged; no package/dependency changes, no real home state, daemon stop, external API call or computer use. Only git pull/push use external network.

## Manual checks
- Temp-home reader security / metadata caps / persistent toggles: ran; allowed files loaded, denied aliases skipped, overflow settings preserved.
- Stub skill listed then lazy-loaded, disabled history cleared, refresh failure prevented calls: ran; captured provider prompts contain only enabled metadata before use.
- Stub task Ask / own instructions / final answer / shared costs and caps / jail / Ctrl+K: ran; write asked in parent, command killed, no subsequent model call, reservation returned to zero.
- Stub slash literal arguments / built-in precedence / Esc lookup cancellation: ran.
- Headless popup tabs / toggles / full-file scrolling / banner estimate: ran.
- `cd ~/ai-term && npm run build && node dist/cli/index.js daemon stop && node dist/cli/index.js` → reload new daemon when convenient (this stops running agents) — needs Yaniv; not executed here.
- `cd ~/ai-term && node dist/cli/index.js` → `/skills`, confirm real definitions/source/token totals; `/agents`, left/right tabs, Enter full file, Esc — needs Yaniv.
- `cd ~/ai-term && node dist/cli/index.js` → `/skills`, Space one skill off, close/reopen and verify on/off plus lower total; restore it after checking — needs Yaniv.
- `cd ~/ai-term && node dist/cli/index.js` → select a keyed AI Term model in Ask, start/open it, `/skills`, choose a known enabled skill, ask `Use <skill-name> to review README.md`; observe skill load and turn cost — needs Yaniv.
- `cd ~/ai-term && node dist/cli/index.js` → inside that agent `/agents`, choose `code-reviewer` if present, ask `Use code-reviewer to review this small diff`; typed Enter confirms job, y/n answers any command/write in Ask, observe child costs/final answer; Ctrl+K during a child command stops it — needs Yaniv.
- `cd ~/ai-term && node dist/cli/index.js` → inside the agent `/skills`, Commands tab, pick an enabled real command name; run `/<name> README.md` and verify argument substitution — needs Yaniv.

## Gotchas
- Allowlist is exact; `.codex/skills` and `.codex/agents` are intentionally not roots. Symlink targets must stay under canonical home and pass the denylist; hard-linked files are skipped rather than attempting to discover every other alias.
- Known credential stores are denied even if an innocuous command filename aliases them. Reader is fail-closed on unsupported platforms; currently Darwin/Linux safe opens are supported.
- Supported metadata is scalar name/description/model plus YAML block descriptions; unrelated nested metadata is ignored. Unsupported frontmatter is skipped with a one-line note. Limits: 64 KiB/file, 1 MiB/scan (including rejected reads), 500 items, 4,000 entries, depth eight, 100 notes.
- Project source wins duplicate names, then Claude, Codex prompts, shared. IDs follow logical path and kind; moving a source resets its saved toggle.
- Estimate is UTF-8 bytes / three, not a tokenizer measurement; it covers manifest names/descriptions, not tool schemas/bodies. Commands contribute zero until run. Disabling an extension clears conversation before the next message; refresh failure refuses the turn.
- Model selection is limited to models available to the same parent key; unknown/ambiguous aliases fall back to parent. Serial child tasks cannot recursively task. D49 job confirmation remains required even under Don't ask; child tools inherit that mode accurately.
- In-process daemon fixtures must inject the temporary home into ExtensionService. Changing only a spawned child's HOME does not change the parent daemon's homedir; tests must never discover the real folders accidentally.
- Settings serialize to at most 16 KiB including newline; an overflowing toggle reports failure without replacing the prior file. Agent query cap is 2 MiB for accepted JSON-expanded responses.

## New dependencies
- None. A bounded parser for the shared extension fields was enough; no YAML/frontmatter dependency added.

## Concepts introduced
- **Discovery boundary (`src/agent/extensions/reader.ts`):** discovery starts from literal roots and turns validated files into IDs. Opening a file later means selecting a validated bounded snapshot, not accepting a path from the model; symlinks and hard links require separate defenses.
- **Lazy manifest (`src/shared/extensions.ts`, `src/agent/agent.ts`):** names and short descriptions help the model choose a skill without sending every body. The body becomes a tool result only on use, so toggling selection also clears old bodies from history.
- **Child conversation (`src/agent/agent.ts`):** a task has its own history and file instructions but shares the parent's folder, approvals, usage and cancellation. Only its final answer enters the parent history, keeping intermediate work out of that context.
- **In-flight reservation (`src/agent/limits.ts`, `src/agent/agent.ts`):** the parent's request can still be waiting for usage while a child spends. Holding its worst-case amount closes that gap; releasing the captured amount after abort avoids a stale reservation.
- **Shared popup and byte caps (`src/client/tui/extensions-panel.ts`, `src/shared/validate.ts`):** both terminal surfaces use the same panel actions and rendering. File, settings and transport limits count serialized UTF-8 bytes so Unicode and JSON escaping cannot make a supposedly accepted value unreadable later.

---

## Previous checkpoint (v0.4.2, retained)

## Checkpoint
Last commit: 1b27e49 fix: budgets count a fast agent loop, dense text and odd deployment names
Roadmap step: v0.4.2 every key, exact cost, hard limits — done (real-key turns and the catalog refresh are Yaniv's manual checks below)
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at df05a3c after `git pull --ff-only` (already up to date). Baseline 161 files / 1012 passed / 2 opt-in Keychain skips. Final 165 files / 1047 passed / same 2 skips, twice in a row. Session: Claude Code, Opus 5.5 (the prompt was addressed to Codex; run here as the two Codex-addressed prompts before it were).
Prompt vs code:
- **Context windows aren't in the catalog yet.** `data/usage-prices.json` (fetched 2026-10-12) was trimmed to prices only. `trimPrices` now keeps Models.dev's `limit.context`/`limit.output`, but downloading a fresh catalog needs network beyond git/npm, which this step's limits forbid. Until Yaniv refreshes it (manual check 1), context % and the 85% warning stay quiet and no output limit is sent. Nothing is guessed.
- **"Test each non-GPT deployment with a tiny request before offering it":** the Foundry test already did exactly that (Chat Completions `ping`, 16 tokens, after the Responses refusal) and called a success "not a chat model" (Codex's view). It now records `chat`; older saved results mean the same. Re-testing (`t` in /settings) refreshes the label.
- **"/compact or start fresh":** AI Term's agent has no /compact (a summarizing compaction spends tokens on its own: D49/D55 would make it opt-in, a later step). Its line says `/clear or start fresh` (new: `/clear` forgets the conversation); CLI cards say `/compact`.
- **"Session budget"** is taken as the per-run spend cap (with the turn cap, D53); the daily, weekly and monthly budgets are all enforced.
- **"Turn"** for the turn cap is one request to the model (a reply or a tool round): the unit a runaway loop multiplies.
- **A limit pause shows as `waiting · question`** on the card (the reducer's existing reasons), which also makes /send refuse it.
- The daemon's fixed-message allowlist was missing v0.4.1's AI Term start/resume messages (they reached the homepage as "Session operation failed"); fixed with this step's new ones.
- One intermediate commit (2aca570) doesn't build alone (its protocol/validator lines landed in 437b54b); history wasn't rewritten.

## What works
- **Every key on AI Term's agent** (2aca570): Foundry GPT (Responses) and non-GPT (Chat Completions) deployments, Anthropic (api.anthropic.com, `x-api-key`), OpenAI (api.openai.com, bearer). One module each behind one fetch guard (own host only, own header only, no redirects); provider error text never shown. D47: every key routes to the agent; `keys run on: the cli` sends them to their CLIs. Anthropic/OpenAI rows offer the catalog's chat models.
- **Facts route** (437b54b): `POST /v1/agent/ai-term` (engine-bound status credential, 4 KiB, 1 s, 200 JSON or 204): wire, context/output limits, price (Foundry: override, else the marked catalog model, else its name), today/week/month spend, budgets, caps, the warning switch.
- **Exact cost per turn:** `turn · 12.3k in · 4.0k cached · 812 out · 310 reasoning · $0.0123 · run …`, from the provider's counts, priced like Usage (a missing cache rate charges the input rate: an upper bound).
- **Hard limits (D49, D53):** before every request, a worst-case check against the run's turn and spend caps and the day/week/month budgets (requests cut off by Esc or Ctrl+K count their worst case); an unknown price with limits set, or a daemon that doesn't answer, pauses too. A typed ⏎ goes on (a cap allows its amount again; a raised budget is checked again), Esc stops; nothing is sent meanwhile. Defaults 100 turns / $5.00 per run (`/settings` c); `/caps` per run.
- **Kill switch:** Ctrl+K kills the request and every running command's process group with SIGKILL; SIGTERM/SIGHUP (homepage `s`) and a crash do the same.
- **Context:** % on cards and the bar; the 85% line once per crossing in the agent and on the card (`/settings` k, D55); `/clear`; a model switch clears the stale %.
- **/settings:** `c` caps form, `k` context warning, `m` on a Foundry key marks each deployment as a catalog model (picked from the list; typing only narrows it).
- Headless end-to-end (ran, built `dist`, temp home, in-memory vault, nothing left the machine): a tiny daily budget pauses the first request before anything is sent (`● paused · budget: today …`), the card shows waiting · question, /send is refused, stop exits; the v0.4.1 run (turn failure, /model, /cd, /help, no canary anywhere) still passes.

## Reviews (fresh typescript-reviewer and security-reviewer, high; every finding: failing test, then fix)
- **HIGH (both):** a priced model with no cache-read rate gave cache hits a null cost, so caps and budgets stopped counting (most new Foundry chat models) → cached input at the input rate, agent and Usage. 212532b → d3edcae.
- **MEDIUM (security):** Usage kept only 120 records/min/session, so a fast agent loop undercounted day/week/month budgets → 1,800 for the agent. ae5903c → 1b27e49.
- **MEDIUM (typescript):** /caps before the first request dropped the default caps; messages queued behind a command were stranded; stale ctx %/warning after /clear or a model switch; a chat-only deployment got the Responses wire when facts failed (now refused); a guessed 16k output limit was always sent (now only a known one). 212532b → d3edcae.
- **LOW:** interrupted requests weren't counted (both) → worst case charged; /model raced typed input → text waits; crash left commands running (both) → killed; picker selected `(not set)` after typing; catalog filter hid instruct/dated models from the picker; facts parser accepted a malformed price; worst case undercounted CJK/emoji (security) → a token per non-ASCII character; `toString`-named deployments (security nit) → own-key lookup. 212532b → d3edcae, ae5903c → 1b27e49.
- Held (both): key routing per provider (SDK base-URL/env variables ignored, explicit options win), guard, no raw text, facts route refusals, settings validators (incl. `__proto__`, catalog check), pause only by typed ⏎, kill switch, usage/facts ordering.

## Check output
```
npm run build            ESM ⚡️ Build success in 24ms
npm run typecheck        > tsc --noEmit            (exit 0)
npm run lint             ESLint: No issues found
npm test (1)             Test Files  165 passed (165) · Tests  1047 passed | 2 skipped (1049) · 16.47s
npm test (2)             Test Files  165 passed (165) · Tests  1047 passed | 2 skipped (1049) · 16.41s
grep exec(/execSync(/shell: true            none (only RegExp .exec)
grep sk-                                    only guards (isToolName, model ids) and log redaction
grep key variable names                     AITERM_AGENT_KEY/ENDPOINT only in src/daemon/env.ts and src/agent/main.ts (ENV_KEY_NAMES in validate.ts is the .env import list, unchanged)
grep --dont-ask / permission flags          src/daemon/env.ts only
git diff --check df05a3c..HEAD              clean
npm audit --omit=dev                        found 0 vulnerabilities
```

## What's next
- v0.4.3 (D48, pinned): skills, subagents and slash commands from the allowlisted folders, read-only.
- Still open from v0.4: resume from the transcript; an opt-in /compact (D55: off by default, it spends tokens).

## Manual checks (need Yaniv's keys; keys stay in the Keychain)
1. Refresh the catalog so context windows exist (network on your side): `cd ~/ai-term && curl -fsSL https://models.dev/api.json -o /tmp/models-dev.json && npx tsx scripts/update-prices.ts /tmp/models-dev.json && git diff --stat -- data/usage-prices.json` — then commit it if the diff looks right — needs Yaniv.
2. Restart (stops running agents): `cd ~/ai-term && npm run build && node dist/cli/index.js daemon stop && node dist/cli/index.js` — needs Yaniv.
3. Re-test Foundry deployments: `cd ~/ai-term && node dist/cli/index.js` → `/settings`, select the Foundry key, `t` → GPT deployments `ready`, Grok/Kimi/DeepSeek/GLM `chat`; Esc — needs Yaniv.
4. Foundry GPT turn: `cd ~/ai-term && node dist/cli/index.js` → `/cd /tmp/ai-agent-try` (from the v0.4.1 checks), `/model` → FOUNDRY → `gpt-6.1-sol · ai term`, `Add a line "v0.4.2" to README.md`, ⏎ ⏎, go inside, `y` → after the reply a `· turn · … in · … out · $0.0…` line — needs Yaniv.
5. Non-GPT Foundry turn: same, `/model` → a `chat` deployment (e.g. a Kimi one) → `Say which model you are in five words` → reply and a turn cost line (or `price ?` until step 6) — needs Yaniv.
6. Mark it: `/settings` → select the Foundry key → `m` → the Kimi deployment → type `kimi` → pick the matching catalog model → ⏎ → `my-kimi is kimi-k2.6`; repeat the turn: the cost line shows dollars — needs Yaniv.
7. Anthropic key (if you have one): `/login` → Anthropic → API key; `/model` → ANTHROPIC → `claude-sonnet-5 · ai term` (key ····last4) → one turn → reply and cost line — needs Yaniv.
8. OpenAI key (if you have one): `/login` → OpenAI → API key; `/model` → OPENAI → `gpt-6.1-sol · ai term` → one turn — needs Yaniv.
9. Context %: after step 1, the card and the bar (`/settings` h → bar on) show `ctx N%` after a turn — needs Yaniv.
10. Budget stop: home, `b` → daily `0.01` ⏎ → in an agent ask `Read README.md and summarize it` → `● paused · budget: today …`, card `waiting · question`; Esc → `■ stopped`; `b` → clear the daily field ⏎ — needs Yaniv.
11. Cap pause: inside an agent `/caps turns 2`, then `Read README.md, then AGENTS.md, then PROGRESS.md one by one` → `● paused · cap reached: 2 turns this run · ⏎ allows 2 more`; ⏎ continues; `/caps turns off` — needs Yaniv.
12. Kill switch: inside an agent (Ask) `Run sleep 120 && echo finished` → `y` → while it runs press Ctrl+K → `✗ killed: the request and 1 running command` at once; then `cd ~/ai-term && pgrep -fl "sleep 120" || echo none` → `none` — needs Yaniv.
13. Stop from the homepage: same long command, Ctrl+E home, `s` then `y` → the card goes to exited; `cd ~/ai-term && pgrep -fl "sleep 120" || echo none` → `none` — needs Yaniv.
14. 85% warning (after step 1): `/settings` → `m` → mark a Foundry deployment as a small-context catalog model (e.g. `phi-4`), start it, ask `Read PROGRESS.md in full` twice → `● context 8x% · /clear or start fresh` once, and the card shows the same; `/clear` → the card's line goes; `m` → `(not set)` afterwards — needs Yaniv.
15. Fallback: `/settings` → `r` → `keys run on: the cli`; Anthropic rows read `· claude code`, OpenAI/Foundry `· codex`; `r` back — needs Yaniv.
- Still open from v0.4.1, v0.3 and v0.2: the retained sections below.

## Gotchas
- Until the catalog is refreshed (manual check 1) there is no ctx %, no 85% warning, and no maxOutputTokens is sent; the worst case assumes 16k output, so limit pauses can come early on expensive models.
- A pause blocks the turn until you answer it: an agent left at a budget pause shows `waiting · question`.
- A request cut off by Esc/Ctrl+K counts its worst case against the run's cap and budgets for the rest of the run (it may have been billed; the provider never says).
- Usage now prices cached tokens at the input rate when the catalog has no cache rate, instead of `price ?`.
- Tests that touch Anthropic/OpenAI keys on the CLIs write `keysRunOn: 'cli'` first (they test the fallback path).

## New dependencies
- `@ai-sdk/anthropic` 4.0.79: the AI SDK's Anthropic provider (Messages API, `x-api-key`).
- `@ai-sdk/openai` 4.0.93: the AI SDK's OpenAI provider (Responses API); was already a transitive dependency of `@ai-sdk/azure`, now explicit. No OpenAI-compatible package was needed: Foundry chat deployments go through `@ai-sdk/azure`'s `chat()`.

## Concepts introduced
- **Worst-case pre-check (`src/agent/limits.ts`):** the exact cost of a request is known only after it runs, so the check before it assumes the most it could cost (a generous token estimate for the input, the full output allowance). If even that fits under every cap and budget, it can't cross them.
- **Facts from the daemon (`/v1/agent/ai-term`, `src/shared/agent-facts.ts`):** the agent never reads settings or usage files; it asks the daemon, which owns them, before every request, so a budget raised on the homepage applies to the very next request.
- **Process-group kill (`killAllBash`, `src/agent/bash.ts`):** each bash command runs as the leader of its own process group; signalling the negative pid reaches everything it started, which is what makes the kill switch leave nothing behind.

---

## Previous checkpoint (v0.4.1 AI Term's own agent, retained)

## Checkpoint
Last commit: ab09fcf fix: page long approvals, cap commands, survive bad imports, unwrap retries
Roadmap step: v0.4.1 AI Term's own agent — done (a real model call needs Yaniv's key: manual checks below)
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at 56f1755 after `git pull --ff-only` (already up to date). Baseline 150 files / 959 passed / 2 opt-in Keychain skips. Final 161 files / 1012 passed / same 2 skips, twice in a row. Session: Claude Code, Opus 5.5. Plan: `docs/plans/v0.4.md`.
Prompt vs code:
- D53 and D55 don't exist in docs/architecture.md (the log ends at D52); nothing was read for them.
- The prompt's "one provider, whichever key you already have": the only key on record is the Foundry key (narvis-resource, GPT deployments, tested through the Responses API), so the provider is Foundry via `@ai-sdk/azure`. Consequence for D47: only Foundry keys route to AI Term's agent in v0.4.1; Anthropic and OpenAI keys keep starting Claude Code / Codex until v0.4.2 adds their providers (starting an agent the agent can't serve would be worse).
- The prompt says "AGENTS.md (and CLAUDE.md imports)": built as AGENTS.md, then CLAUDE.md with whole-line `@path` imports, folder only (no parent folders), each file once.
- ctx %: the reporting path is built and tested, but a Foundry deployment name doesn't reveal its context window and the price catalog has no limits, so ctx stays empty until v0.4.2 (Models.dev limits). Not invented.
- The key's variable name appears in `env.ts` (sets it) and in `src/agent/main.ts` (takes it out of its own env first); nowhere else.
- design.md said the model picker footer reads "API key → Claude Code / Codex until v0.4"; updated with the new settings row (`keys run on`, r). The /settings footer stays as designed; the panel is one row taller (it scrolls).
- Saved defaults carry no key, so an AI Term model can't be saved as the default model (it would start a CLI login); the box says so.
- Esc interrupts a turn and reports done with the partial reply (Claude's Esc reports nothing; ours can).

## What works
- **Engine `ai-term`, protocol first** (7638fa9): `Engine`/`AgentEngine` gain it (Ask or Don't ask, no effort, key auth only, `CliEngine` for the rest); `keysRunOn: 'ai-term'|'cli'` (default ai-term, `/settings` r); validators, store, cards (`… · ai term`, badge by model family: GP for GPT deployments), start box, model picker.
- **D47 routing** (`keyEngine`, `src/shared/models.ts`): Foundry key → `ai agent`; `keysRunOn: cli` → Codex as before; Anthropic/OpenAI keys → their CLIs until v0.4.2; accounts → CLIs always. The daemon applies it again on create.
- **`ai agent`** (1d9b227, `src/agent/`): scrolling chat UI in the PTY (prompt, bracketed paste, streamed replies, one row per tool call, queued messages, Esc interrupts, Ctrl+C twice quits, `/model`, `/cd`, `/help`, `/exit`); theme tokens; no escape sequence from the model, a tool or a folder name reaches the terminal.
- **Tools**: read, write, edit, bash, search (ripgrep, else plain text), file tools jailed to the folder (S18); bash `/bin/sh -c` in a process group with timeout, output caps and a keyless env (S19).
- **Ask** (S20): every write, edit and command shows exactly what runs (paged when taller than the screen; `y` only on the last page), the daemon has the waiting status before it's drawn, one typed y/n answers, never a paste. Don't ask is per session, its flag only in env.ts.
- **Status and usage** through the existing receiver: `/v1/status/ai-term` (running, waiting permission, done + last reply for `c`, turn failed, model) and OTLP `ai_term.token.usage` on `/v1/metrics` (priced like Codex). /send is gated on its tools like Claude's (D50).
- **Key path**: Keychain → daemon `withSecret` → only the agent's env, cut to the B12 binding; Foundry requests only to the bound endpoint, `api-key` header only, no redirects; key redacted from tool output, screen and transcript (`sessions/<id>/transcript.jsonl`, 0600, removed with the agent).
- Headless end-to-end (ran): the built `dist` agent through the real SessionManager, PTY, mirror and receiver, temp home, in-memory vault, endpoint `https://127.0.0.1:9` (nothing left the machine): banner, AGENTS.md/CLAUDE.md read, the turn fails locally with a fixed reason, the card goes to `waiting · turn failed`, `/send /model gpt-6-luna` updates the card, `/cd` and `/help` work, the canary key is in no screen, transcript, log, state or session list; stop → exited.

## Security review (fresh security-reviewer, told to break the jail, leak the key, pass Ask)
No CRITICAL or HIGH. Every finding: failing test, then fix.
- **MEDIUM**: a long bash command (or diff) scrolled what runs off the screen before `y` → paged approvals, `y` only on the last page; commands over 16 KB refused before any approval. ea9708c → ab09fcf.
- **LOW–MEDIUM**: an `@import` name the file system rejects (ENAMETOOLONG) crashed the agent at start or on `/cd` → skipped with a note; `/cd` guarded. ea9708c → ab09fcf.
- **LOW**: a retried 429/5xx lost its reason and HTTP status (SDK RetryError) → unwrapped. ea9708c → ab09fcf.
- **LOW (found by me, confirmed by the reviewer for the file-name variant)**: the banner printed the folder and file names raw → `plain()`. 17bc17f → 75b5e55.
- Also found while writing tests: the AI SDK prints stream errors to stderr by default (the agent's own screen; a provider message could carry anything) → `onError` handled, fixed-text crash guard (1d9b227, 6b991fa).
- Held (reviewer): `..`/absolute/symlink/dangling/case tricks, ripgrep argv (`--no-config`, `--regexp`, `--`), loader jail, allowlisted envs, key never in argv/state/logs/protocol, `/model` limited to bound tested deployments (agent and daemon), `guardedFetch`, serialized tool calls, abort races deny, paste/CSI never approves, `--dont-ask` can't be smuggled, /send gate, the new status route (S12), `visible()` markers.

## Check output
```
npm run build            ESM ⚡️ Build success in 24ms
npm run typecheck        > tsc --noEmit            (exit 0)
npm run lint             ESLint: No issues found
npm test (1)             Test Files  161 passed (161) · Tests  1012 passed | 2 skipped (1014) · 15.77s
npm test (2)             Test Files  161 passed (161) · Tests  1012 passed | 2 skipped (1014) · 15.68s
grep exec(/execSync(/shell: true            none (only RegExp .exec)
grep sk-                                    only guards (isToolName, model ids) and log redaction
grep --dont-ask                             src/daemon/env.ts only (the agent imports the constant)
grep permission flags outside env.ts        none
grep AITERM_AGENT_KEY                       src/daemon/env.ts (sets) and src/agent/main.ts (removes); getPassword only in keys.ts
git diff --check 56f1755..HEAD              clean
```
verification-loop: build, types, lint, tests twice, security greps, diff review (52 files), headless end-to-end of the built agent; no stray processes.

## What's next
- v0.4.2 (proposed in docs/plans/v0.4.md): Anthropic and OpenAI providers (then every key routes here), Foundry chat-only deployments, Models.dev context windows (ctx %), exact cost and the hard budget, resume from the transcript.
- Nothing from v0.4.1 is open except the real-key manual checks below.

## Manual checks (v0.4.1, need Yaniv's Foundry key; the key stays in the Keychain)
Restart first (stops running agents): `cd ~/ai-term && npm run build && node dist/cli/index.js daemon stop && node dist/cli/index.js`
- Make a scratch repo: `cd ~/ai-term && rm -rf /tmp/ai-agent-try && mkdir /tmp/ai-agent-try && printf '# try\n' > /tmp/ai-agent-try/README.md && git -C /tmp/ai-agent-try init -q -b main && git -C /tmp/ai-agent-try add -- README.md && git -C /tmp/ai-agent-try -c user.name=you -c user.email=you@example.invalid commit -qm init` — needs Yaniv.
- Start with the key: `cd ~/ai-term && node dist/cli/index.js` → `/cd /tmp/ai-agent-try`, `/model` → FOUNDRY tab → `gpt-6.1-sol · ai term · key ····ITid`, type `Add a line "Hello from AI Term" to README.md`, ⏎, keep Ask, ⏎; ⏎ again to go inside → banner `AI Term agent · gpt-6.1-sol · …/ai-term`, `· read` nothing (no AGENTS.md) — needs Yaniv.
- Approve: the agent reads, then `● allow edit README.md?` with `+ Hello from AI Term`; press `y` → `✓ edited README.md` and a short reply. Check it landed in the worktree: `cd ~/ai-term && git -C /tmp/ai-agent-try worktree list && node dist/cli/index.js debug ls` (branch `ai/ai-term`), then `cd ~/ai-term && git -C "$(git -C /tmp/ai-agent-try worktree list --porcelain | awk '/^worktree /{p=$2} END{print p}')" diff` — needs Yaniv.
- Deny: type `Run ls -la` → `● allow bash · 120s limit?` showing `ls -la`; press `n` → `✗ denied`, the reply doesn't retry — needs Yaniv.
- Esc: type `Count from 1 to 300, one number per line` and press Esc while it streams → `■ interrupted`; the next message still works — needs Yaniv.
- Key not in bash: type `Run env | sort` → approve → no `AITERM`, `OPENAI`, `ANTHROPIC` or key value in the output — needs Yaniv.
- Jail: type `Read /etc/hosts with the read tool` → `✗ Path is outside the folder` — needs Yaniv.
- Card, notification, `c`, Usage: Ctrl+E home → card `✓ done` with `gpt-6.1-sol · ai term`, `GP` badge, `API key ····ITid`; `c` copies the last reply; Usage shows Foundry tokens (≈ cost, or `price ?` without a price) after the turn; give it a task, go home before it asks → `<name> · waiting: permission` banner — needs Yaniv.
- `/model` inside: `/model` lists the key's tested deployments, `/model <other>` switches and the card follows — needs Yaniv.
- Fallback: `/settings` → `r` → `keys run on: the cli`; `/model` now shows the Foundry row as `· codex` and a start runs Codex; `r` again restores `ai term` — needs Yaniv.
- Still open from v0.2 and v0.3: the consolidated list in the retained v0.3 gate checkpoint below.

## Gotchas
- Only Foundry keys run on AI Term's agent in v0.4.1; Anthropic/OpenAI keys still start the CLIs.
- An AI Term model can't be the saved default model (defaults hold no key); pick it per agent.
- The agent's bash isn't sandboxed (like Claude Code's). In Don't ask it runs whatever the model writes.
- `ps eww <agent pid>` shows the env the agent started with, including the key (as for the CLIs' key sessions, D35); everything the agent prints, keeps or sends to the model is redacted.
- ctx % stays empty for AI Term agents until v0.4.2.
- `ai agent` run by hand exits 2: it needs the daemon's env.
- Tests that use a real ripgrep skip when `rg` isn't on PATH (it isn't here); `tests/ai-agent-search-rg.test.ts` covers the argv with a stub.

## New dependencies
- `ai` 7.0.140: the Vercel AI SDK (D3), the agent loop, tool calling and streaming.
- `@ai-sdk/azure` 4.0.101: its Foundry/Azure OpenAI provider, the one provider v0.4.1 needs (sends the key in `api-key` only).
- (zod 4.6.7 arrived as the SDK's peer dependency; AI Term's code doesn't use it.)

## Concepts introduced
- **Agent loop (`src/agent/agent.ts`):** the model answers with text or tool calls; the SDK runs each tool, feeds the result back, and asks again, up to a step limit. Our tools run one at a time behind the Ask gate, and an AbortSignal (Esc) stops both the stream and a running command.
- **Folder jail (`src/agent/jail.ts`):** a path is resolved the way the OS would follow it (every symlink on the way) and must land inside the folder's real path; checking the text of the path alone would miss a symlink that points out.
- **Allowlisted env (`buildAgentEnv`, `buildBashEnv` in `src/daemon/env.ts`):** instead of removing known secrets from a copy of your environment (a denylist always misses one), the agent and its commands get only the few variables a program needs, plus exactly what AI Term adds.
- **Paged approval (`src/agent/screen.ts`, `app.ts`):** a confirmation is only meaningful if everything it confirms was on screen; long ones are split into pages and `y` only counts on the last.

---

## Previous checkpoint (v0.3 release gate, retained)

## Checkpoint
Last commit: 40424dd fix: /send trusts Codex's approval title; split input and output stay per pane
Roadmap step: v0.3 release gate done — **v0.3 is closed** (only Yaniv's real-terminal checks below remain, as for v0.2)
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at 649dd75 after `git pull --ff-only` (already up to date). Baseline 147 files / 937 passed / 2 opt-in Keychain skips. Final 150 files / 959 passed / same 2 skips, twice in a row. Session: Claude Code, Opus 5.5.
Prompt vs code:
- `git diff c4e34df..HEAD` was empty for git.ts, worktrees.ts and worktree-removal.ts before this gate, so removal regressions could only come from session-manager.ts, store.ts and validate.ts; none made a worktree wrongly deletable. The real git holes were older (submodules, below).
- The prompt lists security-bounty-hunter as an agent; it isn't an agent type here, and its skill lives under ~/.claude, which the limits forbid reading. It ran as a fresh general-purpose agent briefed as an adversarial bounty hunter.
- **Late-hook fix, as proposed for Claude, not for Codex.** Claude: /send is refused while any tool call is in flight (PreToolUse is a blocking HTTP hook, so it reaches the daemon before a permission prompt can be drawn; `toolsInFlight` in status-reducer.ts, reset by a new turn, done, a failed turn and exit). Codex exposes no tool events, and its approvals arrive in its own output (OSC 9, the Action Required title, a bell), ordered with the prompt; gating its whole turn would refuse /send almost always. Instead /send waits until the mirror and the status queue have caught up, and refuses while the mirror's last Codex title is Action Required (which also closed the bounty hunter's F2). Residual: if a Claude PreToolUse hook is lost too, that one call is unguarded.
- **Spec conflict decided, the safer way:** §12.4 said mouse events go to "the pane under the pointer"; the gate says input never reaches a non-focused pane. Mouse input now reaches only the focused pane; a press focuses first; wheel or motion over another pane does nothing (README, design.md, §12.4 updated).

## Gate findings (every one: failing test commit, then fix commit)
Reviewers ran fresh (high): security-reviewer (git, removal regressions, /open, /retry), a bounty hunter (/send, splits), silent-failure-hunter (git, spawning, deletion, /send, store). No CRITICAL.
- **HIGH-1 (security):** a filter command an agent writes into a submodule's own config inside its worktree ran when AI Term checked that worktree (`git status` recursed into the populated submodule), outside any agent sandbox. → status runs with `--ignore-submodules=all`. Tests fee93e1, fix 113bd27.
- **HIGH-2 (security):** files in an unpopulated submodule folder were invisible to the loss check, so the worktree deleted with one keypress (S14). → AI Term scans gitlink folders itself; any holding something counts as changed and enters the fingerprint. fee93e1 → 113bd27.
- **MEDIUM (security):** a clean worktree with a populated submodule could never be deleted (plain remove refuses). → the gitlink scan puts it on the typed-name/forced path. fee93e1 → 113bd27.
- **MEDIUM (bounty F2):** a late Codex turn-complete notify over an open approval marked the card done, and /send then pressed Enter on the approval. → Action Required title gate. 72e7aeb → 40424dd.
- **MEDIUM (silent M1):** a failed worktree start left stray `ai/` branches and folders (up to five per start) and was read as a collision. → stop at once, roll back with plain remove, `branch -d` and rmdir, log what's left. 1e92ecc → 05721aa.
- **MEDIUM (silent M2):** unreadable settings.json turned isolation off with the note "git check failed". → worktrees stay on, error logged. 1e92ecc → 05721aa.
- **MEDIUM (silent M3):** a worktree missing only its `.git` file read "nothing would be lost · folder already deleted" (git refused the delete, but the verdict was false). → "missing" comes from the folder alone; such a folder is refused. 1e92ecc → 05721aa.
- **MEDIUM (silent M4, also flagged LOW in v0.3.4):** an invalid worktree record was erased by the next save. → a 0600 copy of the whole file first (`keepCopy`) and the B24 note. 1e92ecc → 05721aa.
- **MEDIUM (silent M5):** any git failure on a real repo read as "not a git repo". → only git's own answer means no repo; the rest is "git check failed", logged as an error. 1e92ecc → 05721aa.
- **The late-hook window** (known open item): d7fa222 → 3d1db1d.
- **LOW:** F1 caught-up check ignored the status queue; F1b the Enter's running update could hide a waiting; S1 a pane's background backlog ran live after it took focus; S2 wheel/motion reached unfocused panes; S3 a pane's theme query reply could reach another pane (now answered from the probed background) → 72e7aeb → 40424dd. L3 `git show` could run `gpg.program` → `log.showSignature=false` (fee93e1 → 113bd27). L2 doctor printed an unrun Codex check as "logged in no"; L3 /open called unreadable folders gone and logged nothing; L6 lost-isolation notes logged at info → 1e92ecc → 05721aa.

### Not fixed, with reasons
- **/retry replaces the old record even when the new start then fails** (silent L1): by design (v0.3.4: "restart the selected agent"); the new card shows the failure and can be retried again; resume is the way back to a conversation.
- **/retry keeps Don't ask / auto** (security L5): the v0.3.4 prompt required the same permission mode; resume behaves the same. Yaniv can reopen.
- **A repo-local LFS filter with `required=true` and a command off `/usr/bin:/bin` makes starts fall back in place** (security L1): fail-safe, now logged as an error with the card note; global git config (LFS from ~/.gitconfig) is deliberately ignored, so worktrees hold LFS pointer files. Documented.
- **B24 moves aside on any read error, not just a parse error** (security L4): fail-safe, nothing lost, matches the B24 prompt ("can't be read or parsed").
- **The longest agent name wins in /send** (v0.3.4 L5): documented; the note names the recipient.
- **engines.ts resolve error shown as "not found in PATH", store close/unlink masking, the /worktrees panel's empty-list text after a load error, the 500-entry listing cap** (silent L4/L5): pre-v0.3 or cosmetic, outside the gate's safety scope.
- **Claude's Bash children inherit `AITERM_STATUS_TOKEN`** and could forge hooks (bounty, not filed): same-user processes can already attach and type (D35).
- **A Claude `Stop` while a background subagent's prompt is open** (bounty, dropped): couldn't confirm without the real CLI.

## Exit check (headless, ran)
`tests/v03-exit-check.test.ts` (e95b823): a temp repo, a temp home, the real daemon, sockets and split client; two agents (a stub engine that writes `<line>.txt` per typed line and lists its folder) side by side. Keys typed in the left pane reach only the left agent, Ctrl+\ moves to the right one. Each worktree holds only its own file (`.git README alpha.txt` / `.git README beta.txt`), each agent's own listing never shows the other's, and the original checkout keeps its files, HEAD, branch (`main`) and status; `git worktree list` shows three, and neither `ai/` branch has a commit main lacks. **Pass.**

## Check output
```
npm run build            ESM ⚡️ Build success in 23ms
npm run typecheck        > tsc --noEmit            (exit 0)
npm run lint             > eslint .                (exit 0)
npm run build:notifier   Notifier built and ad-hoc signed: /Users/yanivsp/ai-term/build/notifier/AI Term.app
npm test (1)             Test Files  150 passed (150) · Tests  959 passed | 2 skipped (961) · 15.19s
npm test (2)             Test Files  150 passed (150) · Tests  959 passed | 2 skipped (961) · 14.95s
grep exec(/execSync(/shell: true            none (only RegExp.exec)
grep git argv                               every ref and path follows --; rev-parse calls take none; -bai/<slug> validated
grep --force / -D                           only forceRemoveWorktree / forceDeleteBranch, called only when there is loss, the typed branch name matches and the fingerprint is unchanged
grep sk-                                    only redaction (log.ts) and refusal guards; no key literal
grep permission flags outside env.ts        none
git diff --check 649dd75..HEAD              clean
```
verification-loop: build, types, lint, tests (twice), security greps, diff review (21 files, gate scope only) all pass; the built app was driven again in a temp home (B24, /send, /find, /doctor, /usage, u, /budget, /retry) — all ok, no daemon left running.

## What's next
- v0.4 (AI Term's own agent for API keys), per the roadmap. Nothing blocks v0.3 except Yaniv's real-terminal checks below.

## Manual checks (everything still open from v0.2 and v0.3, in one sitting)
Restart first (stops running agents): `cd ~/ai-term && npm run build && npm run build:notifier && node dist/cli/index.js daemon stop && node dist/cli/index.js`
- Notifications, permission: `cd ~/ai-term && node dist/cli/index.js` — start a Codex agent and make it ask permission; first time the Allow prompt for "AI Term", then a banner `<name> · waiting: permission` with sound.
- Notifications, done: `cd ~/ai-term && node dist/cli/index.js` — an agent finishing while you're inside it gives no banner; one finishing while you're on the homepage gives `<name> · done`.
- Notifications off: `cd ~/ai-term && node dist/cli/index.js` — /settings, n → `notifications: off`; trigger waiting → no banner; n again.
- Click with ai open: `cd ~/ai-term && node dist/cli/index.js` — two agents, select one; click the other's banner → it's selected, Enter attaches.
- Click with ai closed: `cd ~/ai-term && node dist/cli/index.js` — start an agent with a task, /exit, click its done banner → a new Terminal opens ai inside it; Ctrl+E goes home.
- Click without a banner: `cd ~/ai-term && node dist/cli/index.js debug ls` (copy an id, /exit ai), then `cd ~/ai-term && "build/notifier/AI Term.app/Contents/MacOS/AITermNotifier" --click <id>`.
- Click for a removed agent: `cd ~/ai-term && "build/notifier/AI Term.app/Contents/MacOS/AITermNotifier" --click "$(uuidgen | tr A-Z a-z)" && tail -1 ~/.ai-term/logs/daemon.log` → nothing opens; log says `Notification click for unknown agent dropped`.
- Terminal.app raise: `cd ~/ai-term && node dist/cli/index.js` — with another app in front, click a live agent's banner; Terminal activates, the right ai window rises, the agent is selected.
- Raise probe: `cd ~/ai-term && printf '\e[5t'` — does this Terminal.app window come forward?
- Unknown terminal: `cd ~/ai-term && TERM_PROGRAM=unknown node dist/cli/index.js` — a click selects only and notes `selected <name> from a notification`.
- Foundry key after B12: `cd ~/ai-term && node dist/cli/index.js` — /settings, t on the Foundry key refuses `Foundry key must be added again to bind its endpoint`; x, a, t → deployments test as before.
- Bar trace: `cd ~/ai-term && node scripts/diagnose-bar.mjs redraw --trace` — hands off; reply with the BAR_DIAGNOSTIC line.
- Bar feel: `cd ~/ai-term && node dist/cli/index.js` — /settings h → bar on, /shell, `/usr/bin/vim -Nu NONE -i NONE -n` (type, Esc, :q), `/usr/bin/top` (q), a multi-line paste with Ctrl+E inside stays text, vim `:set mouse=a` click/wheel, resize (agent gets rows−1), Ctrl+E home and back; then h → bar off and the next attach is raw full height.
- Bar with the CLIs: `cd ~/ai-term && node dist/cli/index.js` — bar on, type into Claude Code and Codex and go through one permission prompt each (Ctrl+C skips a Codex update notice; never approve an update here).
- Two worktree starts: `cd ~/ai-term && node dist/cli/index.js` — /cd ~/ai-term, Codex, start two agents → `ai/codex` and `ai/codex-2` with distinct folders; then `cd ~/ai-term && git worktree list --porcelain && git status --short && git branch --show-current` (main stays checked out, no agent files) and `cd ~/ai-term && node dist/cli/index.js debug ls` (both branches).
- Non-repo start: `cd ~/ai-term && node dist/cli/index.js` — /cd a plain temp folder, start an agent → it runs there, card says `worktree off: not a git repo`.
- Worktrees toggle: `cd ~/ai-term && node dist/cli/index.js` — /settings w → off/on; /shell stays in /cd; x or /clean on a finished worktree agent keeps the tree (`worktree kept: <path>`).
- Removal, clean: `cd ~/ai-term && node dist/cli/index.js` — let a worktree agent exit, x → `remove worktree and branch ai/<slug>? k keep · d delete`; Esc keeps; again with d → `✓ deleted worktree and branch …`.
- Removal, loss: `cd ~/ai-term && node dist/cli/index.js` — in an exited agent's worktree add a file and a commit, x → `1 untracked · 1 commit not in main`; d only types; the branch name + ⏎ deletes.
- /worktrees and /clean: `cd ~/ai-term && node dist/cli/index.js` — /worktrees lists v0.3.1 leftovers as `✗ Not in AI Term's record` and never offers to delete them; /clean says `kept N worktrees · /worktrees reviews them`.
- Split, open and type: `cd ~/ai-term && node dist/cli/index.js` — Space, ↓, Space, v → two panes, marks gone; type in each; Ctrl+\ moves focus; Ctrl+\ twice sends one Ctrl+\.
- Split, mouse: `cd ~/ai-term && node dist/cli/index.js` — in a split, click the other pane (it takes focus and gets the click); wheel over an unfocused pane does nothing.
- Split, home and reopen: `cd ~/ai-term && node dist/cli/index.js` — Ctrl+E home with both running; v with nothing marked reopens the split.
- Split, vim: `cd ~/ai-term && node dist/cli/index.js` — /shell twice, mark both, v, `/usr/bin/vim -Nu NONE` in one pane; insert, move, :q; the other pane is untouched.
- Split, resize and exit: `cd ~/ai-term && node dist/cli/index.js` — drag the window narrower/wider (below 81 cols: `make the window bigger · ^E home`); /exit one pane's agent → `■ exited · exit 0 · ^\ closes`, Ctrl+\ turns the other into a normal attach.
- /send, idle: `cd ~/ai-term && node dist/cli/index.js` — after an agent shows ✓ done, `/send <name> ` + Tab, paste two lines, ⏎ → `✓ sent to <name> · 2 lines`, one message.
- /send, permission: `cd ~/ai-term && node dist/cli/index.js` — while an Ask-mode agent shows `waiting · permission`, `/send <name> 1` → `<name> is asking for permission, go inside to answer`.
- /send, tool running (gate fix): `cd ~/ai-term && node dist/cli/index.js` — while a Claude agent runs a long Bash command, `/send <name> hi` → `<name> is running a tool and may ask permission · try again when it finishes`.
- /send, trust prompt: `cd ~/ai-term && node dist/cli/index.js` — start an agent with no first message, `/send <name> hi` → `<name> may be asking to trust its folder · go inside first`.
- /retry: `cd ~/ai-term && node dist/cli/index.js` — select a failed agent, /retry → same `ai/<slug>`, old card gone.
- /find: `cd ~/ai-term && node dist/cli/index.js` — `/find error`, ↑↓, ⏎ → that agent selected, preview at the line with `↑ N lines back`.
- /open: `cd ~/ai-term && node dist/cli/index.js` — /open → Finder at the worktree; /open code → VS Code, or the note when `code` isn't on PATH.
- /doctor: `cd ~/ai-term && node dist/cli/index.js` — /doctor → the same lines as `ai doctor`; Esc closes.
- B24 (optional, a throwaway home): `cd ~/ai-term && AI_TERM_HOME=/tmp/ai-b24 node dist/cli/index.js` once and quit, then `cd ~/ai-term && AI_TERM_HOME=/tmp/ai-b24 node dist/cli/index.js daemon stop && printf '{"sessions":[' > /tmp/ai-b24/state.json && AI_TERM_HOME=/tmp/ai-b24 node dist/cli/index.js` → the note names `state.json.corrupt-…`; finish with `cd ~/ai-term && AI_TERM_HOME=/tmp/ai-b24 node dist/cli/index.js daemon stop`.

## Gotchas
- AI Term never runs git inside a worktree's submodules; anything in a submodule folder counts as work that a delete would lose, so deleting a worktree with an initialised submodule always asks for the branch name.
- /send to a Claude agent is refused for the whole of a long tool run; to a Codex agent while its title says Action Required, whatever the card says.
- In a split, wheel and motion only reach the focused pane; click a pane first.
- Gate tests that make `.git` read-only restore it in afterEach; a crashed run can leave a temp repo unremovable until chmod.

## New dependencies
- None.

## Concepts introduced
- **Gitlinks (`git.ts gitlinks`):** a submodule is recorded in the parent repo as a "gitlink", an index entry with mode 160000 pointing at a commit. Git treats the folder as another repository: status either recurses into it (running that repo's own config) or ignores what's inside. AI Term skips the recursion and inspects the folder itself, so nothing inside can run and nothing inside is overlooked.
- **Tools in flight (`status-reducer.ts`):** a counter of Claude tool calls between PreToolUse and their finish. Because PreToolUse is a blocking hook, the counter is up before any permission prompt can be drawn, so it covers a PermissionRequest hook that arrives late.
- **Focus by byte offset (`split-pane.ts`):** a pane remembers how many bytes had arrived when it took focus; only output after that point may reach the terminal live, so the backlog it printed in the background stays cells only, and its modes are replayed once that backlog is parsed.

---

## Previous checkpoint (v0.3.4 commands + B24, retained)

## Checkpoint
Last commit: 77ee7d8 test: capture the paste-then-prompt outcome at once; document the login flag
Roadmap step: remaining homepage commands + B24 (tasks 1–8) done
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at ec8a01c after `git pull --ff-only` (already up to date). Baseline 141 files / 886 passed / 2 opt-in Keychain skips. Final 147 files / 937 passed / same 2 skips, twice in a row. Session: Claude Code, Opus 5.5 (the prompt was written for Codex; it was pasted into this session, as with v0.3 splits).
Prompt vs code:
- **`u` didn't exist.** design.md lists `u` as "Usage details (… v0.1 can ship without it)" and it never shipped. `/usage` and `u` now open that popup, by period and provider: the daemon's summary has no by-model or by-agent breakdown, so those wait.
- **The first message is not kept** anywhere after spawn (it goes into argv only), so `/retry` never resends it and says so.
- **Retry replaces the old record** (the prompt says "restart the selected agent"); the worktree record is untouched. A failed `/login` session reruns the login; sessions started by /login now carry `login: true` (older login records lack it and would retry as an agent).
- **`/send` gates beyond the prompt:** besides permission/question waits, exited agents and attached agents (any session or split, on any client), an AI agent must have sent one hook or run-state signal first, because Claude's and Codex's folder-trust prompts report nothing and an Enter there accepts. In practice: start agents with a first message, or go inside once. Without bracketed paste only one line may go. Enter is a separate write 50 ms after the paste, rechecked; kitty flag 8 makes it CSI 13 u.
- **`/send` limits:** 16 KB (16,384 UTF-8 bytes), the first-message cap. Controls except newlines are dropped, tabs included (the prompt says "stripped"). Names match exactly; with names that prefix each other the longest wins (reviewers flagged the surprise; the success note names the recipient).
- **B24 note is a `daemon.notice`, not a warning.** A daemon warning holds the note line, so it would have hidden every other note (including /send refusals) for the daemon's lifetime. Found by running the built app. It shows each time a homepage opens until the daemon restarts.
- **B24 scope:** a corrupt or symlinked state.json is moved aside (the link itself; its target untouched), not refused. A non-list `worktrees` field counts as validate. A single invalid worktree record is still skipped (existing documented behaviour) rather than moving the whole file.
- **`/open`:** `/usr/bin/open -- <path>` was checked to honour `--` (a missing path, no GUI). A folder whose name has an extension (`Tool.app`) is revealed with `-R` instead of launched (review L3). `code` gets a minimal env allowlist, never the shell's API keys.
- No protocol version bump: `sessions.retry`, `sessions.send`, `sessions.find` and `daemon.notice` are additive. An old daemon answers the new commands with "Unknown request kind" until it restarts.
- homepage.ts is now 818 lines (over the 800 guideline); the new handlers live in their own modules where they could.

## What works
- **`/retry`** (`session-manager.ts retry`, homepage `retrySelected`): same engine, model, auth, effort, mode and folder, in its worktree if the record and folder still exist; a new Claude conversation, never Codex's resume picker; an agent that ran in place stays in place even with worktrees turned back on. Refused: running (`<name> is still running · /retry restarts finished agents`), worktree gone, folder gone, a worktree another live agent uses, a busy worktree, a retry already starting.
- **`/send <agent> <text>`** (D50; `send-command.ts`, `session-manager.ts unsendable/send/caughtUp`): Tab completes and cycles running agents; paste tokens go whole; one bracketed paste then Enter. Refusals name the agent: `<agent> is asking for permission, go inside to answer`, `… is asking a question, …`, `… is open in a session or split · type there`, `… has exited · /retry restarts it`, `… may be asking to trust its folder · go inside first`, `… is printing too fast to check · try again`, `… started asking something · text pasted but not sent, go inside`. The daemon waits for its mirror to parse every earlier chunk (and the status signals they queue) before the paste and before Enter. Text is never logged or saved.
- **`/find <text>`** (`mirror.ts find`, `find-panel.ts`, `preview.ts scrollTo`): plain text, case-folded, scrollback + screen, soft wraps joined; ≤ 200 query chars, ≤ 50 hits per agent, 200 total. Popup rows: agent name, line with the match accent + bold. ⏎ selects the agent (showing a hidden preview) and scrolls so the line sits a third down, refinding the matched text near the reported row if the agent printed since.
- **`/open`, `/open code`** (`open-folder.ts`, `shared/executable.ts`): worktree root or cwd; fixed one-line reasons.
- **`/doctor`** (`cli/doctor.ts doctorLines`): the same redacted lines as `ai doctor`, in a popup; `ai doctor` still prints as it goes.
- **`/budget`** = `b`; **`/usage`** = **`u`** (new key) = usage details popup.
- **B24** (`store.ts moveAside`, `session-manager.ts load/readSaved/validateState/migrateState`): read, parse, validate or migrate failure → `state.json.corrupt-<ISO timestamp>` (0600, `-N` if taken), empty list, fixed log `Agent list could not be loaded (<stage>)`, note `couldn't read your agent list; saved it as <file>`. If it can't be moved, the daemon stops with a fixed reason and the file untouched. Lost worktree records leave those folders `Not in AI Term's record`, so S14 refuses to delete them (tested).
- Docs: README command list and keys, design.md (/find popup and the other commands), architecture (requests, B24, D50 as built, S17).

### Tried in the built app (headless PTY, temporary HOME and AI_TERM_HOME, its own daemon, stopped after)
B24 note and move-aside; `/send one echo sent-$((40+2))` ran in a zsh login shell (the preview showed `sent-42`); `/send` unknown name, missing text and Tab completion; `/find` popup and Enter; `/doctor` popup (claude/codex not found on that PATH); `/usage`, `u`, `/budget`; `/retry` refusing a running shell and restarting a stopped one. `/open` was not run: it would open a Finder window on Yaniv's screen.

### Reviewers (fresh context, high, diff ec8a01c..HEAD)
- **security-reviewer:** no CRITICAL or HIGH. MEDIUM M1 (status could be stale behind the mirror queue), LOW L1 (a context report counted as "reported"), L3 (`.app` folder launched), L4 (a directory named `code` shadowed PATH), L6 (non-list worktrees dropped) → failing tests b034167, fixes 0dcfd00. L2 (shells ungated) and L5 (longest-name rule) are by design and documented; the lost-Claude-hook window (M1 part 1) can't be closed here and is documented in D50 and the README.
- **typescript-reviewer:** no CRITICAL or HIGH. MEDIUM: concurrent retries both started; login sessions retried as agents; a /find hit scrolled past its line after more output. LOW: final sigma never matched → failing tests ae28736, fixes 430aa75. LOW longest-name rule (by design), skipped invalid worktree record (existing behaviour) and `.app` (already fixed) not changed. It saw one unrepeatable failure of the paste-then-prompt race test; that test now captures its outcome at once (77ee7d8).

### Final check output
```
npm run typecheck   > tsc --noEmit                      (exit 0)
npm run lint        > eslint .                          (exit 0)
npm run build       ESM ⚡️ Build success in 22ms
npm test (1)        Test Files  147 passed (147) · Tests  937 passed | 2 skipped (939) · 14.53s
npm test (2)        Test Files  147 passed (147) · Tests  937 passed | 2 skipped (939) · 14.43s
```

## What's next
- The next roadmap step. Nothing is left from this one except the manual checks below.

## Manual checks
All need Yaniv, after restarting the daemon when it's safe (`cd ~/ai-term && node dist/cli/index.js daemon stop`):
- /send to an idle agent, needs Yaniv: `cd ~/ai-term && npm run build && node dist/cli/index.js`, start an agent with a first message, wait for it to finish (✓ done), then `/send <name> ` + Tab, paste two lines, ⏎: `✓ sent to <name> · 2 lines` and the agent gets one message.
- /send to one asking permission, needs Yaniv: `cd ~/ai-term && node dist/cli/index.js`, ask an agent in Ask mode to run a shell command, and while it shows `◐ waiting · permission` type `/send <name> 1` ⏎: `<name> is asking for permission, go inside to answer` and nothing reaches it.
- /send to a fresh agent at its trust prompt, needs Yaniv: `cd ~/ai-term && node dist/cli/index.js`, start an agent with no first message in a new worktree, `/send <name> hi` ⏎: `<name> may be asking to trust its folder · go inside first` (also confirms the reviewers' L1 assumption).
- /retry, needs Yaniv: `cd ~/ai-term && node dist/cli/index.js`, select a failed or exited agent, `/retry` ⏎: it restarts in the same worktree (same `ai/<slug>` on the card) and the old card is gone.
- /find, needs Yaniv: `cd ~/ai-term && node dist/cli/index.js`, `/find error` ⏎, ↑↓, ⏎: that agent is selected and its preview shows the line with `↑ N lines back`.
- /open, needs Yaniv: `cd ~/ai-term && node dist/cli/index.js`, select an agent, `/open` ⏎ (Finder opens its worktree), `/open code` ⏎ (VS Code, or the note when `code` isn't on PATH).
- /doctor, needs Yaniv: `cd ~/ai-term && node dist/cli/index.js`, `/doctor` ⏎: the same lines as `ai doctor`; Esc closes.
- B24, needs Yaniv (optional, uses a copy): `cd ~/ai-term && AI_TERM_HOME=/tmp/ai-b24 node dist/cli/index.js` once and quit, then `cd ~/ai-term && AI_TERM_HOME=/tmp/ai-b24 node dist/cli/index.js daemon stop && printf '{"sessions":[' > /tmp/ai-b24/state.json && AI_TERM_HOME=/tmp/ai-b24 node dist/cli/index.js`: the note names `state.json.corrupt-…`; then `AI_TERM_HOME=/tmp/ai-b24 node dist/cli/index.js daemon stop`.
- Headless (ran): the tests above and the built-app run listed under What works.

## Gotchas
- `/send` won't go to an AI agent until it has sent a hook or run-state signal; an agent started without a first message needs one visit inside first.
- A Claude permission prompt is seen only through its HTTP hook. If the hook is lost, a `/send` during the prompt can still hit it (D50). Don't /send to an agent you expect to ask something.
- In tests, unblock `/send` with a hook event such as `Stop`, not `AITermContext`; `SessionManager.sendEnterDelayMs` is static so a race test can widen the window (restore it).
- `String.prototype.replace` with a string replacement eats `$$`; edit scripts that insert template literals must use split/join.
- The macOS temp folder is `/var/folders/…` but `realpath` gives `/private/var/…`; worktree listings use the real path.

## New dependencies
- None.

## Concepts introduced
- **Moving aside instead of overwriting (`store.ts moveAside`):** a state file that fails to load is renamed, never read again or rewritten, before the daemon writes a fresh one. `rename` moves a symlink itself rather than its target, and only a regular file of ours is chmodded, because chmod follows links.
- **Status freshness (`session-manager.ts caughtUp`):** the daemon's idea of an agent's status comes from parsing its output in order. Waiting on the output chain, then one `setImmediate`, means every chunk that arrived before the check, and the status signals it queued, is applied before /send decides.
- **Counting from the bottom (`mirror.find`, `preview.scrollTo`):** the daemon's mirror and the homepage's preview keep different amounts of scrollback but end at the same row, so a row named by its distance from the end means the same line in both, until the agent prints more. Then the preview looks for the matched text nearest that row.

---

## Previous checkpoint (v0.3 splits, retained)

## Checkpoint
Last commit: 7c7a6b7 test: record split latency against a single raw attach
Roadmap step: v0.3 splits (tasks 1–6) done
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at c4e34df after `git pull --ff-only` (already up to date). Baseline 136 files / 839 passed / 2 opt-in Keychain skips. Final 141 files / 886 passed / same 2 skips, twice in a row. Session: Claude Code, Opus 5.5 (the prompt was written for Codex; Yaniv asked for it to run here).
Prompt vs code:
- **Pane key is Ctrl+\, not Ctrl+].** Claude Code 2.1.299's default keybindings include `"ctrl+]":"app:openArtifact"` (Global context; found in the installed binary under ~/.local/share/claude, help run with a temp HOME). The same binary lists Ctrl+\ among the keys it never binds ("Terminal quit signal (SIGQUIT)"). Codex `--help` (temp HOME) lists no keys; its install lives under ~/.codex, which the prompt forbids reading, so nothing further was checked there.
- The daemon lets one connection own one attached agent (server.ts `peer.attached`), so each pane opens its own connection. No protocol or daemon change.
- Splits work whatever the bar setting is: opening one is its own opt-in, and the bar's default-off is about an unexplained Terminal.app spike exit.
- `yes` prints identical lines, so its pane's cells barely change and the diff renderer sends almost nothing. The latency gate was therefore also run with a flood of numbered lines, whose every frame is drawn (about 46 KB/s to the terminal).
- Calmer choices where design.md was silent: a one-column `│` divider between side-by-side panes; the accent underline uses the colon form of SGR 58 (terminals that don't know it skip it, and the underline takes the text color); `◆ marked` on line 3 of the card; marks are capped at 4 and refused for exited agents; a window resized below the minimum shows `make the window bigger · ^E home` and types nowhere.
- From the review: three panes too wide to sit side by side take two on top and one full width below (the prompt lists only side by side), so closing one of four never hides the rest.

## What works
- **Marks and `v` (homepage):** Space marks or unmarks the selected agent (`◆ marked`, accent, glyph + word), up to 4, with a note line count. `v` opens the marked agents in list order and clears the marks; with none marked it reopens the split Ctrl+E left, or shows `Space marks 2–4 agents · v opens them side by side`. Only while the command field is empty.
- **Layout (`split-layout.ts`):** 2 and 3 side by side, 4 as 2×2, 3 falls back to 2-over-1; each pane ≥ 40×10 including its one-row header. A too-small terminal opens as many as fit and the bottom row says `N agents didn't fit`; if only one fits it's a normal attach. Each agent's PTY is attached at pane width × (pane height − 1) and resized on SIGWINCH; leaving detaches each pane, so sizes follow the existing rules.
- **Rendering (`split.ts`, `split-pane.ts`, `tui/split-chrome.ts`):** one client mirror per pane with the bar's passthrough and `BodyRenderer` (now with a column offset). Changed cells only, inside synchronized output; every frame ends with the cursor on the focused pane. Focused pane: 8 ms spacing and same-tick echo; others at most 30 fps. Flood cap: 8 KB parse per event-loop turn per pane; past 1 MB queued, that pane's socket pauses until it is under 256 KB. Headers: glyph + word, bold name, model · branch; focused header surface-2 with an accent underline. Bottom row: `each pane is its own agent in its own worktree` and `^\ next pane · ^\ ^\ sends ^\ · ^E home`.
- **Input (`split-input.ts`, `split-mouse.ts`):** keys and pastes go to the focused agent only. Ctrl+\ (raw, kitty, modifyOtherKeys; kitty releases swallowed) focuses the next pane or closes ended panes; twice within 0.4 s goes back and sends one real Ctrl+\ in the encoding it arrived in. Ctrl+E goes home. The terminal stays in any-motion SGR mouse mode; events are re-encoded for the pane under the pointer in its tracking level and encoding; a press focuses; a drag stays with its pane. Nothing inside a bracketed paste is interpreted.
- **S15:** only the focused pane's passthrough reaches the terminal (modes, cursor shape, title, bell, OSC 52 writes); background panes are cells only. On focus change the terminal takes the new pane's keyboard modes, cursor shape and title (`Passthrough.restore()`). OSC 52 reads always dropped. Kitty flags are set, not pushed, so panes never share stack entries.
- **Exits:** an ended agent's pane shows `■ exited · exit 0` / `✗ failed · exit 1` and `^\ closes`, and takes no keys; Ctrl+\ closes it; one pane left becomes a normal attach. `session.removed` closes a pane; a takeover shows `■ attached elsewhere`; a lost daemon connection ends the split with an error.
- Docs: README key list and split notes, design.md split spec and keyboard row, architecture §12.4, in-app help rows.

### Latency (scripts/measure-split.ts, docs/testing/v0.3-split-latency.json)
Method: outer PTY 120×40, real daemon, sockets and client; write to the outer PTY → arrival of the chunk that shows the typed cell and puts the cursor after it (read between complete synchronized frames). 50 warmup + 500 measured keys per run, 15/20/25 ms gaps, two rounds in reversed order, no timeouts. Node v26.3.0 darwin arm64. Split = 2 panes, echo focused, the other pane flooding. Raw = `ai debug attach` with the bar off.

| Config | Round | p50 | p95 | p99 | max | outer KB/s |
|---|---:|---:|---:|---:|---:|---:|
| raw attach | 1 | 1.88 | 2.14 | 2.45 | 4.34 | 0 |
| raw attach | 2 | 1.85 | 2.07 | 2.33 | 2.48 | 0 |
| raw attach + background numbered flood | 1 | 1.88 | 2.06 | 2.22 | 3.08 | 0 |
| raw attach + background numbered flood | 2 | 1.74 | 2.01 | 2.18 | 3.15 | 0 |
| split, other pane `yes` | 1 | 2.28 | 2.63 | 2.80 | 9.36 | 1 |
| split, other pane `yes` | 2 | 2.14 | 2.55 | 2.75 | 3.91 | 2 |
| split, other pane numbered flood | 1 | 2.02 | 2.41 | 3.20 | 6.35 | 46 |
| split, other pane numbered flood | 2 | 2.02 | 2.32 | 2.71 | 5.73 | 47 |

Gate (focused echo p95 within 2 ms of a single raw attach): `yes` +0.49 / +0.48 ms, numbered flood +0.27 / +0.25 ms. **Pass.** These are headless PTY delivery times, not Terminal.app pixels or feel.

### Reviewer (typescript-reviewer, high, fresh context, diff c4e34df..167f744)
No CRITICAL or HIGH. Six findings, all real; failing tests b3ba0ec, fixes 7247f69 and 7c0193b:
- MEDIUM: a sync block ending in a later chunk waited out the 150 ms hold (would delay the focused echo).
- MEDIUM: connections and attachments leaked when the split ended during attach or a connect failed.
- MEDIUM: closing one of four panes on 81–121 columns hid every agent (three side by side need 122).
- LOW: a press after a lost release went to the old pane.
- LOW: one empty input frame per typed key.
- LOW: a full redraw asked for while stdout was blocked was lost.
Not flagged as issues: Ctrl+\/Ctrl+E kitty forms ignore lock modifiers (same as the existing home-key filter); a pane's `session.updated` redraws chrome outside the 30 fps pacing (rare).

### Final check output (all exit 0)
```
npm run typecheck   > tsc --noEmit
npm run lint        > eslint .
npm run build       ESM ⚡️ Build success in 21ms
npm test (1)        Test Files  141 passed (141) · Tests  886 passed | 2 skipped (888) · 13.31s
npm test (2)        Test Files  141 passed (141) · Tests  886 passed | 2 skipped (888) · 13.32s
```

## What's next
- The next roadmap step after v0.3 splits. Nothing is left from this one except the manual checks below.

## Manual checks
All need Yaniv, after an explicit daemon restart when it's safe (`node dist/cli/index.js daemon stop`), each starting with `cd ~/ai-term && npm run build && node dist/cli/index.js`:
- Two agents, needs Yaniv: start two agents, select one and press Space, ↓, Space (both show `◆ marked`), then `v`; both open side by side and the marks are gone.
- Type in each, needs Yaniv: type in the left pane; only it echoes. Ctrl+\ moves focus (header turns surface-2 with the underline); type in the right pane.
- Ctrl+\ twice, needs Yaniv: two quick presses keep focus where it was and send the agent one Ctrl+\.
- Click switches, needs Yaniv: click inside the other pane; it takes focus and the click reaches the agent if it uses the mouse.
- Ctrl+E and v, needs Yaniv: Ctrl+E goes home with both agents running; `v` with nothing marked reopens the same split.
- vim in one pane, needs Yaniv: `/shell` twice, mark both, `v`, run `/usr/bin/vim -Nu NONE` in one; insert, move, `:q`; the other pane is untouched.
- Resize, needs Yaniv: drag the window narrower and wider; panes re-lay and the agents redraw; below 81 columns it shows `make the window bigger · ^E home`.
- Exit, needs Yaniv: `/exit` in one pane's agent; the pane shows `■ exited · exit 0 · ^\ closes`; Ctrl+\ turns the other into a normal attach.
- Headless (ran): layout math for 2/3/4 and too-small terminals; key routing (focused only, Ctrl+\ single/double in raw and kitty forms, Ctrl+E); mouse translation in all four encodings and tracking levels; one pane exiting; resize and too-small; S15 output gating; flood pause/resume; homepage marks and `v` through a headless xterm; the latency harness above.

## Gotchas
- While a split is open the terminal reports every mouse motion (`?1003`), so your terminal's own text selection needs its mouse-reporting bypass, as on the homepage.
- Panes have no scrollback (like the bar), and wheel events reach only agents that turned mouse tracking on.
- `measure-split.ts` reads the cursor only when the terminal is outside a synchronized frame; otherwise a half-delivered frame from the flooding pane shows the cursor parked in that pane and the echo check never matches.
- In tests, `split()` needs a session fixture with both `worktree` and `branch` (or neither); `validateSession` rejects one without the other and the pane silently fails to attach.
- The reviewer's scratch tests are in the session scratchpad, outside the repo.

## New dependencies
- None.

## Concepts introduced
- **One connection per pane (`src/client/split.ts`):** the daemon tracks one attached agent per socket. Giving each pane its own socket needs no protocol change, and it isolates flow control: a pane flooding output fills only its own socket buffer, so its bytes never queue in front of the focused pane's echo.
- **Flood cap (`split-pane.ts`):** xterm parses a write for up to ~12 ms before yielding. Feeding each pane's mirror at most 8 KB per event-loop turn (and yielding with `setImmediate`, which runs after pending I/O) keeps any one pane from holding the loop, so typed keys and the focused echo get in between.
- **Focus-gated passthrough (`passthrough.ts`, split mode):** the bar's passthrough forwards an agent's mode changes and titles to your terminal. In a split only the focused pane's are forwarded; the rest are remembered and replayed by `restore()` when that pane takes focus. That is how background panes stay "cells only" (S15) without losing their state.

---

## Previous checkpoint (v0.3.2 worktree removal, retained)

## Checkpoint
Last commit: f0b61eb fix: count hidden index edits and agent-written ignore rules as loss
Roadmap step: v0.3.2 worktree removal (tasks 1–6) done
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at e54e575 after `git pull --ff-only` (already up to date). Baseline 131 files / 789 passed / 2 opt-in Keychain skips. Final 136 files / 839 passed / same 2 skips, twice in a row. Session: Claude Code, Opus 5.5.
Prompt vs code:
- v0.3.1 kept worktree metadata only on session records, and `x`/`/clean` deleted them. Worktrees already orphaned that way have no record, so under task 2 they can't be deleted. `/worktrees` lists them read-only as `✗ Not in AI Term's record`.
- v0.3.1 recorded neither the repo nor the base. Older records now find their repo through git, pinned by the folder hash, and use the checkout's current branch as base. The UI says so.
- `git worktree prune` is deliberately not run. `git worktree remove -- <missing dir>` already cleans up a folder deleted by hand (git 2.50.1). Prune would also drop git's records of other missing worktrees in that repo, which breaks "never touch anything outside that one worktree".
- The prompt was cut off after "a crafted"; the reviewers were also told to try crafted state.json records and socket requests.

## What works
- **Task 1, 97f03a1:** `inspectWorktree` in `git.ts`, read-only.
  - Counts changed, untracked and ignored files, plus commits on `ai/<slug>` not in the base. The base is the recorded branch, else the start commit when that branch was deleted, else the checkout's branch for older records.
  - Flags locked, missing, renamed/switched, checked-out-elsewhere and foreign worktrees.
  - Gives a fingerprint of exactly what it saw.
  - Temp-repo tests cover each case alone and combined, merged into base, base moved forward, deleted base and a folder deleted by hand.
- **Tasks 2–3, 323f8f6:**
  - Worktree records sit in state.json beside sessions and outlive the agent; v0.3.1 records are migrated as legacy.
  - `worktree-removal.ts` refuses with fixed texts: not recorded; outside `<home>/worktrees/<repo folder>/<slug>`; any symlink; repo not hashing to its folder; main checkout; not listed by git; not on its branch; locked; branch checked out elsewhere; running or waiting agent; busy with a resume.
  - Clean: `worktree remove --` then `branch -d --`. Loss: typed branch plus unchanged fingerprint, then `--force` and `-D`.
  - A failing step stops and names itself. Deletes share the start queue and exclude resumes.
- **Tasks 4–5, bd04d84:**
  - `x` removes the record, then asks one question: clean is k/Esc/⏎ keep, d delete; loss is listed plainly and needs the typed branch plus ⏎ (pastes ignored).
  - `/clean` keeps every worktree and counts them.
  - `/worktrees` popup: ↑↓, ⏎ opens the same question, Esc closes. It shows unrecorded leftovers.
- **Task 6:** README in bd04d84 (commands, keys, flow) and f0b61eb; architecture S14 and §12.3 with the exact argv, plus design.md, in f3e2fbd and f0b61eb.
- **Final review:** fresh-context security-reviewer and security-bounty-hunter (general-purpose agent) on e54e575..f3e2fbd, read-only, temp repos only. Both independently confirmed the same two bypasses. RED d452a96 → GREEN f0b61eb:
  - **HIGH:** `assume-unchanged`/`skip-worktree` hid edits from status, and from git's own plain remove, so one `d` deleted them. Now `ls-files -v` flags count as changed.
  - **MEDIUM:** `info/exclude`, a repo `core.excludesFile` or an uncommitted `.gitignore` (the agent can write all of them) could turn untracked work into "ignored". Now a path stays ignored only if `check-ignore -v` names a `.gitignore` tracked in the repo.
  - **LOW:** nested repos are now called out (`repos`).
  - **Theoretical:** a `.git` pointed at a sibling admin dir. Now the admin dir's `gitdir` must point back at `<path>/.git`.
  - Also: literal pathspecs for git, and a 300 s timeout for removal (the reviewer flagged that 10 s could cut a big removal part way through).
  - Not fixed, documented in §12.3 Known limits: the millisecond window between the recheck and git's own remove (same-user boundary, D35; git refused a symlink swap in the reviewer's test); legacy records pinned only by the 40-bit folder hash.

### Final check output (all exit 0)
```text
npm run build       ESM ⚡️ Build success in 19ms
npm run typecheck   > tsc --noEmit
npm run lint        ESLint: No issues found
npm test -- --reporter=dot (twice in a row)
 Test Files  136 passed (136)
      Tests  839 passed | 2 skipped (841)
   Duration  12.95s / 13.15s
coverage of the new code (worktree tests): 96.15% lines, 86.54% statements
```
Git argv in `src/daemon/git.ts` (the only git execFile); every positional ref and path follows `--`. The exceptions are option values: `-bai/<slug>` (git needs it before `--`), `--format=%(ahead-behind:<base>)` (a validated plain branch, hex commit or HEAD), and `check-ignore --stdin` (names on stdin, `./`-prefixed):
```text
rev-parse --path-format=absolute --show-toplevel [--git-common-dir --absolute-git-dir]
show --no-patch --format=%H --
worktree list --porcelain -z --
for-each-ref --format=%(refname) -- refs/heads/
for-each-ref --format=%(ahead-behind:<base>) -- refs/heads/ai/<slug>
status --porcelain=v1 -z --untracked-files=all --ignored=matching --
ls-files -v -z --          ls-files -z -- <.gitignore sources>
check-ignore -v -z --stdin
worktree add -bai/<slug> -- <path> <HEAD>
worktree remove -- <path>          branch -d -- ai/<slug>          (clean)
worktree remove --force -- <path>  branch -D -- ai/<slug>          (confirmed loss only)
```
Grep: `--force` and `-D` appear only at git.ts `forceRemoveWorktree`/`forceDeleteBranch`, called only in the loss branch of `deleteWorktree`. There is no `rm`/`fs.rm`/`rmdir` on a worktree path and no `prune`. S8: no `exec(`, `execSync(` or `shell: true`.

## What's next
- The next roadmap step (v0.3 splits). Nothing is left from v0.3.2 except the manual checks below.

## Manual checks
All need Yaniv, after an explicit daemon restart when it's safe (`node dist/cli/index.js daemon stop`, then `node dist/cli/index.js`), starting in ~/ai-term:
- Clean flow, needs Yaniv: start an agent in a repo, let it exit, then `x`. Expect `remove worktree and branch ai/<slug>? k keep · d delete`. Esc shows `worktree kept: <path>`. Repeat and press `d`: `✓ deleted worktree and branch …`. Afterwards `git worktree list` and `git branch` no longer show it, and `git status` in your checkout is unchanged.
- Loss flow, needs Yaniv: in an exited agent's worktree, `echo x > new.txt` and make one commit; `x` lists `1 untracked · 1 commit not in main`; `d` only types; typing the branch name and ⏎ deletes.
- `/worktrees`, needs Yaniv: lists v0.3.1 leftovers as `✗ Not in AI Term's record` and never offers to delete them; ↑↓/⏎/Esc work.
- `/clean`, needs Yaniv: the result line says `kept N worktrees · /worktrees reviews them`.
- Headless (ran): temp-repo git tests for every loss and refusal case; real SessionManager plus git delete paths; socket round-trip; homepage key flows replayed through a headless xterm.

## Gotchas
- `branch -d` compares with the original checkout's current branch. If that isn't the recorded base, a clean delete can stop at `Worktree removed; branch delete failed`; the record is dropped and the branch stays.
- A start that fails after `git worktree add` (subfolder checks) still leaves an unrecorded worktree, as in v0.3.1.
- A freed slug can be reused by a later start. An old exited session whose worktree was deleted then points at the new agent's folder, and resuming it would start there.
- The status/ls-files output cap is 16 MiB. A tree too large to list is refused (`Git check failed`), never deleted.
- An agent-enabled sparse checkout counts every skip-worktree entry as changed, so it always needs the typed confirmation.
- In tests, the homepage writes only changed cells; read the screen through `@xterm/headless` (see `tests/worktree-flow.test.ts`), not the byte stream.
- The reviewers' scratch scripts are in the session scratchpad, outside the repo.

## New dependencies
- None.

## Concepts introduced
- **Index flags (`src/daemon/git.ts`, `hiddenEntries`):** `git update-index --assume-unchanged`/`--skip-worktree` tell git to stop looking at a file, so `git status` and plain `git worktree remove` treat edits to it as absent. `git ls-files -v` reveals them (lowercase tag or `S`), and AI Term counts them as changed.
- **Ignore sources (`committedIgnores`):** a file can be ignored by `.gitignore`, `.git/info/exclude` or `core.excludesFile`. `git check-ignore -v` names the rule's source. Only a committed `.gitignore` is trusted, because the other sources live outside history and can be written by anything in the worktree.
- **Fingerprint confirmation (`worktree-removal.ts`):** the daemon hashes exactly what it showed you. A delete must send that hash back and is refused if anything changed in between, so a confirmation always matches the loss you actually saw.

---

## Previous checkpoint (v0.3.1 worktree starts, retained)

## Checkpoint
Last commit: 1269435 fix: preserve trailing spaces in git top-level paths
Roadmap step: v0.3.1 done (worktree starts, tasks 1–7) + extra task 8 done (open-homepage terminal activation).
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at 15e646e after git pull --ff-only (already up to date). Baseline: 126 files / 767 passed / 2 existing opt-in native Keychain skips. Final: 131 files / 789 passed / same 2 skips, twice consecutively. No other skips introduced.

## What works
- Tasks 1–2, 74a29b0: git process boundary, protocol/validators and allocation. Temp-repo tests cover no repo, unborn HEAD, spaces, branch collision, hostile titles and forty-character suffixes. Worktrees are outside the checkout, keyed by canonical repo path hash; private layout directories are 0700, owned and not symlinks. Only execFile/argv is used, with timeout, fixed errors and no inherited git routing. Hooks, fsmonitor and recursive submodules are disabled.
- Tasks 3–6, d01df57: new agent PTYs use their own branch/worktree and relative /cd subfolder; fallback starts in place with a card note. Shells and login sessions stay in place; resume reuses saved worktree metadata. Session persistence, cards, bar, debug ls, default-on settings and read-only start preview are wired. x and /clean retain worktree/branch and display kept paths. Tests use real temp git repos and inspect the actual PTY spawn cwd, original status/worktree list, reload and resume.
- Task 7, 27ac856: README commands/keys and architecture/design describe worktrees, preview, setting, retention and click activation.
- Extra task 8, d01df57: fixed TERM_PROGRAM → bundle map, validated click subscription, exact `/usr/bin/open -b <bundle>` argv with minimal PATH/timeout, own-terminal CSI 5 t, unknown-terminal note. Actual server selection/activation tested with a stub launcher. Helper, notifier banners/rate limits and closed-homepage launcher were untouched.
- Final fresh-context reviewers at high, serial and read-only temporary snapshot: typescript-reviewer and security-reviewer. Each confirmed finding has a failing test commit then fix:
  - MEDIUM, branch/tag short-ref ambiguity: RED 07f17e3 → GREEN 68a2034; use full refs/heads/ names so a same-name tag cannot hide branch collisions.
  - MEDIUM, trailing-space repo path confusion: RED 8721812 → GREEN 1269435; remove exactly git's final newline, preserving valid trailing spaces. Two sibling repos test wrong-repo HEAD/branch/worktree routing.
  - No other confirmed findings. 91cf4e6 adapts the removal-error test double to the new metadata read and clarifies a test title. An initial full-suite run exposed that fixture gap; final runs are green.

### Final check output (all exit 0)
```text
npm run typecheck
> tsc --noEmit
npm run lint
> eslint .
npm run build
ESM ⚡️ Build success in 19ms
npm test -- --reporter=dot (twice consecutively after final fix)
 Test Files  131 passed (131)
      Tests  789 passed | 2 skipped (791)
   Duration  12.04s / 11.38s
```
Baseline and some full runs emit the known node-pty EIO write diagnostic; no failed tests or unhandled test errors in final runs. The two native Keychain checks remain opt-in and were not run under the user limit.

S8 grep: no process exec(, execSync( or shell: true. Only existing RegExp .exec at mouse-rows.ts:56 and passthrough.ts:121. Sole production git execFile: git.ts:12. Git command argv audit:
```text
rev-parse --path-format=absolute --show-toplevel   (no positional refs/paths; cwd is execFile option)
rev-parse --is-inside-work-tree                    (no positional refs/paths)
show --no-patch --format=%H --                     (implicit HEAD)
worktree add -bai/<slug> -- <worktree path> <HEAD commit>
worktree list --porcelain -z --
for-each-ref --format=%(refname) -- refs/heads/
status --porcelain --untracked-files=normal --
```
Git requires -b's branch option value before --; `rev-parse --verify -- HEAD` and `check-ref-format --branch -- <branch>` were tried only in a temporary repo and Git rejects them. The generated branch alphabet is stricter than check-ref-format. Every positional ref/path in production follows --. `git diff --check 15e646e..HEAD` is clean. No prohibited paths/modules or npm dependencies were changed.

## What's next
- v0.3 worktree deletion / cleanup safety (Claude's next step); splits are not implemented here.
- Earlier carry-overs below remain; real UI/CLI checks listed here need Yaniv. No user daemon or session was stopped.

## Manual checks
All commands below start in ~/ai-term. Needs Yaniv; none require pasting credentials into chat.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after an explicit daemon restart when safe: /cd ~/ai-term, choose Codex, start two agents; each shows ai/codex and ai/codex-2 (or later unused suffixes), distinct cwd in its external tree, and branch on card/bar/debug ls. Observe each folder-trust prompt and report it.
- `cd ~/ai-term && git worktree list --porcelain && git status --short && git branch --show-current` — needs Yaniv after two starts: both external trees listed, main stays checked out, no agent-created files in your checkout.
- `cd ~/ai-term && node dist/cli/index.js debug ls` — needs Yaniv: both ai/ branches appear.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv: /cd an existing non-repo temp folder and start an agent; cwd stays there and card says worktree off: not a git repo.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv: /settings w toggles worktrees; /shell stays in /cd; x or /clean on finished worktree agents shows worktree kept: path, with tree/branch retained.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv in Terminal.app: move another app in front and click a live-agent notification; Terminal app activates and the correct ai window rises, agent selects, Enter attaches. Record CSI 5 t behavior; no Automation prompt expected.
- `cd ~/ai-term && printf '[5t'` — needs Yaniv in Terminal.app: direct raise-window probe (whether it brings this window forward).
- `cd ~/ai-term && TERM_PROGRAM=unknown node dist/cli/index.js` — needs Yaniv: click selects only, homepage says selected <name> from a notification.
- Headless temp-home checks: ran — git/names/security/fallback/cwd/collisions/reload/resume/retention; UI model/card/bar/start box/settings; exact activation argv and server/client click routing. Real official CLI trust prompts and Terminal.app focus were not observed: the user's no-logins/no-computer-use limits exclude those checks.

## Gotchas
- Prompt checkpoint matches code (15e646e / 767 tests). README/design still described branch as deferred and Automation as necessary; updated for this step. RTK.md is referenced but absent; no RTK command used. The Codex process in ai-term was this session (verified parent PID), not another editing agent. Reviewers only used a temp snapshot after implementation.
- Reasonable decisions: v0.3.1 label for this worktree-start slice; excluded login sessions as well as plain shells; resumes preserve saved worktree, even with setting off; absent setting means on; default names Codex/Claude Code produce codex/claude-code slugs. No name/branch editor was added. Preview rechecks at start; external races may change suffix or HEAD between preview and spawn.
- Empty/untracked selected subfolders are created in the new worktree without copying their local contents. Private layout/selected cwd dirs are 0700; ordinary checked-out project directories retain git's normal permissions behind the private root. Repo path controls are refused; space paths, including trailing spaces, work.
- Failed git allocation retains any partial directory/branch because this step never deletes. Its slug stays occupied for later starts. A symlinked layout is rejected before reading through it.
- Known CLI issues are documented, not solved: trust may be asked per folder; ignored dependency/local env files are absent. Temp-repo evidence confirms local ignored/untracked content is not included. Actual installed CLI trust behavior was not tested, and no real .env was read.
- Real ~/.ai-term, ~/.claude, ~/.codex, ~/.ssh, keychain and .env were untouched. Only project and temporary folders were written; network only git pull/push. Main changes/commits are the requested development work; product git never commits or changes the user's selected checkout.

## New dependencies
- None.

## Concepts introduced
- Linked worktree (`src/daemon/git.ts`): git creates another checkout with its own selected branch while sharing the repository's object store. AI Term starts it from a pinned HEAD commit, so local checkout edits do not silently enter the agent's task.
- Path identity and reservation (`src/daemon/worktrees.ts`): canonical top-level path hashes separate same-named repos, and a per-home promise queue serializes allocation from different socket clients. Existing branch names and filesystem allocations reserve a slug; no cleanup deletes user work.
- Launch Services activation (`src/daemon/terminal-activate.ts`, `src/shared/terminal-app.ts`): open -b activates a known terminal app without Apple Events. CSI 5 t requests that terminal to raise its particular client window; the terminal controls whether the request is supported.

---

## Previous checkpoint (v0.2 release, retained)

## Checkpoint
Last commit: 8e7b717 test: await the stopped homepage's done promise in the L2 case
Roadmap step: v0.2.7 done (notification click-through) + v0.2 release gate done. **v0.2 is closed** on automated evidence; the click/banner and Foundry re-add checks below are Yaniv's manual checks.
Branch: main. This handover is the last commit; its own hash is in git log.
Started at 70fdae4 after git pull --ff-only (already up to date). Baseline 118 files / 720 passed / 2 opt-in Keychain skips. Final 126 files / 767 passed / same 2 skips. Session: Claude Code, Opus 5.5.
Prompt vs code: B12 and B21 are not recorded anywhere in the repo (no Bugs section has them); the prompt's descriptions were used. architecture §12.1 said a click "brings your terminal forward", which needs Automation; not done, and §12.1 now says so.

## What works
- Part A, click-through (pushed before part B):
  - Helper (RED 307d59d → GREEN 7e20924). userInfo carries the session UUID. Delegates are set before app.run(), so a cold relaunch gets the click. Only the default action counts. It sends exactly `{"clicked":"<uuid>"}\n` to `<home>/run/click.sock` after these checks: home and run are 0700, owned and not symlinks (lstat); the socket is 0600 and owned; the peer uid matches. One-second bound, SIGPIPE off, fixed errors. `--click <uuid>` runs the same send. No click and no argv: exit 2 after 3 s.
  - Daemon (RED 21a6f4d → GREEN 5bb1f00). `click-receiver.ts` gives the click socket its own listener, bound through the shared `private-socket.ts` (extracted from server.ts, B6 temp-bind and rename). Limits: 128 bytes, one line, strict JSON, lowercase UUID, 1 s deadline, 4 connections. Unknown and finished agents are dropped with a log line; at most one action per second. A homepage that sent `clicks.subscribe` gets `session.select`; otherwise `terminal-launch.ts` handles D43. The `.command` is `/bin/sh` + the absolute node/ai paths + the UUID, written 0700 in a mkdtemp folder under the 0700 `launch/`. The daemon runs `execFile('/usr/bin/open',['-a','Terminal',file])`; the file deletes itself when it runs, with a 60 s fallback and a sweep at start.
  - Client (RED cb10ced → GREEN 5e5ddcc). The homepage selects only and never attaches; an unknown id is ignored. `ai --attach <uuid>` validates the UUID before connecting, then opens the homepage inside that agent; a gone or finished agent stays home with a note. README and architecture §12.1/§3/§4 are updated (1e93ef6).
- Part B, release gate. Three fresh-context reviewers (security-reviewer, security-bounty-hunter via general-purpose, silent-failure-hunter) worked on a read-only snapshot of 1e93ef6; a researcher read the official docs for B21. Every confirmed finding below has a failing test commit, then a fix commit:
  - **HIGH (bounty), source-mode code execution.** tsx read tsconfig.json from the agent's project folder, so a repo's `paths` could make the Claude status line or Codex notify (which runs outside Codex's sandbox) execute repo code. Reproduced (marker file). RED e3fcf00 → GREEN e636574: in source mode, `/usr/bin/env TSX_TSCONFIG_PATH=<repo>/tsconfig.json` is pinned in the status line, the notify argv and the `.command`; daemon auto-start uses the absolute loader with the repo as cwd. Built mode is unaffected.
  - **MEDIUM, B12.** RED de0475c → GREEN ac48a28, docs c0f8d17. Details below.
  - **MEDIUM-LOW (security), notification starvation.** One flapping agent could fill the global 10-a-minute budget. RED c66af09 → GREEN 1d6a662: each agent is also capped at 3 a minute.
  - **MEDIUM (silent-failure):**
    - M1: an orphaned Keychain entry wasn't named anywhere; the log now names the `provider:uuid` account.
    - M2: a failed request is logged with its kind and the fixed reason.
    - M4: the Claude status line being left off is logged.
    - M5 (part): click-route startup failures log a fixed cause.
    - LOW L2: only an older daemon's `DaemonRequestError` for `clicks.subscribe` is ignored.
    - RED 9be64de → GREEN 8ec5b01; test follow-up 8e7b717.
  - **LOW (bounty), S12/S15.** `Expect: <other>` got Node's 417, and cell text kept U+2028/2029. RED f4e603e → GREEN 38b9482.
  - **B21.** RED 438f87a → GREEN 6bf35dc (+ d6653a5 for the pinned list). Details below.
- **B12 outcome.** A Foundry Keychain entry is `{v:1,secret,endpoint,deployments}`. withSecret refuses a changed settings.json copy (`Foundry key details changed outside AI Term; add the key again`) or an unbound or legacy entry (`Foundry key must be added again to bind its endpoint`), with no trust on first use. `keys.test` probes only the bound values. A spawn refuses argv whose base_url or deployment isn't bound, which also closes a time-of-check/use gap between two reads.
- **B21 outcome** (code.claude.com/docs/en/env-vars and learn.chatgpt.com/docs/config-file/environment-variables, 2026-10-13). Each list is scrubbed for its own CLI only:
  - Claude: `CLAUDE_CODE_USE_ANTHROPIC_AWS`, `CLAUDE_CODE_USE_MANTLE`, the five `CLAUDE_CODE_SKIP_*_AUTH`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`, `CLAUDE_CODE_CLIENT_CERT/KEY/KEY_PASSPHRASE`.
  - Codex: `CODEX_ACCESS_TOKEN`, `OPENAI_FEDERATION_RULE_ID`, `OPENAI_IDENTITY_TOKEN_FILE`.
  - Not added: `ANTHROPIC_UNIX_SOCKET` and the `*_FILE_DESCRIPTOR` names are not on the official page. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` stay inherited per the §7.3 table. Generic AWS/GCP/proxy/CA variables stay too.

### Not fixed, with reasons
- **Silent M3** (a corrupt state.json stops the daemon with only "Daemon failed"): v0.1 startup path outside the v0.2 surface. Logging raw errors risks S5; it needs per-stage fixed reasons. Next step.
- **Silent M5 (rest).**
  - The helper can't report a failed click: a GUI app's stderr is lost, and a fallback launch would need ai's state.
  - A homepage attached to another agent counts as "open": the prompt says select, and the selection waits for Ctrl+E (documented).
  - No visible note on select: calmer option.
- **Silent L1:** `open` without -W can't see a helper failure. Already documented in v0.2.4b.
- **L3:** status bodies dropped by size, timeout or JSON get no log; a log line wouldn't restore the lost Stop.
- **L4:** stage-specific spawn logs; diagnostic only.
- **L5:** the importEnv rollback message hides the first reason.
- **L6:** a post-rename fsync failure in atomicWrite.
- **L7:** Foundry readiness on any 2xx; the user chose the host.
- L3–L7 are rare, low-impact or need a design. Listed for later.
- **Bounty LOW 3:** another macOS user can read agent argv via setuid `ps`, including the Codex usage credential (D52, pinned) and the first message (v0.1.6 argv delivery, pinned). Forging only inflates that session's usage. Reopening needs Yaniv.
- **Bounty LOW 6:** clicks always reach `~/.ai-term`; a daemon on another AI_TERM_HOME gets none. Documented in §12.1, and the wrong helper-env comment is corrected (32fd75a).
- **Security note:** a project's own `.claude/settings.json` `env` or Codex config can still reroute a key session after folder trust. This is the documented §7.3 Known limit; AI Term doesn't read CLI config.

### Final checks (all exit 0)
```text
npm run typecheck   > tsc --noEmit
npm run lint        > eslint .
npm run build       ESM ⚡️ Build success in 22ms
npm run build:notifier  Notifier built and ad-hoc signed: /Users/yanivsp/ai-term/build/notifier/AI Term.app
npm test -- --reporter=dot (3 consecutive runs, exit 0 each)
 Test Files  126 passed (126)
      Tests  767 passed | 2 skipped (769)
   Duration  11.00s / 10.83s / 10.92s
S8 grep: no exec( / execSync( / shell: true (only RegExp .exec in mouse-rows.ts:56, passthrough.ts:121)
sk- in src: only redaction/filters (log.ts, validate.ts, status-line.ts, usage-parse.ts) and "--ask-for-approval" in env.ts
permission flags outside src/daemon/env.ts: none
git diff --check 70fdae4..HEAD: clean
```
One earlier run exited 1 on an unhandled rejection from a new test (fixed in 8e7b717); the node-pty EBADF stderr is the known baseline line.

## What's next
- v0.2 is closed. Next roadmap step: v0.3 (splits + worktrees), only when Yaniv starts it.
- Carry-overs: silent-failure M3 startup reasons; L3–L7 above. The Terminal.app bar spike exit stays open (bar default off, nonblocking per Yaniv).

## Manual checks
- Rebuild and restart, needs Yaniv (stops running agents): `cd ~/ai-term && npm run build && npm run build:notifier && node dist/cli/index.js daemon stop && node dist/cli/index.js`
- Click with ai open, needs Yaniv: `cd ~/ai-term && node dist/cli/index.js`. Start two agents and select one; when the other's banner appears, click it. The other agent is selected, and Enter attaches.
- Click with ai closed, needs Yaniv: `cd ~/ai-term && node dist/cli/index.js`. Start an agent with a task, `/exit`, wait for its `done` banner and click it. A new Terminal window (or tab, per Terminal preferences) opens `ai` inside that agent; Ctrl+E goes home.
- Same without a banner, needs Yaniv: `cd ~/ai-term && node dist/cli/index.js debug ls` and copy an id, `/exit` any ai, then `cd ~/ai-term && "build/notifier/AI Term.app/Contents/MacOS/AITermNotifier" --click <id>`.
- Click for a removed agent, needs Yaniv: `cd ~/ai-term && "build/notifier/AI Term.app/Contents/MacOS/AITermNotifier" --click "$(uuidgen | tr A-Z a-z)" && tail -1 ~/.ai-term/logs/daemon.log`. Nothing opens; the log says `Notification click for unknown agent dropped`.
- Foundry key after B12, needs Yaniv: `cd ~/ai-term && node dist/cli/index.js`. In /settings, test (`t`) the existing Foundry key: it must refuse with `Foundry key must be added again to bind its endpoint`. Remove it (`x`), add it again (`a`), then `t`: deployments test as before.
- Ran headlessly: built-helper click payload and refusals (temp socket); daemon receiver, routing branches and the exact `.command` (stub launcher); homepage select and `--attach` (fake connection); B12/B21/source-mode/Expect cases. No banner was posted, no Terminal was opened, no real key or login was used.

## Gotchas
- Older Foundry keys refuse until re-added; that's deliberate (no trust on first use). Re-adding needs the key again, or an .env import.
- The Keychain item ACL trusts the node binary, so a same-user node process could still read entries (D35 boundary). B12 binds where a key goes; it doesn't hide the key from the user's own processes.
- The click socket is `~/.ai-term/run/click.sock`. The helper honours AI_TERM_HOME only for direct `--click` runs; real clicks always use `~/.ai-term`.
- `server.ts` now binds through `private-socket.ts`; `socketAnswers` is re-exported from server.ts for existing imports.
- In source mode, status commands depend on `/usr/bin/env` and the repo's tsconfig.json path passing the strict path alphabet; otherwise they're left off (logged).
- Review snapshot worktree was in the session scratchpad and has been removed; the unrelated `/private/tmp/ait-review` worktree from an earlier session is untouched.

## New dependencies
- None.

## Concepts introduced
- Cold-launch delivery (`native/notifier/Notifier.swift`): when a banner is clicked after its app exited, macOS relaunches the app without argv and delivers the click to whatever UNUserNotificationCenter delegate exists while launch finishes. That's why the delegate is set before `app.run()`, and why the route to the daemon must be a fixed path rather than an argument.
- Document launch (`src/daemon/terminal-launch.ts`): `open -a Terminal file.command` asks Launch Services to open a file with Terminal, as a double-click would. Terminal runs it in a new shell. No Apple Events and no Automation permission are involved, unlike AppleScript `do script`.
- Peer credentials (`native/notifier/Notifier.swift`, `getpeereid`): a Unix socket can report the uid of the process at the other end. The helper checks it's the user's own, in addition to the file's owner and mode.
- Secret binding (`src/daemon/keys.ts`): data that decides where a secret may go is stored inside the secret's own protected entry. A writable side file (settings.json) can then only be compared against it, never trusted.
- Module resolution pinning (`src/daemon/env.ts` `sourceTsconfig`): tsx resolves path aliases from the tsconfig.json of the current folder. Commands that run inside someone else's project pin their own tsconfig with `TSX_TSCONFIG_PATH`.

---
## Previous checkpoint (v0.2.6, retained)

## Checkpoint
Last commit: 7186961 docs: record measured product bar latency gate on this Mac
Roadmap step: v0.2.6 done — tasks 2–6 delivered; task 1 Terminal.app spike exit remains open by Yaniv's explicit nonblocking override.
Branch: main. This handover is the last commit; its own hash is in git log.
Continued at 112839b after git pull --ff-only (already up to date), preserving the existing 114-file / 672-passing baseline and two native Keychain opt-in skips. The original 540ebe8/670 checkpoint and later 3a0c949 prompt are historical; the checkout was further ahead. Session is Codex, not Claude Code/Opus.

## What works
- Task 2: d22de29 confirms existing shared Unicode 11 registration in daemon and attached client mirrors. Snapshot/cell tests agree on CJK, skin tones, ZWJ families and flags. No width dependency added; Unicode 11 already existed. This proves mirror agreement, not every terminal's grapheme shaping.
- Tasks 3–4: eda9fe0 / 0bbb675 / 6d7e778 implement opt-in client mirror/cell rendering and saved bar setting. Default **off** per latest instruction. Off preserves full-height raw passthrough and skips probing; on gives the daemon PTY rows−1, including resize. Failed DA1 probe (250 ms) falls back raw and logs once; one-row terminals also use raw. Early probe input survives fallback.
- Bar: surface tokens, glyph + status word, bold name, engine · model, other-session counts and ^E home. Counts drop first, then model; engine is retained when it fits (cc39ab5). Name/home are clipped or omitted when needed to keep the status word. No animation; unchanged bar bytes aren't emitted or rebuilt. Branch in the design was future worktrees data, absent in current code; explicitly deferred to v0.3 in design.md.
- Renderer: synchronized changed-cell output, same-tick idle draw after the public xterm user-input hint, one frame per 8 ms under floods, agent sync waits at most 150 ms (including a sync begin after a frame was already scheduled). Palette/default/RGB colors and accessible cell attributes stay intact. Cursor is restored after bar-only updates. All four mouse encodings shift rows, bar clicks/releases drop, arbitrary split reports and paste markers survive. Home keys are filtered before mouse rewriting; lone Escape retains its 30 ms ambiguity timeout.
- Exact spike query table covered: screen-relative queries answered by the mirror; CSI 18 t reports rows−1; input/title/cwd/theme/copy modes forward; OSC 52 reads, unsupported color/window queries, pixel mouse and inline images drop. Title-stack operations require enabled xterm windowOptions (covered). Reattach carries validated cursor shape, sanitized title, kitty root/push flags and theme reports.
- Task 5: README, design.md and architecture.md document the setting, shortcut, narrow layout, raw fallback and losses: OSC 8 targets (text stays), curly/dotted/colored underlines (plain underline stays), inline images. Product attach has no client-owned child: the daemon owns its PTY; client EOF detaches, cleanup never stops the agent. The spike's client child.onExit callback therefore has no equivalent in product attach. Unexpected input could still make vim quit; the unknown cause isn't declared fixed. Daemon-owned vim was observed staying alive and retaining text across attach/resize/Ctrl+E/reattach with bar both off and on.
- Task 6: RED 64fbf1d → GREEN ab66666. Signed helper --status reads getNotificationSettings without prompting, emits exactly allowed/denied/not-asked/unknown and exits 0. Real direct binary and open -W -n -g --stdout launches each returned **denied**, exit 0, for the same signed bundle on this Mac; direct identity parity confirmed. Native --status test ran, helper rebuilt and signature verified.
- Daemon execFile argv-only status reads: timeout 3 s, maxBuffer 128, fixed PATH; daemon start and once per minute timer, in-flight deduplication and cached state. Settings overlay explicitly requests refresh; ordinary settings reads used by attach return cached state immediately (b60d1bc RED → e3f4b80/2e40abd fix). No helper wait in session paths. Cached denied suppresses notification launches and logs once. Failed/unrecognized/unverified reads are unknown. All four wording states have stub-helper coverage; instructions wrap and scroll to selected rows in short settings (64ae92c RED → 0b33fc8 GREEN).
- Read-only performance-optimizer: confirmed input hint, identified deferred daemon parsing shared by raw/redraw and 8 ms busy-frame delay. No daemon typing changes made. Used actual separate daemon/socket/client/outer PTY measurement rather than claiming spike timing applies to product.

### Latency evidence (milliseconds, this Mac, bar forced on)
Method: scripts/measure-bar.ts, 120×40 outer PTY; raw agent 120×40, bar-on agent 120×39. Actual daemon SessionManager/DaemonServer and configured attach; temp HOME/cwd/AI_TERM_HOME, fixed echo/vim argv. 50 warmup + 500 measured keys per run, 15/20/25 ms gaps; raw/on order reversed in round 2. Output arrival timestamp validated against new body cell and cursor. Eight runs: 4,000 measured keys, zero timeouts. Artifact: docs/testing/v0.2.6-bar-latency.json; Node v26.3.0 darwin arm64.

| Program | Round | raw p95 | on p95 | delta | gate ≤2 ms |
|---|---:|---:|---:|---:|---|
| echo | 1 | 2.48 | 2.88 | +0.40 | pass |
| echo | 2 | 2.27 | 2.66 | +0.39 | pass |
| vim | 1 | 2.47 | 3.20 | +0.73 | pass |
| vim | 2 | 2.70 | 2.85 | +0.15 | pass |

These are headless PTY delivery measurements, not Terminal.app pixels or subjective feel. Gate does not cover input arriving just after a bar/output frame; the mandated 8 ms throttle can delay that busy path. Final review fixes affect Escape/probe fallback/kitty root restoration/narrow layout, not the quiet measured ASCII typing path.

### Final reviewer and checks
One fresh-context high typescript-reviewer pass through 7186961, read-only, no remaining material correctness/security/requirement findings. Initial review preflight caught a test mock type; fixed before review continued. Three real findings:
- Lone Escape buffered by mouse filter: feb6f14 RED → d1af1ac GREEN.
- Early typing discarded on failed probe: 99837eb RED → fcb4994 GREEN.
- Nonzero root kitty flags reset on reattach: 99837eb RED → fcb4994 GREEN (separate failing test in same commits).
Reviewer independently ran three targeted files / 44 passed, typecheck/lint exit 0, diff check clean. During implementation ran touched test files only; final suites include all files.

Final output tails, all exit 0:
```text
npm run typecheck
> tsc --noEmit
npm run lint
> eslint .
npm run build
ESM ⚡️ Build success in 18ms
npm test -- --reporter=dot (run 1)
Test Files 118 passed (118)
Tests 720 passed | 2 skipped (722)
Duration 10.26s
npm test -- --reporter=dot (run 2, immediately consecutive)
Test Files 118 passed (118)
Tests 720 passed | 2 skipped (722)
Duration 10.26s
```
Two skips are unchanged opt-in native Keychain tests; not enabled under the no-keychain constraint. Existing node-pty flood test still prints EIO/EBADF stderr as baseline did; both suites green. No additional tests skipped. git diff --check clean.

## What's next
- v0.2.6 tasks 2–6 complete. Next roadmap step: notification click-through, only in a new explicitly requested step.
- Yaniv runs the still-open Terminal.app trace later, then chooses when to enable bar and perform subjective feel/agent checks. No request to wait for trace; no block imposed.

## Manual checks
- Daemon-owned vim, typing, resize, Ctrl+E and retained text on reattach: ran headlessly with real isolated PTYs, both bar off/on. Product benchmark echo/vim: ran, gate pass. Cell/query/mouse/paste/settings/denied suppression: ran targeted tests. Native status and signed bundle checks: ran; no notification posted or permission prompted.
- Trace — needs Yaniv: `cd ~/ai-term && node scripts/diagnose-bar.mjs redraw --trace` (hands off; auto-quits surviving vim after 2.5 s).
- vim feel — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — /settings → bar on (h), /shell, `/usr/bin/vim -Nu NONE -i NONE -n`, type, Esc, :q.
- top — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — bar on, /shell, `/usr/bin/top`, q.
- Claude Code — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — bar on, select Claude Code, type and check permissions; no real login accessed in this session.
- Codex — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — bar on, select Codex, type and check permissions; Ctrl+C skips an update notice, never approve an update during this check.
- Paste — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — bar on, multiline paste including Ctrl+E remains text.
- Mouse — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — bar on, vim `:set mouse=a`, click/wheel, bar press/release ignored, Esc immediate after normal ambiguity delay.
- Resize — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — bar on, resize during vim/top; agent has rows−1.
- Ctrl+E — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — bar on, Ctrl+E home, agent keeps running, reattach retains text.
- Bar off — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — /settings h → bar off; next attach raw/full-height.
- Notification parity repeat — ran; optional Yaniv command: `cd ~/ai-term && node --input-type=module -e 'import {execFileSync} from "node:child_process";import {mkdtempSync,readFileSync,rmSync} from "node:fs";import {tmpdir} from "node:os";import {join,resolve} from "node:path";const app=resolve("build/notifier/AI Term.app"),dir=mkdtempSync(join(tmpdir(),"ai-status-")),out=join(dir,"status");try{process.stdout.write("direct: "+execFileSync(join(app,"Contents/MacOS/AITermNotifier"),["--status"],{timeout:3000}));execFileSync("/usr/bin/open",["-W","-n","-g","--stdout",out,"-a",app,"--args","--status"],{timeout:3000});process.stdout.write("open: "+readFileSync(out,"utf8"));}finally{rmSync(dir,{recursive:true});}'`
- Benchmark repeat — ran: `cd ~/ai-term && node --import tsx scripts/measure-bar.ts 500` (temp daemon only; takes about two minutes; writes the measurement artifact).

## Gotchas
- Mac spike exit cause remains **unknown**. Successful probe, 4,430 vim bytes and clean exit 0 do not prove why vim quit. Prior exact replies/sizes/late focus/mouse/query headless replay did not reproduce it. Trace remains available and nonblocking per Yaniv; default bar off is deliberate.
- The product's daemon ownership avoids client EOF/child lifetime coupling, but cannot guarantee against a terminal report being interpreted as editor input. Never report task 1 fixed without a proven reproduction.
- The original design had `· branch`; current session data has no branch until worktrees v0.3. Current task specifies engine/model; docs now explicitly defer branch. Old spike report claims D39/2031 absent; current architecture and RESET_MODES already include them. Trust current code.
- No new npm dependency. No protected source/status/env/notifier-spike/review/config directories edited. No real ~/.ai-term touched or user daemon stopped. No ~/.claude, ~/.codex, ~/.ssh, keychain or .env access; no computer use or network except git pull/push. Review/performance agents read-only; root alone edited.
- Existing daemon processes need the new build before recognizing new settings/protocol fields. This session built code but did not restart Yaniv's real daemon.

## New dependencies
- None; @xterm/addon-unicode11 was already installed.

## Concepts introduced
- Client mirror (`src/client/session-screen.ts`): the agent's escape sequences update an in-memory terminal at its own rows−1 dimensions. The renderer draws its cells one row lower, so clears and cursor moves cannot overwrite AI Term's bar.
- Input fast path (`src/client/session-screen.ts`): xterm normally parses on a later timer; its public input('', true) hints that the next write is a typing echo. Idle rendering runs in that same tick; floods keep the 8 ms cap.
- Permission cache (`src/daemon/notification-permission.ts`): authorization is a separate fact from whether an app could launch. A bounded background read caches one fixed enum; session transitions only consult it and never wait on a process.
- Probe fallback (`src/client/terminal-probe.ts`): DA1 confirms that startup queries completed; missing optional colors/kitty support do not fail it. A timeout selects raw for this attach while preserving ordinary input, which keeps startup keystrokes from disappearing.

---
Previous handovers (historical; the checkpoint above supersedes their blocking/default statements):

## Checkpoint
Last commit: 1aa2d47 fix: restrict exit trace to terminal response formats (GREEN)
Roadmap step: v0.2.6 partial — BLOCKED at task 1 (hands-off Terminal.app exit trace pending)
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at 3a0c949 after git pull --ff-only (already up to date). Baseline: 114 files / 671 passed / two existing opt-in native Keychain skips (9.45 s).

## What works
- Existing product behavior remains unchanged. Read PROGRESS first, then current diagnostic/test, AGENTS, README, full bar spike report and spike startup/exit/query/mouse/renderer paths, design/tokens, architecture, current attach and daemon/shared width modules. No product changes or notifier changes.
- Yaniv supplied the first real Terminal.app diagnostic: OSC 10 `rgb:e6ce/e6ce/e6ce`, OSC 11 `rgb:213d/2743/33e7`, DA1 `CSI ?1;2c`; no extra probe bytes, kitty false, startup 6.745 ms, child 4430 bytes, child exit code 0/signal 0, reason program exited. This proves the probe succeeded, but does not show post-probe input, EOF, size or elapsed time to exit. The clean exit alone cannot name what made vim quit.
- Replayed those exact three replies through an outer node-pty driver on this Mac; unchanged spike and diagnostic both kept vim open, accepted typing and only quit after explicit Esc + :qa!. Also tested 20x4, 120x40 and 220x60 outer PTYs, plus late DA1, CPR, OSC colors, focus in/out and SGR mouse reports. None reproduced the spontaneous exit. These are headless startup checks, not pixel/feel verification or latency measurements.
- Read node-pty's macOS spawn and exit handling: it allocates its own PTY/termios and rows/cols; its macOS kqueue/waitpid callback is the source of the reported exit. The new trace checks whether the PID is still alive at that callback, without claiming this bookkeeping is the cause.
- Task 1 diagnostic expansion: RED c1d8a05 → GREEN c36b7ea.
  - `cd ~/ai-term && node scripts/diagnose-bar.mjs redraw --trace` is hands-off: do not type, paste, click or resize. If vim survives, it sends Esc + :qa! automatically after 2500 ms; autoQuitSent distinguishes that from an earlier exit.
  - One BAR_DIAGNOSTIC JSON line now includes PTY size; timestamped recognized post-probe terminal reports from outer stdin and child.write; omitted-byte counts; stdin end/close; child close/exit timing; input-read-error presence; whether the child PID was alive at node-pty's exit callback; kill signals; and vim's VimLeavePre values (dying, exiting, actual lines/columns, an allowlisted qa/q/other command category).
  - Captures at most 4096 bytes across both streams, in memory only, during the first second. Explicit response grammars only; ordinary or encoded typed keys are count-only. The optional VimLeavePre file is temporary, numeric/category-only, removed with the temp directory; no runtime keys, accounts, agents or real daemon used.
  - Headless exact-reply trace ran: 120x39 child PTY; no outer input after probe; mirror CPR/DA2 replies; autoQuitSent true; vimLeave dying 0/exiting 0/quitCommand qa; exit after 2513 ms; PID no longer alive at callback. No spontaneous exit.
- Fresh-context TypeScript reviewer at high: two real findings, both got failing-test and fix commits.
  - MEDIUM fragmented replies disappeared from the trace: RED 8fd05e8 (ESC[ / I split across reads loses focus reply) → GREEN df2de77 (bounded per-stream assembly recognizes it).
  - HIGH broad CSI grammar could print kitty-encoded typed letters; bare ZZ/ZQ also matched ordinary text: RED 0fc1167 (synthetic encoded text leaked) → GREEN 1aa2d47 (exact terminal response formats, no ordinary keys). No additional material findings.
- Final verification after all review fixes, all exit 0:
  - `npm run typecheck`: `> tsc --noEmit`
  - `npm run lint`: `> eslint .`
  - `npm run build`: `ESM ⚡️ Build success in 17ms`
  - Targeted tests/bar-diagnostic.test.ts: 2 passed.
  - `npm test -- --reporter=dot` twice consecutively: `Test Files 114 passed (114)` / `Tests 672 passed | 2 skipped (674)` / 9.82 s then 9.67 s.
  - Existing daemon-core flood test still emits node-pty EIO/EBADF stderr in baseline/final suites. Both exit 0. Unchanged native Keychain opt-in skips not enabled.
  - git diff --check clean. Only scripts/diagnose-bar.mjs, tests/bar-diagnostic.test.ts and this handover changed. No new dependencies; no protected paths or product code changed.

## What's next
- BLOCKER: no spontaneous-exit reproduction or proven cause. Yaniv explicitly authorized one more diagnostic run and requires stopping for its result.
- Need the single BAR_DIAGNOSTIC line from `cd ~/ai-term && node scripts/diagnose-bar.mjs redraw --trace` in Terminal.app, with no input during the run. The diagnostic automatically quits surviving vim after 2.5 s. Do not label task 1 fixed until its actual cause is reproduced and covered by a test.
- Then finish original tasks 2–5 and task 6 in order: shared width agreement in attached client mirror (table already exists), renderer/query/mouse/input fast path, themed bar/rows−1, saved bar on/off and failed-probe raw fallback, docs; notifier --status + verified identity or unknown fallback + asynchronous cached permission checks/settings/denied suppression.
- Performance agent and product latency gate remain unreached; echo/vim raw/redraw p95 not measured. No bar ships. Next roadmap step after v0.2.6 remains click-through notifications; not part of this session.

## Manual checks
- Exact Terminal.app replies, varied sizes and late query/focus/mouse reports: ran headlessly; no spontaneous exit. Trace, fragmented reports, encoded-key omission: ran with real outer PTYs.
- `cd ~/ai-term && node scripts/diagnose-bar.mjs redraw --trace` — needs Yaniv now: hands-off Terminal.app exit trace; it auto-quits. Reply with one BAR_DIAGNOSTIC line.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: /shell then vim, typing and :q.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: /shell then /usr/bin/top, q quits.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: Claude Code typing/permission checks; real login not run.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: Codex typing/permission checks; real login not run.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: multiline paste, Ctrl+E in pasted text stays text.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: vim mouse click/wheel, bar press/release ignored.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: resize preserves rows−1 PTY.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: Ctrl+E goes home, agent keeps running.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: /settings bar off, attach original raw path; setting not built.
- Notifier direct-launch authorization parity: not reached; no --status mode exists yet, no permission conclusion made.

## Gotchas
- No cause is established. Optional query absence, a clean PTY exit code, and 4430 drawn bytes do not show why vim exited. Do not invent a fix from these observations.
- Trace mode adds only an exit autocmd and controlled delayed quit to vim; spike files remain unchanged. It retains bounded input in memory to assemble replies but emits only known terminal reports. The user must use a hands-off run for this trace to distinguish unexpected input.
- Shared Unicode 11 table already exists in daemon/preview mirrors; confirm attached client integration later. D39 and 2031 reset already exist. RTK.md absent. These stale notes remain documented in preceding handover.
- No real ~/.ai-term, ~/.claude, ~/.codex, ~/.ssh, keychain or .env access; no computer use; no network except git pull/push; no user daemon stopped. No other editing agent spawned; reviewer read-only. Session is Codex, not Claude/Opus.
- Follow the original task-6 notifier override only after task 5, the 2 ms latency gate, two final quiet full suites, high fresh-context review and separate RED/GREEN commits for real findings.

## New dependencies
- None.

## Concepts introduced
- Vim exit hooks (`scripts/diagnose-bar.mjs`): VimLeavePre runs immediately before vim exits and exposes v:dying/v:exiting. Numeric values and a small allowlisted command category help distinguish a regular quit from abnormal termination without exporting the editor's contents or command history.
- Incremental report capture (`scripts/diagnose-bar.mjs`): a PTY data event can end halfway through a terminal response. The diagnostic assembles up to 4 KB per combined streams in memory and emits only explicit response formats, so read boundaries cannot hide a reply or turn an encoded key into recorded text.

---

## Previous checkpoint (3a0c949, retained)

## Checkpoint
Last commit: 5167cad fix: keep diagnostic vim writes in temporary cwd (GREEN)
Roadmap step: v0.2 bar + notification authorization partial — BLOCKED at task 1 (Terminal.app diagnostic pending)
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at 540ebe8 after git pull --ff-only (already up to date). Baseline: 113 files / 670 passed / two existing opt-in native Keychain skips (9.81 s).

## What works
- Existing v0.2 status, homepage cards and v0.2.4b notifications remain at the previous checkpoint. No product code changed.
- Task 1 investigation: read the entire bar spike report, startup probe and all exit paths, current attach, daemon mirror, shared width code, design and architecture §12.1/D39.
  - The probe asks OSC 10, OSC 11, kitty and DA1. It finishes on DA1 or after 250 ms. Lack of kitty/color answers does not itself exit the harness.
  - `bar spike: program exited` is emitted only after node-pty's child onExit event, which the spike currently ignores the numeric code/signal for. No cause for Yaniv's immediate exit is established.
  - Headless outer PTY driver on this Mac answered DA1 as Terminal.app (`CSI ?1;2c`) and ignored kitty and OSC 10/11. Both raw and redraw vim stayed alive after 1.8 s, accepted `TERMINAL_APP_DRIVER`, and quit only after the driver sent Esc + `:qa!`. Redraw probe facts: kitty false; startup 8.54 ms. These are startup checks, not latency measurements or Terminal.app visual verification.
- Safe pending diagnostic: `cd ~/ai-term && node scripts/diagnose-bar.mjs`.
  - Runs the unmodified spike in Terminal.app with disposable vim, temporary HOME and cwd, literal child env. It instruments node-pty's CommonJS spawn before tsx loads the harness, so it can print numeric child exit/code, byte count, bounded recognized terminal probe replies (hex), probe facts and reason in one `BAR_DIAGNOSTIC {...}` line.
  - No raw typed-input trace, agent, login, real daemon, real ~/.ai-term or notification access. Temporary state is removed at normal exit. No writes to spikes/ or docs/spikes/.
  - RED ee2492b: diagnostic absent, 1 failing PTY test. GREEN ee2ab0f: DA1-only startup, typing and actual vim exit recording pass. The test uses an outer headless screen to inspect positioned text.
- One requested fresh-context high TypeScript reviewer pass on the code diff; one MEDIUM finding, no additional correctness/security findings.
  - Finding: diagnostic child cwd was the checkout; vim's `file bar probe` plus `:w` could create a file there.
  - RED bd15053: actual vim `:pwd` shows the checkout rather than the temp directory, 1 failing test. GREEN 5167cad: cwd is temporary HOME; the same test passes.
- Final verification after the review fix, all exit 0:
  - `npm run typecheck`: `> tsc --noEmit`
  - `npm run lint`: `> eslint .`
  - `npm run build`: `ESM ⚡️ Build success in 17ms`
  - `npm test -- --reporter=dot` twice consecutively: `Test Files 114 passed (114)` / `Tests 671 passed | 2 skipped (673)` / 10.09 s then 9.70 s.
  - Existing daemon-core flood test emits node-pty EIO/EBADF stderr in the baseline and final suites; both suites exit 0. The two skips are the unchanged native Keychain opt-in cases; did not enable them.
  - `git diff --check` clean. Only scripts/diagnose-bar.mjs, tests/bar-diagnostic.test.ts and this handover changed. No new dependencies.

## What's next
- BLOCKER: Yaniv's Terminal.app immediate-redraw-vim exit was not reproduced. Need the single BAR_DIAGNOSTIC JSON line from `cd ~/ai-term && node scripts/diagnose-bar.mjs` in Terminal.app. If vim stays open, type a few characters, then Esc + `:qa!` + Enter. Task 1 explicitly requires waiting for this result before building. Do not guess the cause.
- After the diagnostic establishes a cause and its regression test, finish tasks 2–5: shared width agreement in the attached client, session-screen renderer/query/mouse/same-tick path, themed bar + rows−1 resizing, bar on/off default on + failed-probe raw fallback, README/design/architecture. Then task 6: notifier --status, verified direct-launch identity or unknown fallback, cached asynchronous daemon checks, settings states and denied suppression.
- Typing-performance agent and latency measurements were not reached. No redraw/raw echo/vim p95 table is measured for a product implementation. The 2 ms gate is unresolved; no bar ships from this session.
- After completion, the next roadmap step remains click-through notifications per the preceding checkpoint; do not start it within the current bar/authorization step.

## Manual checks
- DA1-only headless raw/redraw vim startup + typing + explicit quit: ran; no immediate exit. Diagnostic PTY test: ran; actual temp cwd and exit report verified.
- `cd ~/ai-term && node scripts/diagnose-bar.mjs` — needs Yaniv: Terminal.app startup evidence. Reply with BAR_DIAGNOSTIC line; no credentials or screenshot needed.
- `cd ~/ai-term && node scripts/diagnose-bar.mjs raw` — needs Yaniv only if comparison is useful after the first result.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: /shell then vim, typing and :q; current product is raw passthrough.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: /shell then /usr/bin/top, q quits.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: Claude Code typing and permission flow; real login checks not run.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: Codex typing and permission flow; real login checks not run.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: multiline paste, Ctrl+E inside paste stays text.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: vim mouse click/wheel, bar press/release ignored.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: resize attached terminal, PTY gets rows−1.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: Ctrl+E goes home and agent keeps running.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: /settings bar off, attach uses original raw path (setting not built yet).
- Notification direct-launch authorization parity: not reached; status helper is not implemented, so there is no valid --status diagnostic yet. Do not claim permission is known.

## Gotchas
- Code disagrees with the spike's stale prerequisites: src/shared/unicode-width.ts already registers @xterm/addon-unicode11 in the daemon and preview mirrors. Existing unicode-width test covers CJK, skin tones, ZWJ families and flags with Unicode 11 semantics (separate emoji members, not grapheme shaping). Attached client mirror still needs integration and agreement tests; no dependency decision made yet.
- D39/§12.1 now exist and RESET_MODES already resets 2031. These spike findings are stale.
- design.md's bar includes `· branch`; the prompt excludes it, and worktrees start at v0.3. Follow the prompt for this step and document that decision when implementing.
- RTK.md is referenced by the supplied instructions but absent from the repository. No RTK command used.
- This session is Codex, not Claude Code/Opus; the requested high fresh-context TypeScript reviewer was used. No other repository editing agent was started.
- The pending diagnostic blocks subsequent tasks by explicit user requirement. Preserve the task-6 override allowing notifier changes only after task 5.
- No real ~/.ai-term, ~/.claude, ~/.codex, ~/.ssh, keychain or .env read; no computer use or network except git pull/push. No user daemon or sessions stopped.

## New dependencies
- None. The diagnostic reuses existing node-pty, tsx and @xterm/headless.

## Concepts introduced
- Diagnostic instrumentation (`scripts/diagnose-bar.mjs`): node-pty exposes a CommonJS module object, so a wrapper can observe its public spawn and exit events before loading the unchanged spike. This preserves the suspected startup path while recovering the exit evidence the spike discards.
- Terminal capability probe (`scripts/diagnose-bar.mjs`, existing spike): terminal reply bytes say which keyboard and color features the outer terminal implements. DA1 completes this spike's startup; absent optional replies mean unsupported/unknown capabilities, and are not proof of a program-exit cause.

---

## Previous checkpoint (v0.2.4b, retained for existing behavior and evidence)

## Checkpoint
Last commit: d8bffb0 fix: tolerant settings read for notifications, staged signed build swap, accept unassigned code points, compare waiting reasons (GREEN)
Roadmap step: v0.2.4b done (notifications without click-through; real banner, sound and Allow prompt need Yaniv)
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at 1b720c4 after git pull --ff-only (up to date). Baseline 109 files / 641 passed / two native Keychain skips. Final 113 files / 670 passed / same two skips, twice consecutively with the dot reporter (9.64 s, 9.44 s).

## What works
- Task 1, helper: RED 97fbc4e → GREEN 86f45a2 (+ lint fix 1420cc5).
  - `native/notifier/Notifier.swift` + `Info.plist` (bundle id `local.aiterm.notifier`, name "AI Term", LSUIElement). Argv only: `--session <UUID> --title --body` (+ `--check` = validate and exit). It requests alert+sound authorization and posts one notification: title, body, default sound, threadIdentifier = session id, no trigger. It exits 2 s later, and gives up after 120 s if the Allow prompt is never answered. No click socket, no time-sensitive/critical level.
  - No argv (a cold launch, e.g. after a click) or bad argv → `Invalid notifier arguments`, exit 2. The spike's argv cases are adapted (its click/socket/lifetime flags are now refused) and pass against the built app.
  - `npm run build:notifier` (`scripts/build-notifier.mjs`): xcode-select + `xcrun --find swiftc` check (fixed message and exit 1 without the toolchain). swiftc builds a staged bundle; it is ad-hoc signed and verified, then swapped in whole at `build/notifier/AI Term.app`.
- Task 2, policy (D42): RED 541e1fe → GREEN aae75d9. `src/daemon/notify-policy.ts`:
  - waiting (permission, question, turn failed) always; done only when no client is attached.
  - Same status and reason → no repeat; nothing for starting/running/exited/error; nothing when the setting is off.
  - The body is the name (cleaned, 60 code points max) plus `waiting: <reason>` or `done`.
- Task 3, sending: RED 0b9259b → GREEN cc685a6.
  - `SessionManager.applyStatus` emits `statusChanged(session, previous, next, attached)`, guarded so a listener can't break status.
  - `src/daemon/notifier.ts` reads the setting per notification and runs `execFile('/usr/bin/open', ['-n','-g','-a',app,'--args',…])` with `PATH=/usr/bin:/bin`, never awaited.
  - Failures are logged once per daemon run with fixed text. `engines.status` carries `notifier: ready | not built | launch failed`.
- Task 4, setting: RED 8b044b9 → GREEN 6441ab4. `notifications` (boolean, default on) in settings.json. `/settings` row `notifications: on|off (n)`, toggled by n or Enter. A fixed `notifications unavailable: helper not built · run npm run build:notifier` / `… helper failed to launch` line appears when needed.
- Task 5, docs: f5e3e7f. README covers `npm run build:notifier`, the notifications paragraph and the `/settings n` key row. architecture.md §12.1 says v0.2.4b ships without click-through and records the helper, launch, policy and failure details. design.md /settings DEFAULTS lists notifications.
- Reviews (fresh context, high): no critical/high findings from either reviewer. Each real finding got a failing test, then a fix.
  - Security: RED 9f59f69 → GREEN 59493ec.
    - MEDIUM: unbounded helper launches from a flapping Codex card, now capped at 1 per agent per 5 s and 10 a minute, logged once.
    - LOW: `launch failed` now clears after a success.
    - LOW: the helper now refuses separators, private use and surrogates.
    - Its fourth point (a denied or rejected helper is invisible behind `open`'s exit 0) is documented, not fixable from the daemon.
  - TypeScript: RED 66f8261 → GREEN d8bffb0.
    - MEDIUM: one malformed key entry made the notifier's settings read fail and silenced notifications; it now reads through a store that skips bad keys.
    - LOW: codesign ran after the swap; the whole bundle is now staged, signed and verified first.
    - LOW: refusing *unassigned* code points could silently drop names macOS tables don't know; now accepted (the daemon strips them anyway).
    - LOW: two failed turns with different error text re-notified; reasons are now compared.
    - Its design note, that a waiting alert inside an agent's 5 s gap is dropped, was kept as a trade-off.
- Final verification, all exit 0:
  - `npm run typecheck`: `> tsc --noEmit`
  - `npm run lint`: `> eslint .`
  - `npm run build`: `ESM ⚡️ Build success in 17ms`
  - `npm run build:notifier`: `Notifier built and ad-hoc signed: /Users/yanivsp/ai-term/build/notifier/AI Term.app`
  - `npx vitest run --reporter=dot` twice: `Test Files 113 passed (113)` / `Tests 670 passed | 2 skipped (672)` / 9.64 s and 9.44 s
  - The diff doesn't touch src/daemon/keys.ts, env.ts, spikes/, docs/spikes/, docs/reviews/, .claude/, .codex/ or .agents/. No secrets, raw hex or hidden bidi characters were added. `git diff --check` is clean. No new npm dependencies.

## What's next
- After Yaniv's replay confirms banner, name, icon and sound: click-through (callback socket via a fixed private path, select or attach the agent, D43 Terminal launch through a generated `.command`), as the next step. Not started.

## Manual checks
- Ran (headless): argv cases against the built helper (`--check` only, nothing posted), `open -n -g -a <helper> --args … --check` with a minimal env (exit 0; a missing app exits 1), policy, sender, setting and panel tests with stubs.
- `cd ~/ai-term && npm run build && npm run build:notifier && node dist/cli/index.js daemon stop && node dist/cli/index.js` — needs Yaniv: restarts the daemon (stops running agents) so it has the notifier.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv: start a Codex agent and make it ask for permission (e.g. a network command). Expect the Allow prompt for "AI Term" the first time. After Allow, a banner titled "AI Term" with `<name> · waiting: permission` and the default sound; record the icon.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv: let an agent finish while you stay inside it (attached) → no banner. Let one finish while you're on the homepage → `<name> · done` banner.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv: `/settings`, press n → `notifications: off`; trigger waiting → no banner; n again to turn it back on.
- If no banner: System Settings → Notifications → AI Term must allow alerts; the helper can't report a denial to the daemon.

## Gotchas
- The helper's permission belongs to `build/notifier/AI Term.app` in this checkout. Moving the repo means a new Allow prompt. The spike's `spikes/notifier/build/AI Term.app` has the same bundle id at another path.
- The launch method is `open -n -g -a` (Launch Services): `-n` because only a fresh instance gets `--args`; `-g` so the terminal keeps focus. `open` exits 0 once the app starts, so a helper denied permission still shows `ready`.
- One notification per agent per 5 s and 10 a minute in all; extras are dropped (homepage status still shows them) and logged once.
- Clicking a notification relaunches the helper with no argv; it exits 2. Nothing else happens yet.
- `tests/notifier-helper.test.ts` skips its helper-binary cases when the app isn't built; the path and swiftc-missing cases always run.
- The build-script review fix is tested by reading the script's step order; a real codesign failure can't be triggered without a fault-injection switch.
- No real ~/.ai-term, ~/.claude, ~/.codex auth, ~/.ssh, keychain, .env or agent sessions were accessed. No notification was posted. No network except git pull/push.

## New dependencies
- None (swiftc/codesign are system tools; the build is optional).

## Concepts introduced
- Launch Services launch (`src/daemon/notifier.ts`): `open -a` asks macOS to start an app the way the Dock would, so the app gets its own identity, permissions and parent (launchd). A plain child process of the daemon would be "responsible" to the daemon's terminal. `-n` forces a new instance so `--args` arrive, and `-g` keeps it in the background.
- Edge-triggered notifications (`src/daemon/notify-policy.ts`): notify on a *change* into a state, compared by what the user would be told (status plus reason), never on the state itself. Repeated hooks or repainted titles then can't produce repeated banners.
- Staged build swap (`scripts/build-notifier.mjs`): build and sign a complete copy aside, verify it, then rename it into the fixed path. Readers see either the old complete bundle or the new one, never a half-signed mix.
