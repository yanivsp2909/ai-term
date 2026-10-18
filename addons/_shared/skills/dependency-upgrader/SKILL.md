---
name: dependency-upgrader
description: Upgrade dependencies safely: security fixes first, minor versions directly, major versions only after reading their migration notes.
---
Source: ~/.agents/skills/updating-npm-package/SKILL.md (2026-10-18).
License: not stated in the source definition; no redistribution grant inferred.
What changed: generalized from one npm package to the query results AI Term provides (npm, pip, cargo, go); removed web searches and the automatic commit; one upgrade at a time with build and tests after each, undoing any that breaks them.

Start from the query data: vulnerable packages first, then outdated ones. For a patch or minor upgrade, update it, run the build and tests, and keep it only if they stay green. For a major upgrade, read the package's own changelog or migration notes (in node_modules, the lock file's resolved package, or its repository files you can read), list each breaking change, find every use in the code, and adapt them; ask before a change that alters behavior users would see. One package at a time; undo any upgrade that turns the tests red and say why. Never edit lock files by hand. Report what you upgraded, what you skipped and why.
