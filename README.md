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
`ai` opens the v0.1.5 homepage with shell sessions, live read-only previews, attach/Ctrl+E home, scroll/copy, and saved themes. Create a shell with `ai debug shell [cwd]`. Agent starting comes in v0.1.6; login/keys in v0.1.7; usage and Mac stats in v0.1.8. See `PROGRESS.md` and `docs/testing/v0.1.5-homepage.md` for verification and manual checks.

## Docs
- `AGENTS.md`: rules for every coding agent working here
- `docs/architecture.md`: how it works, the protocol, security checks, decisions
- `docs/design.md` and `docs/design/tokens.json`: the approved UI
- `docs/spikes/`: what each spike step found
