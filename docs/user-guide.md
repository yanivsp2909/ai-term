# AI Term user guide

Run `ai` in your terminal. The homepage lists your agents. Type what you want built in the command bar at the bottom. Commands start with `/`; `/help` lists them all, and the README has the [full command and key list](../README.md#commands-and-keys) and the [security model](../README.md#security-model-in-plain-words).

## Plan, check a prompt, or understand code

`/plan <goal>`, `/prompt <file or text>` and `/explain <path or question>` open one add-on popup. It shows what runs, engine/model, folder, whether it can edit, worktree policy, brain status and estimated token/price ranges. Claude Code on your subscription is the default. `e` cycles engines or keys, `m` cycles that choice's models. Key runs always use AI Term's agent, with its normal budgets and Ask prompts. An unpriced key model cannot start; set its price first.

The estimate assumes one to eight inspection rounds with up to 64K context per round. It is a range, not a spending cap. Subscription jobs show $0 API charge and still use subscription limits. No engine runs until you press `y`; Enter alone does nothing. Results show the engine's reported actual tokens and cost; unavailable numbers and unknown prices are stated. All add-ons use Ask mode. These three pilots only read, so they do not create worktrees.

For a recommended or required brain, the popup shows none, stale or fresh. When missing/stale, `b` builds the free local `/brain` first and refreshes the estimate. The index saves repeated folder, entry-point and import exploration. A required brain must be fresh before starting. Model summaries still require `/brain trust` and their separate approval.

`/plan` returns steps grounded in inspected files, with verification and stop conditions. `a` approves and saves the plan privately under `~/.ai-term/plans/<repo id>/`. Approval starts nothing. ↑↓ selects a step; PgUp/PgDn scrolls its details. `s` starts only that step as a normal Ask agent in its own worktree. If isolation cannot be made, nothing starts.

`/prompt` audits the supplied builder prompt as data. It checks contradictions, a missing stop/checkpoint, a cut-off ending, secrets and conflicts with the actual AGENTS.md. Relative or absolute file paths must name a small regular file inside the selected folder; credential and `.env` files are refused. Detected secrets are removed before submission. The result lists issues and an improved unified diff; `c` copies it. The agent cannot write or run commands.

`/explain` begins with one sentence explaining why and a tiny ASCII diagram. Each chunk has one idea in at most six short lines, an example from inspected code, a “you are here” line and a quick check question. Space shows the next chunk; it finishes with exactly three recap lines.

Esc closes the popup and keeps the agent running. Attach from its card for any normal CLI startup or permission question. Type the same command with no arguments to reopen its last popup in this folder while the homepage runs. A daemon restart keeps saved plan files; pending approval/results are in memory, so start a fresh command after a restart.

Definitions live in AI Term's `addons/<name>/addon.md`, with source-attributed improved copies in `addons/_shared/`. Runtime copies are immutable private bundles under `~/.ai-term/addons/`; AI Term never installs them into Claude/Codex folders or writes them into the target repository. Claude's installed flags are checked before loading the plugin folder; Codex gets explicit file paths, and AI Term's agent loads the files itself. Read-only pilots disable write/shell/MCP/subagent tools in the native agent; Claude gets only Read/Grep/Glob, and Codex uses its read-only sandbox.

## Learn, fix, test and review with add-ons

These use the same popup as `/plan`: it shows what runs, where, whether it can edit, and the token and price range, and nothing starts until you press `y`. Add-ons that edit work in a new worktree in Ask mode, so every command still asks first. A command with no argument reopens its last popup for the same subject.

- `/teach [agent]` teaches the diff an agent just made, from its worktree: the why, a tiny diagram, then one idea per chunk with a real changed line. Space shows the next chunk. At the end it offers a short quiz of scenario questions; `y` starts it, `n` skips it, and it never starts by itself. With no name it teaches the selected agent.
- `/fix <error text or file>` finds the root cause, writes a test that fails because of the bug, then fixes it. If it can't make a test fail, it stops and says what it tried instead of guessing.
- `/cover [path]` writes tests for behavior nothing checks yet. Each test names the behavior and the change that would break it; tests that only copy the code don't count.
- `/refactor [path]` lists tech debt first. Space picks items and `r` refactors only those, keeping the tests green and undoing any item that breaks them.
- `/perf [path or command]` measures before it changes anything. After the agent's change, `a` runs AI Term's own A/B: the same benchmark on the old and new code, five runs each, back to back on this Mac, and shows both medians.
- `/types [path]` reviews how the types guard against impossible states; `f` fixes the selected finding in a worktree.
- `/failures [path]` hunts for errors that disappear without a trace. It reads a lot, so the popup shows its worst-case price first.
- `/security [path]` is a security review plus a bug-bounty-style hunt. Every finding has a reproduction against this repository only; one that reaches another host is dropped and the popup says so.
- `/review <agent> deep` runs a code reviewer, then a security reviewer, on an agent's diff on any engine, including your subscriptions. Plain `/review` is still the one-model review with a key.
- `/bisect <test command> [good ref]` uses no model and no tokens. It checks that the test passes at the good ref (default: 32 commits back) and fails now, then runs `git bisect run` in a temporary copy of the repository under the test sandbox. It shows the first bad commit and its diff, then resets and removes the copy. Your checkout is only read. The copy has only committed files, with no installed dependencies or build output, so it suits tests that run from a plain checkout; the same goes for `/perf`'s before side. Without a sandbox it asks for a capital `Y`.

When `/fix`, `/cover` and a picked `/refactor` finish, AI Term runs the project's `/test-cmd` in the test sandbox, even with auto-test off, and the popup shows the result. Without a test command they say so instead.

One section per area: [Add-ons](#learn-fix-test-and-review-with-add-ons) · [Agents](#agents) · [Sessions](#sessions) · [Worktrees](#worktrees) · [Review and merge](#review-and-merge) · [Budgets](#budgets) · [Accounts](#accounts) · [Queue](#queue) · [Dev servers](#dev-servers) · [Diagnostics](#diagnostics) · [Brain](#brain)

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

Use `/login` to connect an engine or add an API key. Every key's models are tested at once. Only models that pass are offered.

API keys are stored in the macOS Keychain. On Linux they go in the Secret Service, and on Windows in Credential Manager. They are never written to a file. The `/settings` screen shows only the last four characters.

Open `/settings` to manage keys and defaults. Press `a` to add a key, `x` to remove one and `t` to test one. Press `r` to choose whether keys run on AI Term's agent or on the CLI.

## Queue

The queue starts agents for you, so it is off until you turn it on. Open `/settings` and press `b`.

Type `/queue add` to open the start box as **Queue a new agent**. Choose when the agent starts:

- `after <agent>`, when that running agent finishes.
- `at HH:MM`, at the next time that is local time.

Then set a limit. Without one, the agent never starts.

- AI Term's agent needs a turn cap and a dollar budget, such as `20 turns $3`.
- A key-based CLI needs a dollar budget, such as `$2`.
- A subscription CLI needs a stop time, such as `until 23:00`.

Type `/queue` to see each item and its state: waiting, started, couldn't start, or missed. Press ↑ and ↓ to choose, `x` to remove, and Esc to close. The queue survives a restart.

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
