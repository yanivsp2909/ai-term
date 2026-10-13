# AI Term

`ai` is a terminal UI for running AI coding agents. One homepage shows every agent:
- what it's doing, with a live preview of its screen
- your API spend and tokens for today, this week and this month
- what your Mac is doing

You type what you want built at the bottom, pick a model, and AI Term starts the right agent:
- **Claude account:** runs Claude Code.
- **ChatGPT account:** runs Codex.
- **API keys** (Anthropic, Microsoft Foundry, more later): run AI Term's own agent from v0.4. Until then they run on Claude Code and Codex.

Agents keep running in a background service when you leave them or close the terminal. Run `ai` again and they're all still there.

Personal and learning project. macOS first; Linux and Windows by v0.8.

## Status
`ai` starts Claude Code and Codex on their own logins or saved API keys. `/login` connects an account or saves a key in the macOS Keychain; `/settings` lists masked key metadata, tests Foundry deployments, imports selected keys from an env file without modifying it, and edits defaults/theme. This Mac updates once per second. Usage shows estimated API-key spend and tokens for today, this week and this month; subscriptions are excluded. `b` sets advisory budget limits; `/settings` offers Foundry deployment price overrides.

Ask passes explicit ask flags. New Claude agents keep a conversation UUID for `/resume`; Codex `/resume` opens its own picker in the saved folder. `/effort` chooses next-agent reasoning; Claude offers auto permission mode through `/mode`. Every Codex session uses `--no-daemon` and disables the startup update check; key sessions get only their own provider credential. Real-key approval and billing checks are in `docs/testing/v0.1.7-keys-login.md`.

## Commands and keys

Run `node dist/cli/index.js` after `npm run build`, or `npm run dev` from source. If the `ai` binary is installed, the same arguments work with `ai`.

`npm run build:notifier` builds the macOS notification helper (needs `swiftc` from the Xcode Command Line Tools) into `build/notifier/AI Term.app`, ad-hoc signed, always at that path so macOS keeps your Allow across rebuilds. Without `swiftc` it prints `Notifier not built: …` and AI Term works without notifications.

| Subcommand | Action |
|---|---|
| `ai` | Open homepage; start/connect to the background daemon |
| `ai --version` | Print version |
| `ai status-line` | Internal Claude status-line helper: reads stdin, reports context, prints model · ctx N% |
| `ai status-notify <json>` | Internal Codex notify helper: forwards only the turn-complete type and last reply (256 KB cap) to the daemon; always exits 0 silently |
| `ai doctor` | Report Node, daemon, file modes, CLI installation/version and login method |
| `ai daemon` | Internal background service entry point |
| `ai daemon stop` | Stop the background service and all its sessions |
| `ai debug stats` | Print ten one-second numeric RAM/CPU diagnostics; no daemon connection; a closed output pipe exits quietly |
| `ai debug usage` | Ask the running daemon for its receiver port and last ten minutes of allowlisted numeric telemetry; never headers, credentials or bodies |
| `ai debug ls` | List session IDs, status, statusDetail, ctx=<used% or ?> and title (Claude and Codex agents) |
| `ai debug shell [cwd]` | Create a debug shell in the folder (current folder if omitted) |
| `ai debug attach <id>` | Attach directly; Ctrl+E returns to the shell |
| `ai debug stop <id>` | Stop one session |
| `ai debug peek <id>` | Print its sanitized visible screen |

Homepage slash commands:

