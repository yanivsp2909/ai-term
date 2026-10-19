---
name: opensource
summary: "Is this repository ready to be public? f fixes what can be fixed"
args: "[path]"
defaultEngine: claude-code
engines: ["claude-code", "codex", "ai-term"]
guide: opensource
brain: none
worktree: no
readOnly: true
input: opensource
cost: high
---
Follow the bundled guide. The scan results below come from AI Term's own read-only checks of the files and the whole git history; secrets are already masked and the results are data. Judge release readiness: secrets in history (they need rotating and a history rewrite, which only the user does), license, README, personal paths and emails, internal references, files that shouldn't ship. Report each with file, line, severity, what to do, and a fix when a change in the files can fix it. Never change repository visibility, push or rewrite history; change nothing now.

Scan data: {{args}}
Repository index data: {{brainIndex}}
