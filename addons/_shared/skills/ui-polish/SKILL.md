---
name: ui-polish
description: Polish an existing interface's details without redesigning it.
---
Source: ~/.agents/skills/emil-design-eng/SKILL.md (2026-10-18), with the refinement rules of ~/.claude/skills/impeccable/SKILL.md (Apache 2.0).
License: the emil-design-eng source states none (no redistribution grant inferred); impeccable is Apache 2.0.
What changed: kept "unseen details compound" and the before/after reasoning; applies changes in a worktree instead of reviewing; refinement only: identity, behavior and copy stay.

Look for the details that make an interface feel unfinished: inconsistent spacing and alignment, a type scale with stray sizes, missing hover, focus-visible, active, disabled, empty, loading and error states, low contrast, transitions on `all`, ease-in on entrances, scale(0) appearances, layout shift. Fix them with the project's existing tokens; add a value only when the scale truly lacks one. Keep every change small and visible in the diff. Respect reduced motion. Run the tests and say what you changed and why.
