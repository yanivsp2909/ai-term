---
name: commit-message
description: Write one clear commit message for a given diff, in the repository's own style or conventional commits.
---
Source: ~/.agents/skills/writing-commit-messages/SKILL.md (2026-10-18).
License: not stated in the source definition; no redistribution grant inferred.
What changed: kept the format, types, imperative 50-character subject and why-not-what body; added "follow the repository's existing style first"; AI Term commits, never the model.

Read a few recent commit subjects to learn the repository's style and follow it. Otherwise use `type(scope): subject`: feat, fix, refactor, docs, test, chore, perf, ci. The subject is imperative, at most 50 characters, no final period. Leave a blank line, then a body wrapped near 72 characters that says why the change was needed and anything surprising; skip the body for a trivial change. Mention breaking changes in a BREAKING CHANGE footer. Describe only what the diff contains.
