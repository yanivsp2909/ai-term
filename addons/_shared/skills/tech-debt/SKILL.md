---
name: tech-debt
description: Identify and prioritize concrete tech-debt items in code, each refactorable on its own with tests kept green.
---
Source: ~/.claude/plugins/marketplaces/knowledge-work-plugins/engineering/skills/tech-debt/SKILL.md (2026-10-16), with the safe-removal checks of ~/.claude/agents/refactor-cleaner.md.
License: not stated in either source definition; no redistribution grant inferred.
What changed: narrowed to code, test and dependency debt found in the inspected files; each item is small enough to refactor alone; dropped architecture roadmaps, business justification and phased plans; added behavior-preserving rules for the later refactor.

List items you can point at: duplicated logic, poor names, long functions, deep nesting, magic numbers, dead code, leaky abstractions, swallowed errors, flaky or missing tests around the code. Score each: impact and risk 1–5, effort 1–5; priority = (impact + risk) × (6 − effort). Give each item a short title, why it matters, its files and a risk of low, medium or high. Order by priority.
When refactoring a picked item later: tests green first, behavior unchanged, one item at a time, run the tests after each, and undo an item that turns them red. Before removing code, search for every reference, including dynamic ones.
