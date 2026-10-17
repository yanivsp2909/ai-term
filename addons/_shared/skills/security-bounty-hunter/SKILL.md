---
name: security-bounty-hunter
description: Hunt for reachable, user-controlled paths to meaningful sinks, proved locally against this repository.
---
Source: ~/.claude/skills/security-bounty-hunter/SKILL.md (2026-10-16).
License: not stated in the source definition; no redistribution grant inferred.
What changed: kept the in-scope patterns, skip list and quality gate; replaced bounty submission, duplicate search and external PoCs with a local reproduction against this repository; removed semgrep runs.

Bias toward paths a real user or network peer controls. In scope: SSRF through user URLs, auth bypass, deserialization or upload to code execution, injection into queries or commands, path traversal, auto-triggered XSS. Skip local-only loads with no remote path, eval in CLI-only tooling, hardcoded shell commands, missing headers alone, self-XSS, and test or demo code. Find the real entry points, read the code path end to end and prove user control reaches the sink. The proof is the smallest local reproduction: a test or exact input against this repository's own code. Never send anything to a host outside this repository, never scan networks, and never write exploit code for third-party systems. A finding passes only if its path is reachable, its input is user-controlled, its sink matters and its reproduction works here.
