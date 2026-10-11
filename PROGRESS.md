# PROGRESS

## Checkpoint
Last implementation commit: 561d148 docs: record Codex setup and CLI facts spike
Roadmap step: v0.1.1 done (live key/manual checks listed below remain needs Yaniv)
Private remote: https://github.com/yanivsp2909/ai-term (main pushed)

## What works
- Node 26.3.0, strict TypeScript scaffold, CLI version/no-args/unknown-command behavior.
- Model-id validator exactly architecture §7.2; 13 tests pass.
- Setup metadata inventory and CLI facts reports in docs/spikes/.
- PTY → headless mirror → serializer works after correcting the native spawn-helper executable bit in the throwaway install. Dummy keychain set/get/delete passed; entry and folder removed.
- Typecheck, lint, tests and build all pass. No daemon or TUI code exists.

## What's next
- v0.1.2: Ctrl+E docs and renderer comparison, explicitly authorized in the same user request.
- Planning chat should review nine corrections at the end of docs/spikes/v0.1-cli-facts.md. §7/§9 remain unchanged.

## Manual checks
- Claude key first/repeated approval and separate config-dir behavior: needs Yaniv (CLI facts commands 1–2).
- Foundry GPT/non-GPT requests: needs Yaniv (commands 3–4).
- Telemetry live schemas and local receiver compatibility: needs Yaniv (commands 5–6 and later integration).
- CLI login status, native PTY/mirror and dummy keychain cleanup: ran.

## Gotchas
- Current Codex rejects wire_api=chat. Non-GPT Foundry routing is not proven.
- Codex login status reports API-key auth, not ChatGPT account auth; all key hints redacted.
- Precise Claude environment-key approval persistence is not established by the retrieved docs.
- Exact security grep matches supplied docs, dummy canary, placeholders and permission wording (11 lines); no real secret. Never claim empty output.
- npm audit: one low Windows esbuild dev-server advisory under tsup; audit fix did not resolve its constrained dependency. No affected server runs.
- Installed metadata definitions do not prove live callable roles. RTK.md was absent in repo and parent; no /init was run.

## New dependencies
- typescript: strict static checking; Node cannot typecheck TypeScript itself.
- @types/node: Node API types for the checker.
- tsx: source development execution with consistent TS module support.
- tsup: bundle the CLI and package version into dist/cli/index.js.
- eslint, @eslint/js, typescript-eslint: flat lint config and unsafe process API restrictions.
- vitest: unit test pure validators.

## Concepts introduced
- Scaffold: package.json defines commands; tsconfig.json defines the strict compiler contract. Only src/cli/index.ts is a build entry, so spikes are separate.
- Argument validation: src/shared/validate.ts accepts a bounded ASCII model id before later process spawning. tests/validate.test.ts covers injection-like input and valid ids.
- Screen mirror: a headless terminal parses PTY escape bytes into cells; serialization reconstructs visible state. This step tested the libraries outside the repo rather than adding daemon code.
- CLI fact status: docs/spikes/v0.1-cli-facts.md separates observed behavior, official documentation, and billing/manual tests that only Yaniv can run.
