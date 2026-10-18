---
name: changelog-writer
description: Turn a list of commits into a user-facing changelog section.
---
Source: ~/.agents/skills/writing-commit-messages/SKILL.md (2026-10-18), its types table and its user-facing rule. The inventory has no changelog definition; this is the closest well-rated source.
License: not stated in the source definition; no redistribution grant inferred.
What changed: turned commit-writing rules into reading rules: map commit types to Added, Changed, Fixed, Removed and Security; drop internal changes; follow an existing CHANGELOG.md.

Group commits by what a user notices: feat → Added, fix → Fixed, perf and behavior changes → Changed, removals → Removed, anything about vulnerabilities or secrets → Security. Rewrite each as one plain line a user understands; merge commits that are one change. Leave out tests, refactors, CI and typo fixes unless they change behavior. Follow the existing CHANGELOG.md heading and date format when there is one; otherwise use "## [Unreleased]" and "### Added" style headings. Never invent a change that isn't in the list.
