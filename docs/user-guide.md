# AI Term user guide

Run `ai` in your terminal. The homepage lists your agents. Type what you want built in the command bar at the bottom. Commands start with `/`; `/help` lists them all, and the README has the [full command and key list](../README.md#commands-and-keys) and the [security model](../README.md#security-model-in-plain-words).


## First run

The first time you start `ai` with an empty AI Term folder, the homepage shows a short setup instead of an empty list: which agent CLIs and tools are installed, which are logged in, which API keys AI Term already holds, whether a sandbox is available, and what to do next. Press `l` to log in to a CLI, `k` to add an API key, `b` to set a budget or `d` to pick a default engine; ⏎ finishes and Esc skips. It won't show again by itself; `ai setup` brings it back any time. AI Term only runs each tool's `--version` or its own status command to find out, and never installs anything for you: a missing tool shows how to install it.
## Plan, check a prompt, or understand code

`/plan <goal>`, `/prompt <file or text>` and `/explain <path or question>` open one add-on popup. It shows what runs, engine/model, folder, whether it can edit, worktree policy, brain status and estimated token/price ranges. Claude Code on your subscription is the default. `e` cycles engines or keys, `m` cycles that choice's models. Key runs always use AI Term's agent, with its normal budgets and Ask prompts. An unpriced key model cannot start; set its price first.

The estimate assumes one to eight inspection rounds with up to 64K context per round. It is a range, not a spending cap. Subscription jobs show $0 API charge and still use subscription limits. No engine runs until you press `y`; Enter alone does nothing. Results show the engine's reported actual tokens and cost; unavailable numbers and unknown prices are stated. All add-ons use Ask mode. These three pilots only read, so they do not create worktrees.

For a recommended or required brain, the popup shows none, stale or fresh. When missing/stale, `b` builds the free local `/brain` first and refreshes the estimate. The index saves repeated folder, entry-point and import exploration. A required brain must be fresh before starting. Model summaries still require `/brain trust` and their separate approval.

`/plan` returns steps grounded in inspected files, with verification and stop conditions. `a` approves and saves the plan privately under `~/.ai-term/plans/<repo id>/`. Approval starts nothing. ↑↓ selects a step; PgUp/PgDn scrolls its details. `s` starts only that step as a normal Ask agent in its own worktree. If isolation cannot be made, nothing starts.

`/prompt` audits the supplied builder prompt as data. It checks contradictions, a missing stop/checkpoint, a cut-off ending, secrets and conflicts with the actual AGENTS.md. Relative or absolute file paths must name a small regular file inside the selected folder; credential and `.env` files are refused. Detected secrets are removed before submission. The result lists issues and an improved unified diff; `c` copies it. The agent cannot write or run commands.

`/explain` begins with one sentence explaining why and a tiny ASCII diagram. Each chunk has one idea in at most six short lines, an example from inspected code, a “you are here” line and a quick check question. Space shows the next chunk; it finishes with exactly three recap lines.

Esc closes the popup and keeps the agent running. Attach from its card for any normal CLI startup or permission question. Type the same command with no arguments to reopen its last popup in this folder while the homepage runs. A daemon restart keeps saved plan files; pending approval/results are in memory, so start a fresh command after a restart.

Definitions live in AI Term's `addons/<name>/addon.md`, and each model add-on's guide in `addons/guides/<name>.md` (written for AI Term, MIT). Runtime copies are immutable private bundles under `~/.ai-term/addons/`; AI Term never installs them into Claude/Codex folders or writes them into the target repository. Claude's installed flags are checked before loading the plugin folder; Codex gets explicit file paths, and AI Term's agent loads the files itself. Read-only pilots disable write/shell/MCP/subagent tools in the native agent; Claude gets only Read/Grep/Glob, and Codex uses its read-only sandbox.

## Learn, fix, test and review with add-ons

These use the same popup as `/plan`: it shows what runs, where, whether it can edit, and the token and price range, and nothing starts until you press `y`. Add-ons that edit work in a new worktree in Ask mode, so every command still asks first. A command with no argument reopens its last popup for the same subject.

- `/teach [agent]` teaches the diff an agent just made, from its worktree: the why, a tiny diagram, then one idea per chunk with a real changed line. Space shows the next chunk. At the end it offers a short quiz of scenario questions; `y` starts it, `n` skips it, and it never starts by itself. With no name it teaches the selected agent.
- `/fix <error text or file>` finds the root cause, writes a test that fails because of the bug, then fixes it. If it can't make a test fail, it stops and says what it tried instead of guessing.
- `/cover [path]` writes tests for behavior nothing checks yet. Each test names the behavior and the change that would break it; tests that only copy the code don't count.
- `/refactor [path]` lists tech debt first. Space picks items and `r` refactors only those, keeping the tests green and undoing any item that breaks them.
- `/perf [path or command]` measures before it changes anything. After the agent's change, `a` runs AI Term's own A/B: the same benchmark on the old and new code, five runs each, back to back on this Mac, and shows both medians. Press `x` to stop an A/B that runs too long.
- `/types [path]` reviews how the types guard against impossible states; `f` fixes the selected finding in a worktree.
- `/failures [path]` hunts for errors that disappear without a trace. It reads a lot, so the popup shows its worst-case price first.
- `/security [path]` is a security review plus a bug-bounty-style hunt. Every finding has a reproduction against this repository only; one that reaches another host is dropped and the popup says so.
- `/review <agent> deep` runs a code reviewer, then a security reviewer, on an agent's diff on any engine, including your subscriptions. Plain `/review` is still the one-model review with a key.
- `/bisect [--no-deps] <test command> [good ref]` uses no model and no tokens. The good ref is a commit hash, a tag or a revision like `main~3`; a bare branch name counts as part of the command, so write `main~0` for a branch. It checks that the test passes at the good ref (default: 32 commits back) and fails now, then runs `git bisect run` in a temporary copy of the repository under the test sandbox. It shows the first bad commit and its diff, then resets and removes the copy. Your checkout is only read. Your installed dependency folders (`node_modules`, `.venv`, `venv`, `vendor`, when present and not committed) are cloned into the copy, copy-on-write: it takes seconds whatever their size, a test runner that writes a cache inside `node_modules` (Vitest does) writes into the clone, and your own folder never changes. Where the disk can't clone (another volume, or a Linux file system without reflinks), the folder is linked instead, readable but not writable inside the sandbox. A commit that needs other dependency versions than yours, or that tracks one of those folders, can misreport. Without a sandbox nothing is cloned or linked. Start the command with `--no-deps` to leave them out. `/perf`'s before side still has only committed files. Without a sandbox it asks for a capital `Y`. While a bisect runs, press `x` to stop it: its test processes end and the copy is removed. Esc only closes the popup; the bisect goes on, and `/bisect` alone opens it again. If AI Term's daemon dies in the middle, its next start removes the copy it left.

When `/fix`, `/cover` and a picked `/refactor` finish, AI Term runs the project's `/test-cmd` in the test sandbox, even with auto-test off, and the popup shows the result. Without a test command they say so instead.

## Repository and GitHub add-ons

Same popup and rules: nothing starts before `y`, agents work in Ask mode, and anything that changes files does it in a new worktree. AI Term never commits or pushes in your checkout and never runs a `gh` command that writes; publishing stays with `/pr` or you.

- `/issue <#number or issue URL>` reads the issue through your own gh login with `gh issue view`, and the agent gets it as quoted data written by other people (secrets removed). It works the issue in a worktree, and AI Term runs the tests in the sandbox. When you're happy, `/pr <agent>` publishes. Without gh, or logged out, one line says so.
- `/pr-review <#number or PR URL>` reviews a pull request read through `gh pr view` and `gh pr diff`. `c` copies the review; nothing is posted.
- `/triage [issues | errors | <file>]` sorts a pile into groups with a priority: your open GitHub issues (read with `gh issue list` and your own login), the newest `.log` here or in `logs/`, or a log or test output file you name. ↑↓ picks a group, `c` copies the list, and `s` opens `/issue` or `/fix` for the group, which asks first like always. Nothing is posted or changed.
- `/migrate <from> <to>` plans a move to another library, framework or version without changing anything. Read the plan; `a` starts all of it in a worktree, step by step, with the tests run after every step. If a step can't get green, the agent undoes it and stops to tell you.
- `/deps [path]` shows outdated and vulnerable packages from read-only queries AI Term runs itself (npm, go and cargo, when the project uses them and they're installed; for Python the agent compares the pins itself). The agent upgrades one package at a time in a worktree.
- `/commit [agent]` writes a commit message. For your checkout it reads only what is staged and `c` copies the message. For an agent, `y` commits its work in its worktree with your git name.
- `/changelog [from..to]` turns git history into a changelog section; `c` copies it, `w` writes it into CHANGELOG.md in a worktree.
- `/docs`, `/handover` and `/adr <decision>` write documentation, a PROGRESS.md-style handover and a decision record in a worktree, following what the repository already has.
- `/standup` lists what every agent did today from AI Term's own records: no model, no tokens, nothing to approve. `m` polishes it with a model after its own estimate.
- `/context` measures what an agent loads here (AGENTS.md, CLAUDE.md, their imports, the loaded skills) and finds contradicting or stale rules.
- `/opensource` checks whether the repository is ready to be public: secrets anywhere in its history (masked), license, README, personal paths and emails. `f` fixes what a file change can fix. Rotating a leaked secret and rewriting history stay with you.

## Making things with add-ons

Same popup and rules. These make files in a new worktree, so nothing lands in your checkout until you merge. When a result has files to look at, ↑↓ picks one, `o` opens it with your default app (a browser for HTML), and `s` saves a copy to Downloads. Neither happens until you press the key, nor while the agent is still running. A model wrote these files, so HTML opens and saves with a policy that lets no script or network request run, and an SVG opens as an image inside such a page; styles and pictures still show.

- `/deck <topic>` builds an investor or pitch deck (problem, solution, market, traction, team, ask) from what the repository and its docs say. A fact that isn't there becomes a TODO line, listed in the popup; numbers are never invented.
- `/slides <topic>` builds any other presentation: a talk, a lesson or a walkthrough.
- `/diagram <what to draw>` draws Mermaid or D2 from the real code under docs/diagrams/, and renders an SVG only if a renderer is already installed.
- `/design <screen>` makes one to three HTML mockups under out/design/ in the product's own look.
- `/polish <path>` refines an existing UI's details without redesigning it.
- `/a11y <path>` reviews accessibility read-only; `f` fixes the selected finding in a worktree.
- `/e2e <app or flow>` writes browser tests, and AI Term runs them in the test sandbox. Your project's 127.0.0.1 setting decides whether a local server may listen.
- `/animate <motion>` first decides whether it should animate at all, and says so; it only builds the animation when the answer is yes.
- `/video <topic>` writes a terminal demo (VHS) or a Remotion composition under out/video/, and renders it only when the tools are already installed.
- `/research <question>` researches the web with the engine's own web tools and saves a cited report under docs/research/. It needs Claude Code or Codex; AI Term's own agent has no web tools.
- `/reverse <target>` explains how an app, binary or folder that is yours works, with the evidence for each finding (a symbol, address, string or call path) and what it couldn't see. It uses [REA](https://github.com/morluto/rea), which you install yourself (`npm install --global rea-agents`); AI Term only finds `rea` on PATH, or at the path you set with `/reverse path <path>` (`/reverse path none` looks on PATH again). Pressing `y` confirms the target is yours or that you're allowed to analyze it. The agent runs read-only in Ask mode on Claude Code or AI Term's agent (not Codex, whose per-session MCP setting adds to your own servers instead of replacing them), and only it gets REA's MCP server. REA runs in the agent sandbox with no network (127.0.0.1 and name lookups included), no unix sockets, no `open` or `osascript`, no key folders or secret-named files, and it writes only in its own `~/.rea` and a private temp folder. Each REA tool call asks first. Hopper-based native analysis may not start in that sandbox, since it can't open apps; Ghidra headless runs as its own process. macOS only for now. The agent stays open, so you can attach and ask follow-up questions.
- `/study <topic>` is a short study session: one idea per chunk, a check question each, Space for the next. Finished topics go on a small review schedule, and `/study` alone shows what is due today. Closed a session too early? In that due list, `r` reopens your last one in this folder, with its result, at no cost.

One section per area: [Add-ons](#learn-fix-test-and-review-with-add-ons) · [Repository add-ons](#repository-and-github-add-ons) · [Making things](#making-things-with-add-ons) · [Agents](#agents) · [Sessions](#sessions) · [Worktrees](#worktrees) · [Review and merge](#review-and-merge) · [Budgets](#budgets) · [Accounts](#accounts) · [Queue](#queue) · [Dev servers](#dev-servers) · [Diagnostics](#diagnostics) · [Brain](#brain)

## Agents

Type a task in the command bar and press Enter. The start box opens. Check the engine, model, folder and mode, then press Enter again to start.

Use `/model` to pick a model. Use `/cd` to pick the folder. Use `/effort` for reasoning depth. Inside the start box, the same choices are on `m`, `c` and `e`.

There are three engines:

- **Claude Code** runs on a Claude account.
- **Codex** runs on a ChatGPT account.
- **AI Term's agent** runs on an API key. Add keys with `/login`.

An account agent uses your normal login. The card reads `own login · sub`. A key agent reads `key ····` followed by the last four characters.

Pick a mode before you start. It applies to this agent only.

- **Ask** is the default. The agent asks before it writes, edits or runs a command.
- **Auto** is Claude's own automatic mode. You can choose it with `/mode` for Claude agents.
- **Don't ask** lets the agent work without asking. Its card shows a red `!`. Codex always stays sandboxed. AI Term's agent offers Don't ask only where it can run in a sandbox.

Ask is the only mode you can save as a default. Don't ask is never saved for you.

## Sessions

Select an agent with ↑ and ↓. Press Enter on an empty field to open it full screen. You can also run `ai --attach <id>` to open one directly.

To leave an agent, press Ctrl+E. You return home, and the agent keeps running.

To see two or more agents, press Space on each one. Up to four can be marked. Press `v` to open them side by side. Ctrl+\ moves focus between panes. Ctrl+E returns home. Press `v` again with nothing marked to reopen the last split.

To send text to a running agent without opening it, use `/send <agent> <text>`. AI Term refuses while the agent waits for permission or a question.

To search every agent's screen, use `/find <text>`. Press ↑ and ↓ to choose a match, then Enter to jump to it.

To copy, press `c` on an empty field. You get the agent's last reply. `/copy all` copies the whole scrollback, up to 5 MiB.

To save a session as a file, use `/export [agent] [folder]`. It writes one HTML file to `~/Downloads`. Keys and passwords are replaced with `[redacted]`.

## Worktrees

When a new agent starts in a git repository, it gets its own branch and its own folder. The branch is named `ai/<name>`. The folder is outside your checkout, under `~/.ai-term/worktrees`. Your checkout is never touched.

The new folder contains only the committed files. Uncommitted changes and ignored files, such as `node_modules` and `.env`, are not copied. Install dependencies inside the new folder.

To turn worktrees off for new agents, open `/settings` and press `w`.

When you remove an agent with `x`, you get one question: keep or delete the worktree. Keep is the default. Press `k`, Esc or Enter to keep it. Press `d` to delete it.

If deleting would lose work, the question lists it. You must type the branch name and press Enter to delete. A single keypress never deletes work.

`/worktrees` lists every worktree AI Term made, including those whose agent is gone. `/clean` removes finished agent records only. It never deletes a worktree.

## Review and merge

Review an agent's work before you merge it.

- `/diff [agent]`, or `d` on a card, shows what the agent changed. It is read-only. Press `m` in the popup to merge, or `x` to discard.
- `/review [agent]` sends the diff to one model you pick. It spends tokens, so it asks first and shows the price range.
- `/test [agent]` runs your project's tests in the worktree. It shows the exact command first. Set the command once with `/test-cmd <command>`.
- `/merge [agent]` merges the agent's branch into your checkout. Your checkout must be clean and on the base branch. A popup shows the exact git commands. Press `y` to run them, or `n` to keep everything. A conflict is aborted at once.
- `/pr [agent]` pushes the branch and opens a pull request with your own `gh`. It asks first.
- `/undo [agent]` and `/redo [agent]` move the worktree back and forth between checkpoints. A checkpoint is taken after every turn. Undo shows each file it changes and asks first.

Merge and pull request steps run a secret scan first. A hit blocks the step until you type `override` and press Enter.

## Budgets

Press `b` on an empty field, or type `/budget`. Set a daily, weekly and monthly limit in dollars. An empty field means no limit. AI Term's agents stop before a request that would cross a limit. Claude Code and Codex only show you a warning.

Each agent also has a cap for one run. The default is 100 turns and $5.00. Change it with `/settings` and `c`, or with `/caps` inside an agent. When a cap is reached, the run pauses and asks. Press Enter to allow more.

Press `u` or type `/usage` to see spend and tokens. Totals are split by period, then by provider. `BY AGENT` shows each agent's own total. Estimates are marked with `≈`. Subscriptions are not counted in the totals.

Prices come from a built-in list. A price marked `price ?` is unknown. Set your own with `/settings` and `p`, entering the price per million input and output tokens. A budgeted run waits for a price instead of guessing.

## Accounts

Type `/account` to list your accounts for each engine. `own` is your normal login.

To add another account, type `/account add claude <name>` or `/account add codex <name>`. AI Term creates a private config folder and opens the CLI's own login there. AI Term never sees the token.

Use `/account default <name>` to set the default for an engine. Use `/account use <name>` to choose one for the next agent. Use `/account rm <name>` to forget a name. The folder and its login stay until you log out there.

AI Term never switches accounts by itself. At a usage limit, the card shows the reset time. You choose what to do next.

Cursor, Gemini CLI and Copilot CLI run like Claude Code and Codex, on your own login. Pick one in `/model`. To sign in, choose its `· CLI login` row in `/login`. A key you pick for one of them runs on AI Term's agent instead. Their cards say `status from output`: they report nothing to AI Term, so `/send` can't reach them. Open them with ⏎ and type there. Gemini CLI has Don't ask in its own sandbox (on Linux it needs Docker or Podman). Cursor and Copilot CLI are Ask only, but tools their own settings allow run without asking. Gemini CLI and Copilot CLI take extra accounts (`/account add gemini <name>`); log in once in each. Cursor needs a first message of at least two words, because one word could run one of its commands. Gemini CLI reads a key from a project `.env`, so keep `GEMINI_API_KEY` out of one you run it in.

Use `/login` to connect an engine or add an API key. Every key's models are tested at once. Only models that pass are offered.

The `/login` list holds many providers. Where one runs a separate service for China, it has two rows: international and China. The line under the list says where the highlighted provider's requests go. Ollama, LM Studio and any OpenAI-compatible server on this machine need no key. AI Term reaches them only at `http://127.0.0.1:<port>`.

You can also add a custom OpenAI-compatible endpoint. It must be https on the public internet. AI Term refuses an address on this machine, your network or a tailnet. Type `add` in the form's last field to confirm. Every agent card that uses the key shows its host.

API keys are stored in the macOS Keychain. On Linux they go in the Secret Service, and on Windows in Credential Manager. They are never written to a file. The `/settings` screen shows only the last four characters.

Open `/settings` to manage keys and defaults. Press `a` to add a key, `x` to remove one and `t` to test one. Press `r` to choose whether keys run on AI Term's agent or on the CLI.

## Phone remote

`/remote` lets your phone reach your agents over your own Tailscale tailnet, and only while you have it on. There is no cloud server of AI Term's and nothing is reachable from the internet. It is off by default: open `/settings` and press `R` once. You need the Tailscale app on the Mac and the phone, logged in to the same tailnet.

- `/remote on` starts the phone page and shows a QR code. Scan it with the phone's camera within 2 minutes and give the phone a name. The code works once; `/remote on` again shows a new one.
- On the phone you see your agents with their status, ctx % and usage. Tap one to read its screen, approve or deny the permission prompt it shows, send it a message (the same rules as `/send`), or stop it. You can also start a new agent in Ask mode, with Claude Code or Codex, in a folder one of your agents already uses. The phone never sees keys, env, logins or settings, and it can't turn on Don't ask.
- An approval counts only if the agent's screen is still the one the phone showed you; if it changed, look again. Only a plain yes/no prompt can be answered (Claude Code's plan approval or folder trust can't, since their first option means more than yes), and never while you're inside that agent on the Mac. The phone shows the bottom of the screen first, where the prompt is.
- An agent you started in Don't ask shows `! Don't ask` on the phone. You can watch and stop it there, but send it messages only on your Mac.
- `/remote` alone shows whether it's on and which phones are paired. `/remote revoke <name>` unpairs a phone; its cookie stops working at once.
- `/remote off` turns it off. It also turns off by itself after 30 minutes without anything done on a paired phone (an open page refreshing itself doesn't count), and whenever AI Term's background service restarts. While it's on and the Mac is on AC power, AI Term keeps the Mac awake; on battery it may sleep.
- Every action is written to `~/.ai-term/remote.log`: which phone, what it did, which agent, and when. Messages are logged by length only.


## Queue

The queue starts agents for you, so it is off until you turn it on. Open `/settings` and press `b`.

Type `/queue add` to open the start box as **Queue a new agent**. Choose when the agent starts:

- `after <agent>`, when that running agent finishes.
- `at HH:MM`, at the next time that is local time.

Then set a limit. Without one, the agent never starts.

- AI Term's agent needs a turn cap and a dollar budget, such as `20 turns $3`.
- A key-based CLI needs a dollar budget, such as `$2`.
- A subscription CLI needs a stop time, such as `until 23:00`.

Type `/queue` to see each item and its state: waiting, started, couldn't start, or missed. Press ↑ and ↓ to choose, `x` to remove, and Esc to close. The queue survives a restart. If AI Term couldn't read some items when it started, `/queue` says how many and names the file it kept them in.

A queued agent starts the same way a manual one does. It uses the same checks, worktree and mode you picked. A time that passed while AI Term wasn't running is marked missed. It never starts late on its own. An agent that ends with an error does not start the agents queued after it.

## Dev servers

Dev servers are off until you turn them on. Open `/settings` and press `y`.

Set your project's dev command once with `/dev-cmd npm run dev`. Use `/dev-cmd none` to clear it. Start a server with `/dev [agent]`. A popup shows the exact command, the folder and the address, such as `http://127.0.0.1:4101`. Press `y` to start exactly that command. Nothing starts by itself.

Each worktree gets its own port between 4100 and 4199. On macOS the server runs in the test sandbox. It can listen only on its own port and cannot reach the internet. On Linux and Windows there is no sandbox. The popup says so, and you must type a capital `Y` each time.

The card shows `▶ dev :4101` while the server runs, whatever the agent is doing. If the server exits by itself, the card shows `✗ dev exited <code>`. Open `/dev` on a running server to see its last lines. Press `x` in that popup to stop it. Removing the agent also stops it, and so does `ai daemon stop`. If the background service crashes, the server keeps running, as an agent's own background processes would.

Dev servers run code that an agent wrote, so read the popup before you press `y`. A changed command, port, or setup file, such as `package.json`, makes `/dev` refuse until you look again.

## Diagnostics

Diagnostics show errors to the agent while it works. Turn them on in `/settings` with `z`. They are off by default, because each message adds tokens.

When on, the agent gets the errors for each file right after it writes or edits it. The errors come from a language server already on your PATH: TypeScript, Python (pyright), Go (gopls) or Rust (rust-analyzer). The output is at most 40 lines.

Each server runs in the agent's bash sandbox, with no API keys. Where no sandbox is available, no server starts, and the agent is told once why. The server gets the same limits as the agent's own commands.

Use diagnostics on work where a type error would waste a turn, such as a large TypeScript or Rust change. Leave it off for small edits or throwaway agents.

The setting applies to agents you start after you change it. Each agent gets at most one server for each language. A server stops when its agent exits, or after 10 minutes with no use. A server that crashes, or misses three answers in a row, is turned off for that language until the agent restarts, and the agent is told once. You can leave diagnostics off and still use everything else in AI Term.

The `/settings` row says which servers it found. If a language has none, the agent is told once, with the command that installs it:

- TypeScript/JavaScript: `npm i -g typescript-language-server typescript`
- Python: `npm i -g pyright`
- Go: `go install golang.org/x/tools/gopls@latest`
- Rust: `rustup component add rust-analyzer`

Only a server outside the agent's worktree is used, never one in `node_modules/.bin`: the agent can write those.

## Brain

`/brain` makes a map of the repository your homepage folder is in, so agents start knowing its shape. It runs only when you type it.

The first pass is free and uses no model. It lists the files and, for TypeScript, JavaScript and Python, what each file imports and exports and which files import it. Other languages are listed as files. Files git ignores are never read. Binaries, files over 256 KB, `.env` files and anything the secret scan flags are skipped, and the popup counts them.

After `/brain trust`, the popup can also add a short summary of each module and the main design decisions, written by a model on one of your API keys. It shows the estimated tokens and the price range for each model first, and runs only on your ⏎. That pass counts against your budgets and the per-run cap, and secrets are removed before anything is sent.

The map is saved as `brain.md`, at most 2,000 lines, with a `brain.json` that remembers each file's fingerprint. Both live under `~/.ai-term/brain/`, never in your repository. Run `/brain` again later and only the files that changed are read again, and priced.

Brain starts off. The start box's **brain** line shows on/off; `b` changes this agent's choice and remembers it for this repository. An older setting you explicitly turned on stays on. Agents receive `brain-index.md`, at most 150 lines of top folders, entry points and import ranks, plus the full-map path. Claude Code loads it as a prompt file, Codex names it in the first message, and AI Term's agent reads it at start. The card shows `brain · 2h old`.

Repositories start untrusted: indexes contain names and structure only. `/brain trust` allows a model pass and model notes in the index. `/brain untrust` removes those notes from the index again. The header marks all repository content as data about the code, never instructions.

`/brain show` opens the map, and `/brain rm` deletes it.
