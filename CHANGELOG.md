# Changelog

AI Term is the `ai` command: a terminal screen for running AI coding agents, with a background service that keeps them running. Newest first.

Dates are commit dates from `git log` for each version's own work. Between 2026-10-11 and 2026-10-15 everything was built in a few days, so most later versions share one date.

## v1.0 (unreleased)

Started 2026-10-15. Not released yet.

### v0.9.3: diagnostics, performance, polish (2026-10-15)
- **Language-server errors for the agent.** `/settings` `z` turns on diagnostics for AI Term's own agent. After each write or edit, the agent sees that file's errors, at most 40 lines. It uses a language server already on your PATH (TypeScript, Python, Go or Rust). Off by default, since it adds tokens to every write.
- **Safer diagnostics.** Each server runs in the agent's bash sandbox with no API keys. Where there is no sandbox, no server starts, and the agent is told once why.
- **Faster.** Measured against v0.9.2 on the same Mac, back to back:
  - Typing in an agent echoes in 0.75 ms instead of 2.1 ms (p95).
  - `ai` reaches the homepage in 0.11 s instead of 0.35 s.
  - The background service uses 91 MB instead of 120 MB with 10 agents.
  - The homepage uses about a quarter less CPU.
- **Performance check script.** `scripts/perf-ab.py` runs two builds back to back and compares memory, redraw CPU, cold start and typing delay. It compares the two builds, not absolute numbers, so a busy Mac doesn't skew it.
- **Diagnostics say what's missing.** The `/settings` row lists the language servers it found. If none is installed for a language, the agent is told once, with the command that installs it.
- **Consistent wording.** The README command list matches the `/help` text. Key hints use one verb style: Esc closes or cancels, ⏎ saves or selects. Every popup has a test that Esc closes it. Error messages fit on one line. Colors come only from the theme.

