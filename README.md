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
`ai` starts Claude Code and Codex on their own logins or saved API keys. `/login` connects an account or saves a key in the macOS Keychain; `/settings` lists masked key metadata, tests Foundry deployments, imports selected keys from an env file without modifying it, and edits defaults/theme. This Mac updates once per second. Usage numbers remain planned for v0.1.8b.

Ask passes explicit ask flags. Every Codex session uses `--no-daemon` and disables the startup update check; key sessions get only their own provider credential. Real-key approval and billing checks are in `docs/testing/v0.1.7-keys-login.md`.

## Commands and keys

Run `node dist/cli/index.js` after `npm run build`, or `npm run dev` from source. If the `ai` binary is installed, the same arguments work with `ai`.

| Subcommand | Action |
|---|---|
| `ai` | Open homepage; start/connect to the background daemon |
| `ai --version` | Print version |
| `ai doctor` | Report Node, daemon, file modes, CLI installation/version and login method |
| `ai daemon` | Internal background service entry point |
| `ai daemon stop` | Stop the background service and all its sessions |
| `ai debug ls` | List session IDs, status and title |
| `ai debug shell [cwd]` | Create a debug shell in the folder (current folder if omitted) |
| `ai debug attach <id>` | Attach directly; Ctrl+E returns to the shell |
| `ai debug stop <id>` | Stop one session |
| `ai debug peek <id>` | Print its sanitized visible screen |

Homepage slash commands:

| Command | Action |
|---|---|
| `/model` | Choose account/key model or tested Foundry deployment; filter accepts a custom ID |
| `/cd` | Choose folder for the next session, with directory completion |
| `/login` | Anthropic/OpenAI account login or API key; Microsoft Foundry endpoint/key/deployments and test |
| `/settings` | KEYS, ENGINES, DEFAULTS; add/import/remove/test keys and edit saved defaults/theme |
| `/theme graphite\|slate\|ink\|auto\|light` | Save the theme |
| `/exit` | Quit client; sessions keep running |

| Keys / action | Where and behavior |
|---|---|
| ↑ / ↓ | Homepage selects session; picker selects model/key/provider; key form selects field |
| Enter | Empty homepage field attaches; task text opens start confirmation; selected finished session shows removal hint |
| `p` | Empty field toggles preview |
| `r` | Empty field renames selected session; Enter saves, Esc cancels |
| `s`, then `y` / `n` | Empty field asks to stop selected session; confirms/cancels |
| `x` | Empty field removes an exited/failed session |
| PgUp / PgDn / End | Preview scroll / follow live |
| Mouse wheel / drag-release | Preview scroll / copy selection; a click alone does not copy |
| Esc | Close popup or clear command field; discards masked key input |
| Backspace | Edit the current field |
| Ctrl+C twice within one second | Quit client; sessions keep running |
| Ctrl+E | Inside session returns home, keeping session running; inside pasted text it is pasted |
| SIGTERM / SIGHUP / SIGQUIT | Client cleanup and exit 143 / 129 / 131; sessions keep running |
| Start box ↑↓ / `m` / `c` / Tab / Enter | Select row / model picker / folder picker / toggle Ask ↔ Don't ask / start |
| Start box message row | Type/paste to edit first message |
| Model picker ↑↓ / Tab / Enter | Select / choose engine for custom ID / use model |
| Folder picker Tab / Enter | Complete directory / accept existing folder |
| `/login` ↑↓ / Enter | Choose provider, then account or API key; key form Enter advances/saves; secret field is masked |
| `/settings` `a` or `+` / `i` / `l` | Add key / import env file / open provider login |
| `/settings` ↑↓ / `x` / `t` or Enter | Select saved key / remove it / test Foundry deployments |
| `/settings` `d` / `f` / Tab | Save default model+engine / folder / cycle theme; permission default is always Ask |
| Import names ↑↓ / Space / Enter | Select name / toggle inclusion / import chosen keys |

Letter shortcuts act only when the command field is empty. Paste a task beginning with a shortcut letter to keep that letter. Inside an attached CLI, its own commands and keys apply, with Ctrl+E reserved for home. `/exit` inside a CLI is that CLI's exit command.

## Docs
- `AGENTS.md`: rules for every coding agent working here
- `docs/architecture.md`: how it works, the protocol, security checks, decisions
- `docs/design.md` and `docs/design/tokens.json`: the approved UI
- `docs/spikes/`: what each spike step found
