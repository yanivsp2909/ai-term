# AI Term

`ai` is a terminal UI for running AI coding agents. One homepage shows every agent:
- what it's doing, with a live preview of its screen
- your API spend and tokens for today, this week and this month
- what your Mac is doing

You type what you want built at the bottom, pick a model, and AI Term starts the right agent:
- **Claude account:** runs Claude Code.
- **ChatGPT account:** runs Codex.
- **API keys** (Anthropic, OpenAI, Microsoft Foundry): run AI Term's own agent, with exact per-turn cost, caps, budgets that stop it before a request crosses them, and a kill switch. `/settings` → `keys run on: the cli` sends keys back to the CLIs.

Agents keep running in a background service when you leave them or close the terminal. Run `ai` again and they're all still there.

Personal and learning project. macOS first; Linux and Windows by v0.8.

## Status
`ai` starts Claude Code and Codex on their own logins, and AI Term's own agent on any saved API key (see below). `/login` connects an account or saves a key in the macOS Keychain; `/settings` lists masked key metadata, tests Foundry deployments, imports selected keys from an env file without modifying it, and edits defaults/theme. This Mac updates once per second. Usage shows estimated API-key spend and tokens for today, this week and this month; subscriptions are excluded. `b` sets advisory budget limits; `/settings` offers Foundry deployment price overrides.

Ask passes explicit ask flags. New Claude agents keep a conversation UUID for `/resume`; Codex `/resume` opens its own picker in the saved folder. `/effort` chooses next-agent reasoning; Claude offers auto permission mode through `/mode`. Every Codex session uses `--no-daemon` and disables the startup update check; key sessions get only their own provider credential. Real-key approval and billing checks are in `docs/testing/v0.1.7-keys-login.md`.

## Commands and keys

Run `node dist/cli/index.js` after `npm run build`, or `npm run dev` from source. If the `ai` binary is installed, the same arguments work with `ai`.

`npm run build:notifier` builds the macOS notification helper (needs `swiftc` from the Xcode Command Line Tools) into `build/notifier/AI Term.app`, ad-hoc signed, always at that path so macOS keeps your Allow across rebuilds. Without `swiftc` it prints `Notifier not built: …` and AI Term works without notifications.

| Subcommand | Action |
|---|---|
| `ai` | Open homepage; start/connect to the background daemon |
| `ai --attach <id>` | Open the homepage straight into that agent (a full UUID; Ctrl+E goes home). A gone or finished agent stays on the homepage with a note. A notification click uses it |
| `ai --version` | Print version |
| `ai status-line` | Internal Claude status-line helper: reads stdin, reports context, prints model · ctx N% |
| `ai status-notify <json>` | Internal Codex notify helper: forwards only the turn-complete type and last reply (256 KB cap) to the daemon; always exits 0 silently |
| `ai agent` | Internal: AI Term's own agent. The daemon starts it in a PTY with the key in its env only; run by hand it explains that and exits 2 |
| `ai doctor` | Report Node, daemon, file modes, CLI installation/version and login method |
| `ai daemon` | Internal background service entry point |
| `ai daemon stop` | Stop the background service and all its sessions |
| `ai debug stats` | Print ten one-second numeric RAM/CPU diagnostics; no daemon connection; a closed output pipe exits quietly |
| `ai debug usage` | Ask the running daemon for its receiver port and last ten minutes of allowlisted numeric telemetry; never headers, credentials or bodies |
| `ai debug ls` | List session IDs, status, statusDetail, ctx=<used% or ?>, title and `· ai/<slug>` branch (Claude and Codex agents) |
| `ai debug shell [cwd]` | Create a debug shell in the folder (current folder if omitted) |
| `ai debug attach <id>` | Attach directly; Ctrl+E returns to the shell |
| `ai debug stop <id>` | Stop one session |
| `ai debug peek <id>` | Print its sanitized visible screen |

Homepage slash commands:

