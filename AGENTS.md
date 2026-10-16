# AGENTS.md

Instructions for any coding agent working in this repo. Codex reads this file; Claude Code reads it through `CLAUDE.md`.

## What this is
AI Term is the `ai` command: a terminal UI plus a background daemon for running AI coding agents.
- **Account logins** run the official Claude Code and Codex CLIs, untouched, in real PTYs.
- **API keys** run AI Term's own agent (v0.4+); compatible keys can explicitly use their official CLI through settings.
- **The homepage** lists every agent, shows a live preview of the selected one, API usage and machine stats. You type what you want built in a command bar at the bottom.

This is Yaniv's personal and learning project. Optimize for correctness, clarity and a calm, fast UI. Don't add scale or features nobody asked for.

**Read these before working:**
- `docs/architecture.md`: processes, protocol, spawning, keys, security checks, decisions
- `docs/design.md` and `docs/design/tokens.json`: the approved UI

Decisions in the decisions log are not reopened unless Yaniv asks.

## Before you write any code
1. Read `PROGRESS.md` and `README.md`. Report the checkpoint (last commit, what works) in one short paragraph.
2. Establish the premise by reading the code and docs. Your prompt describes the repo from outside. Where the code disagrees with the prompt, trust the code and say so in your report.
3. If you were started to *resume*, stop after step 1 and wait.
4. One roadmap step per session. Do exactly the step in your prompt and stop at its stop condition. If you finish early, stop anyway; don't start the next step.
5. Never work while another agent (Codex or Claude) is working in this repo.

## Commands
- README command list: README.md always holds the full, current list of ai commands (homepage / commands, ai subcommands) and keys. Any step that adds, removes or changes a command or key updates that list in the same session.
The command list is maintained in README.md.
- `npm install`
- `npm run dev`: run `ai` from source (tsx)
- `npm run build`: build to `dist/`
- `npm run typecheck`
- `npm run lint`
- `npm test`: vitest

Before you report done, run `npm run typecheck`, `npm run lint`, `npm test` and `npm run build`. Paste the last lines of each output, not "should pass".

## Layout
- `src/cli/`: the `ai` entry point
- `src/daemon/`: the background service. PTYs, screen mirrors, keys, usage, stats, state. Only the daemon touches secrets.
- `src/client/`: socket connection, attach (full-screen passthrough), `tui/` (homepage and overlays)
- `src/shared/`: `protocol.ts` (the client ⇄ daemon contract; change it first, then both sides), `models.ts`, `validate.ts`, `paths.ts`
- `docs/`: architecture, design, tokens, spike reports
- `tests/`: vitest

## Coding rules
- TypeScript `strict`. No `any`; use `unknown` and narrow. No non-null `!` on values that come from the socket, files or processes.
- Small and shippable beats clever. No abstractions, options or plugin points for features that don't exist yet.
- One module = one responsibility, named after it (`session-manager.ts`, not `utils.ts`).
- Errors are never swallowed. Log them through `src/daemon/log.ts` and surface them where the user would care. An empty `catch {}` is a bug.
- New dependency = one line in PROGRESS.md saying why the platform or an existing dependency wasn't enough.
- Comments explain *why* (PTY, terminal and git quirks especially), not what.
- Don't reformat or rename code you weren't asked to touch.

## Process rules
- Spawn processes with `execFile`, `spawn` or node-pty and **argument arrays only**. Never `exec`, `execSync`, `shell: true`, or a command string built from any input.
- Validate everything from the socket or the user before it reaches a process, file or network call. The validators live in `src/shared/validate.ts`.
- Model ids and deployment names go to a CLI as one argv element: `--model=<id>`.
- Git (from v0.3): put `--` before ref and path arguments in every call.

## Security rules (non-negotiable)
- **API keys** live only in the OS keychain, through `src/daemon/keys.ts`. Never in `~/.ai-term`, `.env`, logs, protocol responses, the client, test fixtures or commits.
  - A client may know that a key exists and its last 4 characters, nothing more.
  - Keys are read from the keychain only by the daemon, only right before a spawn or a provider test, and only put into that child's env or that one request.
