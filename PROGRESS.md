# PROGRESS

## Checkpoint
Last commit: 2396d9d docs: capture final command pass verification output
Roadmap step: v0.1.8c done
Branch: main. This handover is the last commit; its own hash is in git log.
Started at clean 139f876, v0.1.8b complete. Baseline 427 passed / 2 native Keychain skipped by opt-in / 1 existing TODO, 62 files. Final 455 passed / same 2 skipped / same TODO, 68 files. All requested commands and checks implemented; real CLI continuity/terminal checks remain for Yaniv.

## What works
- One registry in src/client/tui/commands.ts owns slash names/descriptions/current values/argument hints. Menu, help, Tab completion derive from it. aiSubcommands feeds CLI usage/debug-action inventory; README coverage test lists every command/subcommand. Registry 9a2514e, CLI inventory 0213018, extra debug-stats args reject before daemon access 0fb3251.
- Menu shows commands/hints/description with current value right in ink-3, selected-card fill/accent bar. ↑↓ wraps through filtered commands; typing resets first; Enter picks or inserts argument prefix; Esc closes; Tab completes highlighted command then cycles values. Short terminals keep selection visible. Menu 15bbac1, help wrapping c836875.
- /effort accepts installed Claude levels low/medium/high/xhigh/max and Codex rust-v0.160.1 config enum none/minimal/low/medium/high/xhigh/max/ultra/persistent. CLI default null passes nothing. Engine-specific validation, defaults/start row/e picker, /settings effort/e saved default. Contract 208b81d, argv 2cb30df, UI c924599, failed saves/Tab 2b1a891.
- /mode Ask/Auto/Don't ask for Claude, Ask/Don't ask for Codex with auto-unavailable note. Exact existing Ask/Don't ask flags remain, Claude auto uses its documented flag. Flags only in env.ts; no forbidden bypass flags. Modes per session/reset Ask after start/cancel; only Ask saveable. b96ae20, compatible box model choice d19d15e.
- New Claude agents get validated AI Term conversation UUID through --session-id, persisted in record/recipe. sessions.resume takes only selected record ID, reuses saved folder/model/auth/effort/mode/title, sends --resume with conversation UUID; old Claude/shell/live records refuse with note. Codex uses its own cwd-filtered resume picker, original flags, no credential/session file reads. Resume a8c03d6, concurrent reservation a2f17ed, real socket/keyed privacy tests 451d59e/e8bc702.
- /shell uses current /cd and existing debug-shell recipe ($SHELL -l), selected and previewed. Shell failures show a note without exiting homepage. /clean snapshots exited/error IDs, asks remove N finished agents? y/n, sends record removals only; running processes/files/folders untouched, failure notes retained. c924599, b96ae20, 0f683d3.
- /help uses registry + key table + subcommands, arrow/page scroll and Esc; long hints wrap at narrow widths. Help overlay owns input; keys never reach an agent. c924599/c836875.
- AGENTS.md changed exactly one local HTTP line: status 204 empty, usage 200 {} per OTLP/S12 (0e6cc3e). README full commands/keys, design/architecture updated (e38e4e7). D13 Auto extension reflects Yaniv's explicit request; Ask remains only saved default.
- Required final checks all exit 0: typecheck tsc --noEmit, lint eslint ., 68 test files / 455 passed / 2 skipped / 1 TODO / 11.26s, build success 16ms. Final coverage statements 87.56%, branches 81.87%, functions 89.12%, lines 94.71%. Diff whitespace/security checks clean.
- Detailed exact CLI help, local Codex source links, task/RED/GREEN mapping, security outputs, standalone smoke and manual checks: docs/testing/v0.1.8c-commands.md. Built shell smoke numbers: docs/testing/v0.1.8c-shell-smoke.json.

## What's next
- Yaniv checks physical command menu/Tab/help, effort per chosen model, Claude Auto and actual Claude conversation resume. Codex resume picker remains user-selected, as designed. Exact commands/check sequence in docs/testing/v0.1.8c-commands.md.
- v0.1.9 is next, not started. Usage export/billing manual check from v0.1.8b still needs Yaniv. Existing replaced-socket-path TODO remains.

