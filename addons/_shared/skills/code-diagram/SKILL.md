---
name: code-diagram
description: Draw an architecture, flow or sequence diagram as Mermaid or D2 from code you actually read.
---
Source: ~/.claude/plugins/marketplaces/knowledge-work-plugins/engineering/skills/architecture/SKILL.md (2026-10-18), its system-design view. The inventory has no diagram definition; this is the closest well-rated source.
License: not stated in the source definition; no redistribution grant inferred.
What changed: from writing design records to drawing what exists; every box and arrow must map to code you read; Mermaid or D2 source, rendered only by a renderer that is already installed.

Read the entry points and follow the real calls, messages or data. Name boxes after modules, processes or files as they are in the code, and label arrows with what passes (a call, an event, a file). Keep it to one idea per diagram, under about 20 nodes; split a bigger system into several. Mermaid for flowcharts and sequences, D2 when layout matters. Never draw a component you didn't find. If mmdc or d2 is on PATH, render an SVG beside the source; otherwise say rendering was skipped.
