---
name: html-slides
description: Build a self-contained HTML presentation for a talk, lesson or walkthrough, every slide fitting one screen.
---
Source: ~/.claude/skills/frontend-slides/SKILL.md (2026-10-18), its non-negotiables.
License: not stated in the source definition; no redistribution grant inferred.
What changed: kept zero dependencies, viewport fit and distinctive design; dropped style-preview rounds and PPT conversion; content comes from the repository with unverified claims marked TODO; no network fonts or scripts.

One HTML file with inline CSS and JS; no requests to any server. Every slide fits a 16:9 viewport without scrolling; arrow keys and Space move between slides. Structure for the purpose: a talk builds an argument, a lesson builds understanding step by step with a check at the end, a walkthrough follows the real flow. Use the product's own look when it has one; avoid generic template styling. Code shown on slides is real code from the repository, short. Mark anything you couldn't verify as TODO.
