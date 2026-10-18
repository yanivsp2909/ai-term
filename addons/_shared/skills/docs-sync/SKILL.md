---
name: docs-sync
description: Bring README and docs in line with the code, from the code's sources of truth.
---
Source: ~/.claude/commands/update-docs.md (2026-10-18).
License: not stated in the source definition; no redistribution grant inferred.
What changed: kept "generate from sources of truth" (scripts, config examples, routes, exports) and the staleness check; dropped the mandatory CONTRIBUTING and RUNBOOK generation; edits existing docs in their own voice instead of creating new ones.

Find the sources of truth: package scripts or Makefile targets, config and env examples (names only, never values), CLI flags, routes, public exports. Compare each with what README and docs say. Fix what is wrong or missing, remove what no longer exists, and keep each document's structure and tone. Never document behavior you didn't find in the code, and never copy a secret or a real value from an env file. List the files you changed and what was stale.
