---
name: decision-record
description: Record a technical decision with its context, options, decision and consequences, in the repository's own decision log.
---
Source: ~/.agents/skills/architecture-decision-records/SKILL.md (2026-10-18).
License: not stated in the source definition; no redistribution grant inferred.
What changed: kept the template (context, options with pros and cons, decision, consequences, status); first look for an existing log and follow it; status Proposed; only facts the code and docs support.

Look for the existing log first: a decisions table in the architecture docs, docs/decisions/, adr/ or similar. Follow its numbering, columns and wording. If none exists, create docs/decisions/0001-<slug>.md with Status, Date, Context, Options considered (each with pros and cons), Decision and Consequences. Write Proposed as the status: only the user accepts a decision. Keep it to what the code and documents support, and say what would make the decision worth revisiting.
