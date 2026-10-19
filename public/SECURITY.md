# Security policy

AI Term is experimental. There are no supported release branches or guaranteed
response times; security fixes are developed against `main`.

## Report a vulnerability privately

Use GitHub's **Report a vulnerability** form:
https://github.com/yanivsp2909/ai-term-public/security/advisories/new

Private vulnerability reporting is enabled on the public snapshot repository.
The private working repository stays private; public releases are curated snapshots.

Include the affected commit, a minimal reproduction using synthetic data, the
expected and observed behavior, and the impact. Do not attach real API keys,
CLI logins, keychain contents, `~/.ai-term` folders, session transcripts or
private repositories. Avoid public issues and pull requests for undisclosed
vulnerabilities.

If a credential has been exposed, revoke or rotate it immediately. Removing it
from the current tree does not remove it from repository history.

## Scope

In scope: the `ai` daemon and its socket, the homepage and its overlays, AI Term's
own agent (its tools, bash sandbox and provider requests), how keys are stored and
sent, worktree creation and deletion, the local HTTP endpoints, the phone remote,
and the desktop app's renderer and preload boundary.

Out of scope: vulnerabilities in Claude Code, Codex, Cursor, Gemini CLI, Copilot CLI
or a model provider's service itself (report those to their vendors), and attacks
that need code already running as your user (see the same-user notes in
`docs/architecture.md`).
