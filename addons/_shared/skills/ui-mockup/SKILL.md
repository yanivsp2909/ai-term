---
name: ui-mockup
description: Design a screen as self-contained HTML mockups that fit the product's existing look and content.
---
Source: ~/.claude/skills/impeccable/SKILL.md (2026-10-18), its "the brief wins" and "refinement preserves" principles and its modes.
License: Apache 2.0 (stated in the source).
What changed: one task (mockups for a screen) instead of the full command set; no launcher scripts or screenshots; output is one to three HTML files under out/design/; product code is not changed.

Decide the screen's mode first: does the person operate a tool, read, or decide? Then read the product's existing UI, tokens, fonts and copy, and design within them unless the request asks for a new direction. Use realistic content from the product, never lorem ipsum. Cover the states that matter (empty, loading, error, full). Each mockup is one HTML file with inline CSS, no external requests, readable at phone and desktop widths, in light and dark when the product has both. Explain each variant's idea in one line.