## Manual checks
- Installed claude --help, codex --help, codex resume --help in isolated temporary homes: ran, direct Claude effort/Auto/session UUID/resume documented; Codex config/resume documented, no distinct Auto or effort help flag. Matching locally available rust-v0.160.1 config/enum used offline.
- Fake-vault/stub PTYs and real Unix socket resume: ran, UUID/recipe preserved, concurrent resumes at most one spawn, canary only in child env, never argv/state. No real engine or Keychain access.
- Headless menu/picker/effort/mode/Tab/help/clean/input isolation/README tests: ran. Actual physical terminal polish and CLI effort acceptance: needs Yaniv.
- Own built daemon/temp home plain shell: ran, /bin/sh -l running, nonempty preview, stopped/exited; home 0700/state 0600; own process/home cleaned.
- Restart: needs Yaniv when stopping existing sessions is acceptable. cd ~/ai-term && ai daemon stop && ai
- Claude effort/mode: needs Yaniv. cd ~/ai-term && ai; /model ANTHROPIC, /effort high, /mode auto or ask, inspect defaults/start box/Tab; only Ask needed for conversation check.
- Codex effort/mode: needs Yaniv. cd ~/ai-term && ai; /model OPENAI, /effort high, /mode auto gives unavailable note, /mode ask works.
- Claude continuation: needs Yaniv. cd ~/ai-term && ai; new Claude Ask agent remembers apricot, Ctrl+E, s/y stop, select exited record, /resume, Enter in, ask remembered word. Old agents lack conversation ID and show a note. Codex /resume uses own picker.
- Shell/clean/help: needs Yaniv. cd ~/ai-term && ai; /shell in current /cd, inspect/stop; /clean n then y and verify only finished records; /help arrows/pages/Esc including narrow widths; /settings e saves effort only.

## Gotchas
- Codex help exposes -c config overrides, not dedicated effort options. Exact supported finite effort enum comes from matching already available rust-v0.160.1 source; some models may accept fewer levels. Custom enum strings were intentionally not allowed. Claude direct effort flag needs no settings file.
- Claude help still names Ask manual; existing tested D40 canonical --permission-mode=default remains. Codex's approve-for-me is not used as Auto. Codex stays workspace-write sandboxed in Don't ask. No dangerous shortcuts in src.
- Public session effort/conversationId optional so old shell/agent states load; Claude legacy no-id cannot resume. Claude resume uses the stored UUID and no new-session UUID option. Codex supports specific UUID but AI Term has no documented way to learn one at spawn, so use picker without reading ~/.codex.
- Mode selection resets Ask after start/cancel and never persists a non-Ask default; compatible choice inside box survives model picker. Incompatible engine mode resets Ask, effort resets CLI default. Effort default saves paired defaultEngine through validated settings.
- New CLI inventory routing initially allowed debug stats extra to start a temporary daemon. RED reproduced it; fixed to reject before home creation. Only that own test daemon (confirmed socket path) was SIGTERMed; no own smoke/test daemon remains. Production daemon/home untouched.
- Some first failing tests had fixture timing/type assumptions: legacy fixture now waits old manager shutdown; homepage session timestamps deterministic; private Connection constructor cannot use InstanceType. Corrective tests committed; no history rewrite.
- Security greps no exec/execSync/shell:true; permission flags at env.ts:29–30 only; forbidden flags no matches; getPassword/setPassword outside keys.ts no matches. Direct serial diff review, no concurrent agents.
- No usage code change, keys.ts, spikes/docs/spikes/docs/reviews/.claude/package manifests/lock unchanged. No dependencies. No real ~/.ai-term, CLI login dirs, keychain, .env access. Help-only CLI runs and local tests, no network except explicitly requested delivery push.
- Final documentation includes needed manual UI actions alongside exact cd ~/ai-term && ai commands; no claim real conversation/permission/billing behavior was observed.

## New dependencies
- None. Existing typed protocol/validators, renderer, node-pty and vitest are sufficient.

## Concepts introduced
- Command registry (src/client/tui/commands.ts): each command has one description, hint and current-value reader. The menu/help/completion share it so a new command cannot quietly differ across entry points; tests also compare the README and CLI inventory.
- Engine-specific effort (src/shared/validate.ts and src/daemon/env.ts): CLIs support different reasoning values, so validate against the selected engine before building one argv element. Null means leave the CLI's own default alone; a supported CLI level may still be unsupported by a particular model.
- Conversation versus process identity (src/daemon/session-manager.ts): AI Term's record ID identifies one PTY run, while Claude's conversation UUID identifies saved chat history across runs. Resume creates a new run with the same conversation and reserves it during spawn so concurrent requests cannot start duplicate writers.
- Per-session modes (src/client/tui/homepage.ts): next-agent choices are visible before starting, but Auto/Don't ask are not persisted defaults. After starting or cancelling, Ask returns; compatible in-box choices survive a model change.
- Help viewport (src/client/tui/help.ts): long text wraps to terminal-cell width before scroll offsets are clamped. Arrow/page keys move the viewport while the overlay owns input, keeping those keys out of agent sessions.