| Command | Action |
|---|---|
| `/model` | Choose provider tab, then own-login/key model or tested Foundry deployment; filter searches across tabs. Key rows show `· ai term` (they start AI Term's agent: Foundry deployments that passed their test, catalog chat models for Anthropic and OpenAI keys) or, with `keys run on: the cli`, the CLI and its own models; an AI Term model can't be saved as the default (defaults carry no key) |
| `/cd` | Choose folder for the next session, with directory completion |
| `/login` | Anthropic/OpenAI account login or API key; Microsoft Foundry endpoint/key/deployments and test |
| `/settings` | KEYS, ENGINES, DEFAULTS; add/import/remove/test keys, edit saved defaults/theme, set Foundry input/output prices per 1M tokens |
| `/effort [CLI default\|<level>]` | Reasoning for next agent; levels follow selected CLI; CLI default passes nothing |
| `/mode [ask\|auto\|don't ask]` | Per-session mode; Claude auto only, Codex Ask/Don't ask; saved default stays Ask |
| `/resume` | Continue selected finished Claude conversation; Codex opens its own folder-filtered resume picker |
| `/retry` | Restart the selected exited or failed agent fresh: same engine, model, auth, effort, mode and folder, in its worktree if it still has one. A new conversation, not a resume; the first message isn't resent (AI Term never keeps it). The restarted agent replaces the old card; a failed `/login` session reruns the same login. Running agents get `<name> is still running`; a deleted worktree or folder gets `<name>: its worktree is gone · start a new agent` |
| `/send <agent> <text>` | Send text to a running agent without going inside (D50): one bracketed paste, then Enter, so pasted lines arrive as one message. `<agent>` is the exact name (Tab completes and cycles running agents; with names that start alike the longest wins). Up to 16 KB; controls except newlines are dropped (tabs too). Refused, naming the agent, while it asks for permission or a question (`<agent> is asking for permission, go inside to answer`), while it's open in a session or split, after it exits, and before an AI agent has reported a turn or tool through its hooks (it may be at its folder-trust prompt: go inside once, or start it with a first message). While a Claude agent or AI Term's agent is running a tool (where permission prompts come from) /send is refused: `<agent> is running a tool and may ask permission · try again when it finishes`. The check uses the newest screen output. Shells have no status: /send types into whatever runs in them. Never logged or saved |
| `/find <text>` | Search every agent's screen and scrollback as plain text, any case. Results popup: agent, line, the match bold in accent; ↑↓ select, ⏎ selects that agent and scrolls its preview to the line, Esc closes. At most 50 hits per agent and 200 in all (`showing the first 200`) |
| `/open` · `/open code` | Open the selected agent's folder (its worktree if it has one) in Finder with `/usr/bin/open -- <path>` (a folder whose name has an extension, like `Tool.app`, is revealed with `-R` instead of launched), or in VS Code with `code -- <path>` when `code` is on PATH (otherwise a note) |
| `/shell` | Start a plain login shell in the /cd folder |
| `/copy` | Copy the agent's last reply (Claude Stop hook, Codex notify) when present; otherwise cleaned whole session with the fallback note |
| `/copy all` | Copy cleaned selected-agent scrollback and screen; up to 5 MiB, oldest content cut if needed |
| `/clean` | Confirm y/n before removing all exited/failed list records; reports removed/failed counts and first failure; running agents and files untouched; never deletes worktrees: says `kept N worktrees · /worktrees reviews them` |
| `/worktrees` | Popup listing every worktree AI Term created, including those whose agent is gone: branch, folder, what deleting would lose, and its agent if one still exists. ⏎ opens the keep/delete question |
| `/budget` | Same as `b`: daily, weekly and monthly USD limits |
| `/usage` | Same as `u`: usage details popup, each period then each provider (spend, tokens, cached share, budget). By model and by agent aren't available yet |
| `/doctor` | The `ai doctor` report in a popup: Node, daemon, file modes, CLI install, version and login method |
| `/help` | All commands and keys; ↑↓/PgUp/PgDn scroll, Esc closes |
| `/theme graphite\|slate\|ink\|auto\|light` | Save the theme |
| `/exit` | Quit client; sessions keep running |

| Keys / action | Where and behavior |
|---|---|
| ↑ / ↓ | Slash menu selects a command with wrapping; otherwise homepage selects session; pickers/settings select rows |
| Enter | Slash menu picks highlighted command (`/theme`, `/effort`, `/mode` insert argument prefixes); empty homepage field attaches; task text opens start confirmation; selected finished session shows removal hint |
| Tab | Complete the highlighted slash command; with an argument, cycle its values |
| `p` | Empty field toggles preview |
| `c` | Empty field copies the agent's last reply (Claude or Codex) when present; otherwise cleaned session with the fallback note; with field text, types c |
| `b` | Empty field opens daily/weekly/monthly USD budget limits; empty limit means none, ↑↓ edits fields, Enter saves, Esc cancels; exceeding a limit warns and never blocks |
| `u` | Empty field opens usage details (same as `/usage`); ↑↓/PgUp/PgDn scroll, Esc closes |
| `/find` ↑↓ / Enter / Esc | Select a hit / select its agent and scroll the preview to the line / close |
| `/doctor`, `/usage` ↑↓ / PgUp / PgDn / Esc | Scroll / page / close |
| `r` | Empty field renames selected session; Enter saves, Esc cancels |
| `s`, then `y` / `n` | Empty field asks to stop selected session; confirms/cancels |
| `x` | Empty field removes an exited/failed session; if it had a worktree, one keep/delete question follows (keep is the default) |
| Worktree question, clean | `remove worktree and branch ai/<slug>? k keep · d delete`; `k`, Esc or Enter keep and show `worktree kept: <path>`; `d` deletes the worktree and branch |
| Worktree question, with loss | Lists what would be lost (`3 changed files · 2 untracked · 4 commits not in main`); type the branch name and press Enter to delete; `k` or Enter on an empty field, or Esc, keep. A paste never fills it |
| `/worktrees` ↑↓ / Enter / Esc | Select a worktree / open its keep/delete question / close |
| Space | Empty field marks or unmarks the selected agent for a split (`◆ marked` on its card); up to 4; exited agents can't be marked |
| `v` | Empty field opens the marked agents side by side, in list order, and clears the marks. With none marked it reopens the split Ctrl+E left; with nothing to open it shows `Space marks 2–4 agents · v opens them side by side` |
| Split: typing and paste | Go only to the focused pane's agent |
| Split: Ctrl+\ | Focus the next pane; if a pane's agent has ended, closes the ended panes instead. Twice within 0.4 s sends one real Ctrl+\ to the agent that was focused |
| Split: click / mouse | A click focuses the pane under the pointer and reaches its agent in its own coordinates (a drag stays with the pane it started in). Mouse input reaches only the focused pane: wheel or motion over another pane does nothing until you click it |
| Split: Ctrl+E | Home; the agents keep running and `v` with nothing marked reopens the split |
| PgUp / PgDn / End | Preview scroll / follow live (End only while the command field is empty) |
| Mouse wheel / drag-release | Preview scroll / copy selection; a click alone does not copy |
| Esc | Close popup; in the command field drop a selection first, then clear the field; discards masked key input |
| Backspace | Delete the selection, or the character before the cursor; a paste token goes whole |
| Delete | Delete the selection, or the character after the cursor; a paste token goes whole |
| ← / → | Command field: move the cursor one character; a paste token is one step |
| Alt+← / Alt+→ | Command field: move the cursor by word (also ESC b / ESC f); a paste token counts as one word |
| Home / End · Ctrl+A / Ctrl+E | Command field: cursor to the start / end. End with an empty field follows the preview live instead |
| Shift+← / Shift+→ | Command field: extend a selection from the cursor |
| Command field drag | Select text, paste tokens whole (selection color = accent 38%); a click places the cursor and clears a selection; typing or paste replaces a selection; never copies |
| Ctrl+U | Clear the command field |
| Alt+Backspace (or Ctrl+W) | Delete the previous word; a paste token counts as one word. In Terminal.app, Option sends Alt only with "Use Option as Meta key" |
| Ctrl+C twice within one second | Quit client; sessions keep running |
| Ctrl+E | Inside a session or split returns home, keeping sessions running; inside pasted text it is pasted |
| SIGTERM / SIGHUP / SIGQUIT | Client cleanup and exit 143 / 129 / 131; sessions keep running |
| Start box ↑↓ / `m` / `c` / `e` / Tab / Enter | Select row / model / folder / effort / cycle Ask → auto → Don't ask (Claude) or Ask ↔ Don't ask (Codex) / start |
| Start box worktree line | `new worktree · ai/<slug> from <short HEAD>`; a dirty checkout adds `uncommitted changes in your checkout aren't included` |
| Start box message row | Type/paste to edit first message; multiline or over 200 chars becomes `[pasted · N lines]` |
| Model picker ←→ / ↑↓ / Enter / Esc | Switch provider tab (Tab also goes right) / choose model / select / back; typing searches all tabs |
| Effort or mode picker ↑↓ / Tab / Enter / Esc | Select / cycle / apply / back; CLI default effort passes nothing |
| Help ↑↓ / PgUp / PgDn / Esc | Scroll lines / previous page / next page / close |
| `/clean` y / n / Esc | Confirm finished-record removal (worktrees are kept) / cancel / cancel |
| Folder picker Tab / Enter | Complete directory / accept existing folder |
| `/login` ↑↓ / Enter | Choose provider, then account or API key; key form Enter advances/saves; secret field is masked |
| `/settings` `a` or `+` / `i` / `l` | Add key / import env file / open provider login |
| `/settings` ↑↓ / Enter / `x` / `t` | Select key/action/default row / activate (key row tests) / remove selected key / test |
| `/settings` `d` / `f` / `e` / Tab | Save default model+engine / folder / effort / cycle theme; permission default is always Ask |
| `/settings` `n` or notifications row Enter | Turn macOS notifications on or off (default on; saved with the other settings). If the helper is missing or failed to launch, the panel says `notifications unavailable: …` |
| `/settings` `w` or worktrees row Enter | Toggle `worktrees: on` / `off` (default on); applies to new agents |
| `/settings` `r` or keys row Enter | Toggle `keys run on: ai term` / `the cli` (default ai term, D47). With `the cli`, Anthropic keys start Claude Code and OpenAI and Foundry keys start Codex; account logins always start the official CLIs |
| `/settings` `c` or caps row Enter | AI Term agent caps per run: turns (model requests) and spend in USD, empty = no cap; defaults 100 turns and $5.00. A run pauses and asks at a cap |
| `/settings` `k` or context row Enter | Toggle the 85% context warning on cards and inside AI Term's agent (default on, D55) |
| `/settings` `m` on a Foundry key | Mark each deployment as a catalog model (↑↓, type to narrow, ⏎ saves; `(not set)` clears): its prices and context window then come from that model |
| `/settings` `h` or bar row Enter | Toggle `bar: off` / `on` (default off); takes effect on the next attach |
| `/settings` `p` or price row Enter | Foundry deployment price override: deployment, input and output USD per 1M; ↑↓ fields, Enter saves, Esc cancels |
| Import names ↑↓ / Space / Enter | Select name / toggle inclusion / import chosen keys |

Claude effort: `CLI default`, `low`, `medium`, `high`, `xhigh`, `max`. Codex effort: `CLI default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, `persistent`. These are CLI-supported values; individual models may accept fewer. `/settings` can save effort. Mode is per session and resets to Ask after start/cancel; auto and Don't ask cannot be saved as defaults. Older Claude records without a conversation UUID show a note instead of resuming.

The attached bar is opt-in: `/settings` → `bar: on` (`h`). It uses one surface row for glyph + status word, bold name, engine/model, `· ai/<slug>` branch, others’ counts and `^E home`; the agent gets the rows below. At narrow widths counts drop first, then branch, then model. Nothing animates. `bar: off` uses the original full-height raw passthrough. A failed startup probe uses raw for that attach and logs once. Redraw keeps link text but loses OSC 8 targets, curly/colored underlines and inline images. The Terminal.app spike’s clean vim exit is still unexplained; leave the default off until the trace and feel checks below are understood.

Splits (v0.3): Space marks 2–4 agents and `v` opens them side by side (3 side by side, or two on top and one below when that's too wide; 4 as 2×2), each pane at least 40 columns by 10 rows with a one-row header: glyph + status word, name, model and branch. The focused header is surface-2 with an accent underline. Each agent's PTY takes its pane's size minus the header; leaving the split returns them to the usual sizes. A terminal too small for every marked agent opens as many panes as fit and says how many didn't; if only one fits, it's a normal attach. An agent that exits keeps its pane, showing how it ended, until Ctrl+\ closes it; when one pane is left it becomes a normal attach. Splits redraw each agent from a client-side mirror like the bar, whatever the bar setting, and, as on the homepage, mouse reporting stays on, so your terminal's own text selection needs its mouse-reporting bypass. The pane key is Ctrl+\ rather than Ctrl+], because Claude Code 2.1.299 binds Ctrl+] by default (open artifact) and lists Ctrl+\ among the keys it never binds.

A damaged agent list no longer stops the background service (B24). If `~/.ai-term/state.json` can't be read, parsed, checked or upgraded, AI Term never writes over it: it moves the file to `state.json.corrupt-<timestamp>` (0600), starts with an empty list and shows the note `couldn't read your agent list; saved it as <file>` each time a homepage opens, until the service restarts. The log names only the stage (read, parse, validate, migrate). Worktree records go with the list, so those worktrees show in `/worktrees` as `✗ Not in AI Term's record` and are never deleted by AI Term. If the file can't even be moved, the service stops with that reason and leaves it untouched.

Letter shortcuts act only when the command field is empty. Paste a task beginning with a shortcut letter to keep that letter. Next-agent defaults show `own login · sub`, `own login · API key`, `own login`, or `key ····last4` before starting. Inside an attached CLI, its own commands and keys apply, with Ctrl+E reserved for home. `/exit` inside a CLI is that CLI's exit command.

`/copy all` copies the selected running/finished agent or shell from parsed mirror cells through the clipboard. Soft-wrapped rows join; generic cleanup strips box-drawing borders at line edges, drops decoration-only box/rule/spinner lines, collapses blank runs and trims the ends. Code indentation and internal borders stay. The 5 MiB UTF-8 cap keeps the newest text; the note says `✓ copied N lines from <name>` and adds a warning when oldest content was cut. `/copy` and empty-field `c` request Claude's last `Stop.last_assistant_message` when available (v0.2.2, memory-only, at most 256 KB, terminal controls removed). This preserves reply/code whitespace. Otherwise they copy the same cleaned session with `· last reply only comes with v0.2`; Codex last-reply ingress waits for v0.2.3. `/copy all` always keeps whole-session behavior. The screen is never used to guess a reply. Copy text is never logged or saved. The mirror is in memory, so a daemon restart cannot restore previous terminal output.

Paste into the command bar or the start box's first-message row: more than one line or more than 200 characters appears as `[pasted · N lines]`. The start box also shows the first line, clipped to fit. Full pasted text and newlines become the first message; Backspace deletes the token whole, and typing before/after it works. Small pastes stay literal. Letter shortcuts stay off while the field has text. The combined first message is limited to 16 KB (16,384 UTF-8 bytes): an oversized insertion adds nothing and says `too long for a first message (16 KB): start the agent, then paste inside`. Pasted text stays in memory and is never logged or saved.

The Usage panel marks estimates with `≈`. The tokens row shows the cache-read share inside each total, e.g. `80.8K (71.0K cached)`, or `80.8K (71.0K)` with a `(…) cached` legend when the panel is narrower; cached input is priced at the cache rate. Unknown model prices show `price ?`; the spend row includes known costs only. Foundry overrides apply their input rate to all input tokens without assuming a cache discount. Historical estimates keep the price used at ingestion. If settings cannot be read, a persistent warning appears and ingestion uses the last good prices until settings recover. Each session accepts at most 120 unique usage records per 60-second window; excess records are dropped with one fixed log line per window. Existing sessions need to be restarted to receive telemetry settings.

Key and engine failures show fixed reasons without private error text. A Foundry key's endpoint and deployments are stored with the key in the Keychain, so editing settings.json can't send the key elsewhere. Foundry keys added before v0.2.7 must be removed and added again: until then their tests and agents refuse with `Foundry key must be added again to bind its endpoint`. A malformed key metadata entry is skipped and warned about; valid keys remain usable, and skipped metadata stays on disk for later cleanup.

Claude agent sessions, including subscriptions, receive per-session HTTP hooks and AI Term's own status line. `ai status-line` reads bounded Claude JSON on stdin, prints model · ctx N%, and sends numeric context to the existing local server with the credential from its env. It replaces the user's Claude status line only inside AI Term sessions. Paths containing spaces or shell characters leave that status line off. `ai debug ls` exposes permission/question/turn-failure reasons and context; waiting and done agents remain live. Restart the daemon and create a new session to get hooks.

Codex agent sessions, including subscriptions, get status through argv only; nothing is written to `~/.codex`. Each session passes `-c notify=[<node>, <ai cli>, "status-notify"]` (left off if a path contains spaces or shell characters) plus `tui.notifications`, `tui.notification_method="osc9"`, `tui.notification_condition="always"` and `tui.terminal_title=["activity","run-state","context-remaining"]`. `ai status-notify` sends turn-complete to the daemon (done) with the last reply, kept in memory only. Codex's own thread-title turn (a last message that is only `{"title": …}`) is ignored, so it never ends a turn or replaces the reply. The daemon's own mirror reads Codex's "Approval requested" OSC 9, a bare bell or the `[ ! ] Action Required` title as waiting (permission), a change to Working as running, and `Context N% left` as ctx. Enter typed while attached after done or waiting marks it running. Restart the daemon and create a new Codex session to get status.

Notifications (v0.2.4b, macOS): with sound, titled "AI Term", body `<agent name> · waiting: permission|question|turn failed` or `<agent name> · done`. Waiting always notifies; done only when no `ai` client is attached to that agent; once per change. The body never carries prompts, replies, tool input, error text or paths. The first one asks for permission (Allow). `/settings` shows `on · allowed`, `on · blocked: turn on AI Term in System Settings → Notifications`, `on · not asked yet: you'll be asked at the first notification`, or `on · permission unknown`. Authorization is read without prompting at daemon start, when settings opens, and at most once a minute, then cached; blocked permission suppresses helper launches and logs once. Direct and Launch Services status reads both returned denied on this Mac; a failed or unverified read reports unknown. Turn them off with `n` in `/settings`.

Clicking a notification (v0.2.7) opens that agent. With an `ai` homepage open, it selects the agent there (Enter attaches, as always; if you're inside another agent, it is selected when you go home). With no `ai` open, a new Terminal window opens running `ai --attach <id>`. A click for a removed or finished agent does nothing (the daemon logs it). The click never sends text to an agent or approves anything. For known terminals (Terminal.app, iTerm2, Ghostty, WezTerm), the daemon activates the app with `/usr/bin/open -b <fixed bundle id>`, and the client writes `CSI 5 t` to raise its own window. This uses Launch Services without AppleScript or Automation permission. Window raising depends on terminal support; Terminal.app needs a manual replay on this machine. An unknown `TERM_PROGRAM` selects only and notes `selected <name> from a notification`. Terminal's own preferences decide whether it opens a window or a tab. Rebuild the helper (`npm run build:notifier`) and restart the daemon to get clicks. The daemon launches the helper with `/usr/bin/open -n -g -a <helper> --args …` and never waits on it; a missing or failing helper is logged once and shown in `/settings`. Focus and Do Not Disturb apply as usual.

Native Keychain tests are opt-in: `AITERM_NATIVE_KEYCHAIN_TEST=1 npm test -- tests/keys-store.test.ts`. Normal `npm test` skips only those two native tests and prints the reason; fake-vault tests still run.

The bundled price snapshot is trimmed from Models.dev to Anthropic, OpenAI and Azure. To regenerate after an intentional download: `curl -q --fail https://models.dev/api.json -o /tmp/ai-term-models.json`, then `npx tsx scripts/update-prices.ts /tmp/ai-term-models.json`.

New AI agents in a git repository start on their own `ai/<slug>` branch and worktree by default. Worktrees live at `~/.ai-term/worktrees/<repo-name>-<10-character path hash>/<slug>`, outside your checkout; the agent uses the same relative subfolder selected with `/cd`. The start box previews the branch and source HEAD. Only committed HEAD content is included: dirty and untracked files stay in your checkout, and gitignored files such as `node_modules` and `.env` are absent. Install dependencies or configure local files inside the new worktree as needed; AI Term does not copy them. Claude Code and Codex may ask to trust each new folder (not tested with real logins in this step).

`/settings` → `worktrees: off` (`w`) starts new agents in `/cd` directly. Non-repositories, repositories without commits and git failures also start in place, with a fixed one-line reason on the card (`worktree off: not a git repo` only when git itself says so). If `settings.json` can't be read, worktrees stay on. Plain `/shell` and login sessions stay in `/cd`. `/resume` reuses the finished agent's saved worktree.

Removing worktrees (v0.3.2). AI Term keeps its own record of every worktree it creates, with the repo and the branch and commit it started from; the record outlives the agent. `x` removes the agent's list record, then asks once about its worktree:
- **Nothing would be lost:** `remove worktree and branch ai/<slug>? k keep · d delete`. Keep is the default: `k`, Esc and Enter keep. `d` runs `git worktree remove` then `git branch -d`, never forced, so git refuses by itself if anything changed.
- **Something would be lost:** the question lists it plainly: changed files (modified, staged, deleted), untracked files, and commits on `ai/<slug>` that aren't in the branch it was made from (merged work counts as safe). To delete anyway, type the branch name and press Enter. `k` or Enter on an empty field, or Esc, keeps it. One keypress never deletes work, and a paste never fills the name. Only then does AI Term force the remove and use `-D`, and only if nothing changed since you saw the list.
- Changed files include edits hidden from `git status` by `assume-unchanged` or `skip-worktree` flags, and any submodule folder that holds something (AI Term never runs git inside a submodule, so whatever is in it counts as work that would go). Untracked folders that are git repositories are called out, since their history goes too.
- Ignored files (`node_modules`, `.env`) go with any delete. They aren't counted as loss, but the question says how many there are; an ignored folder counts once. Only rules from a `.gitignore` committed in the repo count: files hidden by `.git/info/exclude`, a repo `core.excludesFile` or an uncommitted `.gitignore` count as untracked.
- The question also notes when a folder was already deleted by hand, when the base branch is gone (commits are then counted from where the agent started), and, for agents started before v0.3.2, that the base wasn't recorded and your checkout's current branch is used instead.

AI Term refuses, with a fixed reason and without touching anything:
- a path it has no record of
- a path outside `~/.ai-term/worktrees`, or one with a symlink in it
- a record pointing at a main checkout, or a repo that doesn't match the worktree's folder
- a worktree git doesn't list, a locked worktree, or one no longer on its own `ai/<slug>` branch (for example renamed)
- a branch checked out somewhere else
- a running or waiting agent: stop it first

If a step fails, it stops and says which step (`Worktree remove failed; branch kept` or `Worktree removed; branch delete failed`). It never deletes files itself and never touches another worktree or branch. `/clean` only removes list records and says how many worktrees it kept. `/worktrees` lists them all for later; folders in `~/.ai-term/worktrees` that no record claims (from agents removed before v0.3.2) appear as `✗ Not in AI Term's record` and are never deleted by AI Term. Remove those yourself with `git worktree remove` if you don't need them.

## AI Term's agent (v0.4.2)

Every API key runs AI Term's own agent (D47; `/settings` → `keys run on: the cli` sends keys back to Claude Code and Codex). In `/model`: a tested Foundry deployment (GPT ones over the Responses API, others such as Grok, Kimi, DeepSeek or GLM over Chat Completions, each one tested with a tiny request first), or one of the catalog's chat models for an Anthropic or OpenAI key; every row reads `· ai term`. Type a task, keep Ask, ⏎. The card, preview, bar, splits, notifications, `c` and Usage work as for the CLIs.

- **Keys:** only in the agent's own environment, never in argv, a file, a log or the protocol. Each goes only to its own host in its own header: Foundry to the endpoint bound to the key in the Keychain (`api-key`), Anthropic to api.anthropic.com (`x-api-key`), OpenAI to api.openai.com (bearer). Redirects are refused; provider error text is never shown.
- **Tools:** read, write, edit, bash, search (ripgrep when installed, else plain text). File tools stay inside the agent's folder (its worktree): `..`, absolute paths elsewhere and symlinks that lead out are refused. bash runs `/bin/sh -c <command>` in the folder with a 2-minute default limit (10 at most), 64 KB of output per stream, no stdin, and a minimal environment with no API keys and nothing of AI Term's. bash is not sandboxed: it runs as you, like Claude Code's.
- **Ask (default):** every write, edit and bash shows exactly what will run (the command, or the path and the changed lines; escape sequences and invisible characters show as `␛` and `<U+…>`) and waits for `y` or `n`. An approval taller than the screen pages: Space shows the next page, and `y` works only on the last one. Commands over 16 KB are refused. Reads and searches never ask. Don't ask is per session only (red `!`), never a saved default.
- **Instructions:** the folder's `AGENTS.md`, then `CLAUDE.md` with its `@file` import lines, go into the system prompt (inside the folder only, 64 KB per file).
- **Cost:** after each turn, one line with the provider's own counts and the exact price: `turn · 12.3k in · 4.0k cached · 812 out · 310 reasoning · $0.0123 · run …`. Priced like Usage (D45 list prices; a Foundry deployment uses its price override, else the model you marked it as in `/settings` → `m`, else its own name).
- **Limits (D49, D53):** before every request the agent checks the run's caps and your budgets against the worst case for that request (every input character as a third of a token, the full output allowance). It pauses and asks, before anything is sent, when the next request could cross the daily, weekly or monthly budget (raise it with `b` on the homepage, then ⏎ checks again), when the run reaches its turn cap (a turn is one request to the model) or spend cap (⏎ allows as much again), when no price is known for the model while any limit is set, or when AI Term doesn't answer. Esc stops. Defaults: 100 turns and $5.00 per run (`/settings` → `c`); `/caps` changes one run.
- **Kill switch:** Ctrl+K stops the request and kills every running command's whole process group at once (no grace period); queued messages are dropped. `s` on the homepage does the same and stops the agent.
- **Context:** ctx % on the card and the bar, from the model's context window in the catalog. At 85% the agent and the card show `context 85% · /clear or start fresh` once per crossing (a CLI card says `/compact`); `/settings` → `k` turns it off. The catalog shipped before v0.4.2 has no context windows: refresh it (manual checks in PROGRESS.md) and ctx % appears.
- `/resume` isn't available yet; `/retry` starts it fresh.

| Inside the agent | Action |
|---|---|
| Type, ⏎ | Send a message; a message sent during a turn waits for it to end. Paste arrives whole |
| `y` / `n` | Allow / deny the write, edit or command shown. A paste never answers |
| Space | Next page of a long approval (`y` counts on the last page) |
| ⏎ / Esc at a pause | Go on past a cap or a raised budget / stop the turn. A paste never answers |
| Esc | Interrupt the turn (a pending approval is denied); on an idle prompt, clear it |
| Ctrl+K | Kill switch: stop the request and kill every running command now |
| Ctrl+C twice | Quit the agent (within 3 s); Ctrl+D on an empty prompt counts too |
| `/model [id]` | List or switch to another model of the same key |
| `/caps [turns N\|off] [spend USD\|off]` | Show or change this run's caps |
| `/clear` | Forget the conversation (frees the context) |
| `/cd <folder>` | Work in another folder; its `AGENTS.md` is read again |
| `/help` · `/exit` | List these · quit |
| Ctrl+E | Home, as in any session |

## Docs
- `AGENTS.md`: rules for every coding agent working here
- `docs/architecture.md`: how it works, the protocol, security checks, decisions
- `docs/design.md` and `docs/design/tokens.json`: the approved UI
- `docs/spikes/`: what each spike step found
