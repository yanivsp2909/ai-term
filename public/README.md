# AI Term

AI Term is the `ai` command: one terminal homepage for running AI coding agents side by side. It starts the official
Claude Code, Codex, Cursor, Gemini CLI and Copilot CLI on your own logins, untouched, each in a real terminal. It also
has its own agent for API keys from Anthropic, OpenAI, Azure AI Foundry and about thirty other providers and regions. Each agent
works in its own git worktree, so agents can't step on each other or on your checkout. A background service keeps
them running when you close the terminal. The homepage lists every agent, shows a live preview of the one you select,
and adds up what your API keys spend.

AI Term is not affiliated with, endorsed by or sponsored by Anthropic, OpenAI, Cursor, Google or GitHub. Their names
appear only to say which official tools AI Term can start.

## Status

- **Experimental.** This is a personal and learning project, published as a source snapshot. There are no releases,
  no support promises and no stable API. Things will change.
- **macOS first.** It is built and used daily on macOS. Linux and Windows are lightly tested: the test suite runs on
  Linux, and the Windows paths are covered by unit tests more than by use.
- **Mostly written by AI coding agents** (Codex and Claude Code), from plans, decisions and reviews written by a
  person. Every change went through tests and fresh-context reviews, but read it as you would any young codebase.
- Checks that need real logins, real keys, a phone or the packaged app were run by hand on macOS and are not part of
  this snapshot.

## Security, in short

- **Your logins stay with their CLIs.** AI Term runs Claude Code, Codex, Cursor, Gemini CLI and Copilot CLI as they
  are. It never reads, copies or forwards their logins, and never writes to their config folders. An agent on your
  login runs with that CLI's API-key variables removed, so it can't quietly bill a key instead.
- **API keys are stored only in your OS keychain** (macOS Keychain, Windows Credential Manager, or a Secret Service
  keyring on Linux), never in a settings file, a log or on screen; the homepage only knows a key's last four
  characters. A key is read right before it is used. A CLI gets it in its own environment; AI Term's own agent gets
  it through a one-time file only you can read, which it deletes as it starts. Each key goes only to the address bound
  to it when you added it: its provider's fixed address, or the Azure AI Foundry endpoint, Bedrock region or custom
  endpoint you entered. A custom endpoint must be https on the public internet, and you confirm it by typing `add`.
- **Agents ask before they act by default.** Don't ask is a choice you make per agent. In it, AI Term's own agent runs
  its commands in a sandbox, and Codex and Gemini CLI keep their own; Claude Code in Don't ask has no sandbox and can
  do whatever your account can. Cursor and Copilot CLI are Ask only.
- **Tests and dev servers that AI Term starts** run in a sandbox where the platform has one, and ask first where it
  doesn't.
- **Everything stays on your machine.** The background service listens on a socket only you can open, and its local
  HTTP endpoints accept only 127.0.0.1 with a token. The optional phone remote works only over your own Tailscale
  network and is off by default.
- **Anything that spends tokens asks first** and shows an estimated price, and budgets can stop it.

The details and their caveats are under [Security model, in plain words](#security-model-in-plain-words).

Found a security problem? Please report it privately: see [SECURITY.md](SECURITY.md).

This snapshot leaves some private files out; [PUBLIC_SNAPSHOT.md](PUBLIC_SNAPSHOT.md) lists them and why.

