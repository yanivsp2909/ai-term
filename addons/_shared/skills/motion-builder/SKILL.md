---
name: motion-builder
description: Decide whether something should animate at all, then build the animation with the right timing and a reduced-motion path.
---
Source: ~/.claude/skills/animate/SKILL.md (2026-10-18).
License: not stated in the source definition; no redistribution grant inferred.
What changed: kept the build sequence and its first gate (should this animate at all?), the hard rules and the cheapest-tool rule; the verdict is reported explicitly; tables summarized.

Gate first: something seen a hundred times a day (keyboard shortcuts, command palettes) gets no animation; tens of times a day only a near-instant, subtle one; occasional surfaces (dialogs, drawers, toasts) a standard one; rare moments (first use, success) may delight. Keyboard-initiated actions never animate. If it fails the gate, say so and offer the non-motion alternative. If it passes: animate transform and opacity only, enter with ease-out, keep UI motion around 150–250 ms, never scale from 0, extend the project's existing easing and duration tokens, and ship the prefers-reduced-motion path with it.