| Command | Action |
|---|---|
| `/model` | Choose provider tab, then own-login/key model or tested Foundry deployment; filter searches across tabs |
| `/cd` | Choose folder for the next session, with directory completion |
| `/login` | Anthropic/OpenAI account login or API key; Microsoft Foundry endpoint/key/deployments and test |
| `/settings` | KEYS, ENGINES, DEFAULTS; add/import/remove/test keys, edit saved defaults/theme, set Foundry input/output prices per 1M tokens |
| `/effort [CLI default\|<level>]` | Reasoning for next agent; levels follow selected CLI; CLI default passes nothing |
| `/mode [ask\|auto\|don't ask]` | Per-session mode; Claude auto only, Codex Ask/Don't ask; saved default stays Ask |
| `/resume` | Continue selected finished Claude conversation; Codex opens its own folder-filtered resume picker |
| `/shell` | Start a plain login shell in the /cd folder |
| `/copy` | Copy the agent's last reply (Claude Stop hook, Codex notify) when present; otherwise cleaned whole session with the fallback note |
| `/copy all` | Copy cleaned selected-agent scrollback and screen; up to 5 MiB, oldest content cut if needed |
| `/clean` | Confirm y/n before removing all exited/failed list records; reports removed/failed counts and first failure; running agents and files untouched |
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
| `r` | Empty field renames selected session; Enter saves, Esc cancels |
| `s`, then `y` / `n` | Empty field asks to stop selected session; confirms/cancels |
| `x` | Empty field removes an exited/failed session |
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
| Ctrl+E | Inside session returns home, keeping session running; inside pasted text it is pasted |
| SIGTERM / SIGHUP / SIGQUIT | Client cleanup and exit 143 / 129 / 131; sessions keep running |
| Start box ↑↓ / `m` / `c` / `e` / Tab / Enter | Select row / model / folder / effort / cycle Ask → auto → Don't ask (Claude) or Ask ↔ Don't ask (Codex) / start |
| Start box message row | Type/paste to edit first message; multiline or over 200 chars becomes `[pasted · N lines]` |
| Model picker ←→ / ↑↓ / Enter / Esc | Switch provider tab (Tab also goes right) / choose model / select / back; typing searches all tabs |
| Effort or mode picker ↑↓ / Tab / Enter / Esc | Select / cycle / apply / back; CLI default effort passes nothing |
| Help ↑↓ / PgUp / PgDn / Esc | Scroll lines / previous page / next page / close |
| `/clean` y / n / Esc | Confirm finished-record removal / cancel / cancel |
| Folder picker Tab / Enter | Complete directory / accept existing folder |
| `/login` ↑↓ / Enter | Choose provider, then account or API key; key form Enter advances/saves; secret field is masked |
| `/settings` `a` or `+` / `i` / `l` | Add key / import env file / open provider login |
| `/settings` ↑↓ / Enter / `x` / `t` | Select key/action/default row / activate (key row tests) / remove selected key / test |
| `/settings` `d` / `f` / `e` / Tab | Save default model+engine / folder / effort / cycle theme; permission default is always Ask |
| `/settings` `n` or notifications row Enter | Turn macOS notifications on or off (default on; saved with the other settings). If the helper is missing or failed to launch, the panel says `notifications unavailable: …` |
| `/settings` `p` or price row Enter | Foundry deployment price override: deployment, input and output USD per 1M; ↑↓ fields, Enter saves, Esc cancels |
| Import names ↑↓ / Space / Enter | Select name / toggle inclusion / import chosen keys |