### v1.0.1: install and docs
- **A README you can start from.** What AI Term is, how to install it from source or as the Mac app with its `ai` link, notes for Linux and Windows, a first run in five steps, and the security model in plain words, including what Don't ask can still do in your home.
- **A user guide** (`docs/user-guide.md`) with one section per area, and this changelog.
- **`ai doctor` checks more.** It reports the sandbox (sandbox-exec, bwrap or none, and why) and whether the credential store answers (asked of the background service, the only part that touches it). It also says whether `gh` is installed and logged in (from `gh auth status`'s exit code only, never its output or token) and whether the notifier is built.

### v1.0.2: /brain
- Coming next.

## v0.9 (2026-10-15)

Work that starts agents or runs code by itself. Both features are off by default.

- **Queue** (`/queue`, `/queue add`; `/settings` `b`, off). Start an agent after another one finishes, or at a set time. Each queued agent needs a limit: a turn cap and dollar budget for AI Term's agent, a dollar budget for a key-based CLI, or a stop time for a subscription. Queued items survive a restart. A time you slept through is marked missed and never starts on its own.
- **Dev servers** (`/dev-cmd`, `/dev`; `/settings` `y`, off). Set your project's dev server command once. `/dev` shows the exact command, folder and address, and starts it only when you press `y`. Each worktree gets its own port from 4100 to 4199. On macOS the server runs in the test sandbox. It can listen on its own port only and cannot reach the internet (D55, D56).

## v0.8 (2026-10-15)

AI Term now runs on Linux and Windows, not only macOS.

- **Linux** (v0.8.1). Tests and the agent's bash run in a bubblewrap sandbox. Keys live in the Secret Service (GNOME Keyring or KWallet). With no keyring running, key features refuse. AI Term never falls back to a file.
- **Windows** (v0.8.2). The background service talks over a named pipe that only your account can use, guarded by a token. Keys live in Windows Credential Manager. npm's `.cmd` launchers run through `node`, never through `cmd.exe`, so a first message with `%` or `&` can't become a command.
- **No sandbox, no surprises** (D58, D59). Without a working sandbox, tests never run by themselves; `/test` asks every time. AI Term's agent is Ask only.
- **Release-gate fixes.** The agent's bash can't write your shell startup files, git's global config, or the Claude and Codex folders (D57). macOS refuses to rename a folder above a protected file. Linux hides session sockets from the agent's bash. The agent may install tools into `~/.local/bin`, and you are told that a program there could run later.
- **No cloud CI.** The GitHub Actions workflow was removed. Tests run on your Mac.

## v0.7 (2026-10-15)

Review what an agent did before it reaches your code.

- **Diff view** (`d` on a card, `/diff`; v0.7.1). A read-only popup of everything the agent changed since it started, including new files. `/diff <a> vs <b>` compares two agents (v0.7.4).
- **Export** (`/export`; v0.7.1). Saves a session as one HTML file in `~/Downloads`, with keys, tokens and passwords replaced by `[redacted]`. The file has no scripts and no links, and only you can read it.
- **Undo and redo** (`/undo`, `/redo`; v0.7.2, on; `/settings` `u`). A snapshot is taken after each turn. Undo shows each file it will change and asks first. AI Term keeps the agent's branch and commits unchanged.
- **Merge** (`/merge`; v0.7.3). Merges an agent's branch into your checkout, only when the checkout is clean and on the base branch. It shows the exact git commands first and aborts a conflict at once.
- **Pull requests** (`/pr`; v0.7.3). Pushes the branch and opens a PR with your own `gh`. A secret scan runs first; `/settings` `v` turns it off (D55).
- **Auto-test** (`/test-cmd`, `/test`; v0.7.4, on; `/settings` `j`). After a turn, your test command runs in the worktree. On macOS it runs in a sandbox with no network and no access to your key folders (D56).
- **Review, fork, compact** (v0.7.4). `/review` sends the diff to one model you pick, after a price check. `/fork` runs the same first message on another model. `/compact` shortens a long conversation in AI Term's agent.
- **Fixes B26 to B28.** A per-project switch for `127.0.0.1` access in tests. Prices per provider. A budgeted run waits for a price instead of guessing.

## v0.6 (2026-10-15)

Budgets, accounts and more providers.

- **Budgets across agents** (v0.6.1, B25). Two agents near the same budget can't both spend past it. The daemon holds each request's worst-case cost first. Each card and `/usage` show cost per task.
- **Saved setups** (`/preset`, v0.6.2, on). Save an engine, model, account and folder as a named start. Keys are never saved in a preset.
- **Handoff** (`/handoff`, v0.6.3, off). Moves a running agent's work to the other engine through a short note. It spends tokens, so it asks first (D49).
- **Several accounts per engine** (`/account`, v0.6.4, D53). Each extra account gets its own config folder and login. AI Term never switches accounts by itself. At a usage limit, it pauses and waits for you.
- **More providers** (v0.6.5). xAI, Moonshot, Z.ai, OpenRouter, Amazon Bedrock, Google Vertex (express mode) and Ollama on this Mac, which needs no key.
- **Gate fixes.** Handoff names the account it starts on, redacts secrets from its note, and refuses to run without its budget record.

## v0.5 (2026-10-14 to 2026-10-15)

A Mac app.

- **AI Term.app.** A window that runs `ai` and its service with a bundled runtime, so you don't need Node. Closing the window keeps your agents running. Quitting does too.
- **Install the `ai` command** (App menu). Creates one link at `~/.local/bin/ai`. It needs no sudo and changes no shell profile. Uninstall removes only that link.
- **Mac niceties.** Native menus, Light, Dark and System appearance, and font-size keys (⌘+, ⌘−, ⌘0).
- **Signing.** The app is ad-hoc signed and not notarized, so the first launch needs right-click, then Open.

## v0.4 (2026-10-14)

AI Term's own agent. API keys run it.

- **Agent on your key** (D47). Each API key starts AI Term's agent. It reads and edits files in its folder and runs commands. In Ask mode it asks before each write, edit or command.
- **Exact cost and caps** (v0.4.2). Each turn shows its exact price. A run stops and asks at 100 turns or $5, the defaults. Budgets stop a request before it would cross them (D49).
- **Kill switch.** Ctrl+K stops the current request and every running command at once.
- **Your skills, read-only** (D48, v0.4.3). Skills, subagents and commands from your Claude and Codex folders can load. Credentials, settings and history are never read.
- **MCP servers** (v0.4.4). Add a server yourself. Its secrets go to the Keychain. Every tool call asks y/n, including in Don't ask.
- **Keys stay out of reach** (D57). A key is never in the agent's environment. On macOS, the agent's bash can't read or write `~/.ai-term` or reach AI Term's sockets.

## v0.3 (2026-10-13 to 2026-10-14)

Worktrees, splits and more commands.

- **Own branch per agent** (v0.3.1, D19, D44). A new agent in a git repository gets its own `ai/<name>` branch and folder, outside your checkout. Only committed files are copied in. Turn it off with `/settings` `w`.
- **Safe removal** (v0.3.2). Removing an agent asks once: keep or delete the worktree. Delete is refused when it would lose work, unless you type the branch name. `/worktrees` lists every worktree AI Term made.
- **Splits.** Mark 2 to 4 agents with Space and open them side by side with `v`. Ctrl+\ moves between panes.
- **Commands.** `/retry`, `/send` (types into a running agent, D50), `/find`, `/open`, `/doctor`, `/budget`, `/usage`.
- **Damaged list kept.** If the agent list file can't be read, it is moved aside, never overwritten (B24).

## v0.2 (2026-10-12 to 2026-10-13)

The homepage shows what each agent is doing.

- **Live status.** Each card shows running, waiting, done or failed, with a word and a glyph. Claude and Codex report through their own hooks (D37, D38).
- **Context.** Each card shows how full the agent's context window is.
- **Notifications** (macOS, with sound). You hear about an agent that waits for you, or that finishes while you're away. The text never includes prompts or replies. Clicking one opens that agent (v0.2.7, D42, D43).
- **Top bar** (`/settings` `bar`, off). An optional line above an attached agent with its status and branch.
- **Copy the last reply.** `/copy` and `c` copy an agent's last reply for Claude and Codex. The text is kept in memory only.
- **Local-only usage receiver.** Usage numbers arrive on `127.0.0.1` only, and must carry a token.

## v0.1 (2026-10-11 to 2026-10-12)

The first version. One screen for every agent, kept alive by a background service.

- **Homepage.** Every agent in one list, a live preview of the selected one, Usage, This Mac and a command bar at the bottom.
- **Agents keep running.** Close the window or press Ctrl+C twice, and the agents keep going. Run `ai` again and they are all still there.
- **Your logins, untouched.** A Claude account runs Claude Code. A ChatGPT account runs Codex. AI Term never reads or copies their login files (D17).
- **Attach and return.** Enter opens an agent full screen. Ctrl+E goes back home.
- **Keys in the Keychain** (`/login`, `/settings`). API keys are stored in the macOS Keychain, never in a file. Importing from `.env` reads it and never writes it (D15).
- **Account sessions stay on the subscription.** Their API-key variables are removed, so a subscription can't quietly bill a key (D16).
- **Ask by default** (D13, D40). Ask passes explicit flags, so your own CLI settings can't turn it into Don't ask.
- **Spend estimates.** Usage shows estimated API spend and tokens for today, this week and this month. Subscriptions are not counted. `b` sets budget limits.
- **Local socket.** The service listens on a socket only you can use. Any program running as you can use it too. That is an accepted risk (D18, D35).