- **Env hygiene:** account sessions spawn with their provider's credential and routing variables removed (lists in `docs/architecture.md` §7.3), or the CLI may silently bill an API key instead of the subscription. A key session sets only its own key. Env building lives only in `src/daemon/env.ts`, and it's unit-tested.
- **Never read, copy, log or proxy the CLIs' own logins:** credential files under `~/.claude`, `~/.codex/auth.json`, `.credentials.json`, Keychain entries that belong to Claude Code or Codex. Never edit `~/.claude` or `~/.codex`. D48 permits read-only skills, agents and commands in the documented allowlisted folders only; it excludes credentials, settings and history.
- **Never log** `process.env`, a spawn env, a secret, or anything matching `sk-`.
- **Socket:** `~/.ai-term` is 0700, the socket 0600. Refuse to start if the folder is a symlink or owned by another user.
- **Local HTTP endpoints** (usage receiver, status endpoint): `127.0.0.1` only, a token compared in constant time, an exact `Host` check, reject any `Origin`; the status endpoint answers 204 with an empty body; the usage receiver answers 200 {} because OTLP exporters expect it (S12).
- **Never make agents skip their permission prompts by default.** Don't ask is a per-session choice only, and its flags appear only in `src/daemon/env.ts`. Codex stays sandboxed even in Don't ask.
- **Never delete** a worktree or branch with uncommitted, untracked or unmerged work without Yaniv's explicit confirmation.
- **Background agents' raw output** never reaches the user's terminal. The homepage renders mirror cells only.
- If a step needs a real key or a real login to test, **prepare the command and ask Yaniv to run it.** Never ask him to paste a key into the chat, and never put one in a file.
- Don't touch `.codex/`, `.agents/` or `.claude/` in this repo unless the prompt says to.

## UI rules
- Colors come only from `docs/design/tokens.json` through one theme module. No raw hex in components.
- Follow `docs/design.md` exactly. When it's silent, choose the calmer option and say so in your report.
- Nothing animates. Redraw only on change; the preview at most 30 fps.
- Keyboard first: every action reachable from the keyboard. Keys typed on the homepage never reach an agent.
- Never color alone: every status has its glyph and a word.
- Typing in the command bar and inside sessions must feel instant.

## Testing
- Unit-test pure logic with vitest: validators, protocol framing, `buildSpawnEnv`, `buildArgs`, store, usage math, stats parsing, endpoint request handling.
- Interactive behavior (rendering, attach, the agent CLIs, the keychain) can't be fully verified headlessly. In your report, list each manual check from the prompt and mark it **ran** (with what you saw) or **needs Yaniv**. Never claim a check passed if you didn't see it.
- If a command needs network access or a permission you don't have, ask. Don't work around a sandbox or an approval prompt.

## Git
- Small commits on `main` with conventional messages (`feat:`, `fix:`, `chore:`, `docs:`, `test:`). Never force-push, never rewrite history.
- Never commit secrets, `.env` files, or anything from `~/.ai-term`.
- Push to `origin` at the end of the session when a remote exists.

## Handover (required before you stop)
Update `PROGRESS.md` in this shape, then commit it as the last commit of the session:

    ## Checkpoint
    Last commit: <hash> <message>
    Roadmap step: <id> <done | partial>
    ## What works
    - ...
    ## What's next
    - the next roadmap step id, plus anything left from this one
    ## Manual checks
    - <check>: ran / needs Yaniv
    ## Gotchas
    - things the next session would otherwise trip on
    ## New dependencies
    - <package>: why
    ## Concepts introduced
    - <concept>: 2-3 sentences tied to the file where it lives (Yaniv is learning; explain each new concept once)

Your final message: what you did, commit hashes, check results, anything in the prompt you found to be wrong, and the PROGRESS.md checkpoint.
- `.claude/` holds review agents and skills for cloud sessions. Never review or edit it unless the prompt says so.