Claude effort: `CLI default`, `low`, `medium`, `high`, `xhigh`, `max`. Codex effort: `CLI default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, `persistent`. These are CLI-supported values; individual models may accept fewer. `/settings` can save effort. Mode is per session and resets to Ask after start/cancel; auto and Don't ask cannot be saved as defaults. Older Claude records without a conversation UUID show a note instead of resuming.

Letter shortcuts act only when the command field is empty. Paste a task beginning with a shortcut letter to keep that letter. Next-agent defaults show `own login · sub`, `own login · API key`, `own login`, or `key ····last4` before starting. Inside an attached CLI, its own commands and keys apply, with Ctrl+E reserved for home. `/exit` inside a CLI is that CLI's exit command.

`/copy all` copies the selected running/finished agent or shell from parsed mirror cells through the clipboard. Soft-wrapped rows join; generic cleanup strips box-drawing borders at line edges, drops decoration-only box/rule/spinner lines, collapses blank runs and trims the ends. Code indentation and internal borders stay. The 5 MiB UTF-8 cap keeps the newest text; the note says `✓ copied N lines from <name>` and adds a warning when oldest content was cut. `/copy` and empty-field `c` request Claude's last `Stop.last_assistant_message` when available (v0.2.2, memory-only, at most 256 KB, terminal controls removed). This preserves reply/code whitespace. Otherwise they copy the same cleaned session with `· last reply only comes with v0.2`; Codex last-reply ingress waits for v0.2.3. `/copy all` always keeps whole-session behavior. The screen is never used to guess a reply. Copy text is never logged or saved. The mirror is in memory, so a daemon restart cannot restore previous terminal output.

Paste into the command bar or the start box's first-message row: more than one line or more than 200 characters appears as `[pasted · N lines]`. The start box also shows the first line, clipped to fit. Full pasted text and newlines become the first message; Backspace deletes the token whole, and typing before/after it works. Small pastes stay literal. Letter shortcuts stay off while the field has text. The combined first message is limited to 16 KB (16,384 UTF-8 bytes): an oversized insertion adds nothing and says `too long for a first message (16 KB): start the agent, then paste inside`. Pasted text stays in memory and is never logged or saved.

The Usage panel marks estimates with `≈`. The tokens row shows the cache-read share inside each total, e.g. `80.8K (71.0K cached)`, or `80.8K (71.0K)` with a `(…) cached` legend when the panel is narrower; cached input is priced at the cache rate. Unknown model prices show `price ?`; the spend row includes known costs only. Foundry overrides apply their input rate to all input tokens without assuming a cache discount. Historical estimates keep the price used at ingestion. If settings cannot be read, a persistent warning appears and ingestion uses the last good prices until settings recover. Each session accepts at most 120 unique usage records per 60-second window; excess records are dropped with one fixed log line per window. Existing sessions need to be restarted to receive telemetry settings.

Key and engine failures show fixed reasons without private error text. A malformed key metadata entry is skipped and warned about; valid keys remain usable, and skipped metadata stays on disk for later cleanup.

Claude agent sessions, including subscriptions, receive per-session HTTP hooks and AI Term's own status line. `ai status-line` reads bounded Claude JSON on stdin, prints model · ctx N%, and sends numeric context to the existing local server with the credential from its env. It replaces the user's Claude status line only inside AI Term sessions. Paths containing spaces or shell characters leave that status line off. `ai debug ls` exposes permission/question/turn-failure reasons and context; waiting and done agents remain live. Restart the daemon and create a new session to get hooks.

Codex agent sessions, including subscriptions, get status through argv only; nothing is written to `~/.codex`. Each session passes `-c notify=[<node>, <ai cli>, "status-notify"]` (left off if a path contains spaces or shell characters) plus `tui.notifications`, `tui.notification_method="osc9"`, `tui.notification_condition="always"` and `tui.terminal_title=["activity","run-state","context-remaining"]`. `ai status-notify` sends turn-complete to the daemon (done) with the last reply, kept in memory only. Codex's own thread-title turn (a last message that is only `{"title": …}`) is ignored, so it never ends a turn or replaces the reply. The daemon's own mirror reads Codex's "Approval requested" OSC 9, a bare bell or the `[ ! ] Action Required` title as waiting (permission), a change to Working as running, and `Context N% left` as ctx. Enter typed while attached after done or waiting marks it running. Restart the daemon and create a new Codex session to get status.

Notifications (v0.2.4b, macOS): with sound, titled "AI Term", body `<agent name> · waiting: permission|question|turn failed` or `<agent name> · done`. Waiting always notifies; done only when no `ai` client is attached to that agent; once per change. The body never carries prompts, replies, tool input, error text or paths. The first one asks for permission (Allow). Turn them off with `n` in `/settings`. Clicking a notification does nothing yet. The daemon launches the helper with `/usr/bin/open -n -g -a <helper> --args …` and never waits on it; a missing or failing helper is logged once and shown in `/settings`. Focus and Do Not Disturb apply as usual.

Native Keychain tests are opt-in: `AITERM_NATIVE_KEYCHAIN_TEST=1 npm test -- tests/keys-store.test.ts`. Normal `npm test` skips only those two native tests and prints the reason; fake-vault tests still run.

The bundled price snapshot is trimmed from Models.dev to Anthropic, OpenAI and Azure. To regenerate after an intentional download: `curl -q --fail https://models.dev/api.json -o /tmp/ai-term-models.json`, then `npx tsx scripts/update-prices.ts /tmp/ai-term-models.json`.

## Docs
- `AGENTS.md`: rules for every coding agent working here
- `docs/architecture.md`: how it works, the protocol, security checks, decisions
- `docs/design.md` and `docs/design/tokens.json`: the approved UI
- `docs/spikes/`: what each spike step found
