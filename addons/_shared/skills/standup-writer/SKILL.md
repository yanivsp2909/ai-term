---
name: standup-writer
description: Turn AI Term's record of today's agents into a short Done / Doing / Blockers standup.
---
Source: ~/.claude/plugins/marketplaces/knowledge-work-plugins/partner-built/slack/commands/standup.md (2026-10-18), its Done / Doing / Blockers format.
License: not stated in the source definition; no redistribution grant inferred.
What changed: the input is AI Term's own agent record instead of Slack searches; no posting anywhere; nothing that isn't in the record.

Done: agents that finished or committed today, one line each in plain words. Doing: agents still running or waiting. Blockers: agents that ended with an error, failing tests, or that wait on a permission. Add the day's token and cost totals when the record has them. Keep agent names as they are; never add work that isn't in the record.
