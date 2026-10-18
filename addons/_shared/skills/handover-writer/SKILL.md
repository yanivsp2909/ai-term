---
name: handover-writer
description: Write an honest handover for a repository: checkpoint, what works, what's next, manual checks, gotchas.
---
Source: ~/.claude/commands/save-session.md (2026-10-18), its sections and its "write every section honestly" rule.
License: not stated in the source definition; no redistribution grant inferred.
What changed: writes into the repository (PROGRESS.md) instead of ~/.claude/session-data; sections renamed to AI Term's handover shape; only verified claims; no user confirmation loop.

Gather facts: the last commits, the branch, how to build and test, what the tests cover, open TODOs and known failures. Write: Checkpoint (last commit hash and message, branch), What works (verified only), What's next, Manual checks (each marked ran or needs a person), Gotchas (things the next person would trip on). If a section has nothing, say so. Say "not checked" instead of guessing. Keep it short enough to read in two minutes.
