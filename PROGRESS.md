# PROGRESS

## Checkpoint
Last commit: 8ec7899 docs: clarify verified paste-fragment guarantee
Roadmap step: v0.1.8e done
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at e44d516 with 477 passed / 2 native Keychain opt-in skips / 1 existing TODO. Final 503 passed / same skips and TODO, 76 files. B11 fixed. v0.1.9 not started.

## What works
- Command bar and start-box message row represent a paste over one line or 200 characters as [pasted · N lines]. In-memory fragments preserve full text/newlines; start row shows token plus clipped first line. Backspace deletes the token whole; typed surrounds, nonempty-field shortcuts, model-picker round trips and Esc restoration work. Small pastes remain literal. RED 07f5113 → GREEN b57f7f9.
- Combined first-message limit is 16,384 UTF-8 bytes, shared with validate.ts. An oversized insertion adds nothing and gives the exact too-long instruction. Parser consumes the entire rejected paste. Slash-looking token drafts become first messages, not commands. OSC11-looking content inside pastes survives terminal-reply filtering intact. RED 2008247 → GREEN fdc2a3f.
- /copy all copies selected-session mirror cells with generic edge-border, decoration-only line and blank-run cleanup. Code indentation, internal borders, Markdown and Unicode remain. /copy and empty-field c copy the same cleaned text and say last reply only comes with v0.2. No screen guessing/hook/notify code. Existing captured copy target, fake copier error/shutdown handling, 5 MiB byte cap and bounded transport chunks remain. RED 0890085 → GREEN 5a8f72b.
- Registry, /help, README and design/architecture docs describe /copy, /copy all, c, the paste token, Backspace and the limit. Tab offers all while bare /copy still runs on Enter. Unsupported arguments copy nothing. README registry test passes.
- Private Unix-socket/PTY tests use own local Node stub agents for both engines. A runtime-generated pasted canary beyond the old 4096 cap reaches argv intact (SHA-256 matches) and appears in no response/event/stdout or regular file under the temporary root. Fake copy and failure logs contain no canary. Agent spawn errors now log fixed text because their details may contain first-message argv. RED ec6e85a → GREEN 1d1aa0d.
- Read-only typescript-reviewer approved e44d516..26fe2d0 with no remaining findings; 69 targeted tests, typecheck/lint pass. Parent edits paused during each review. HIGH quadratic border suffix cleanup fixed with a linear scan, and MEDIUM paste-note visibility under slash/budget/daemon warnings fixed. RED f0835e4 → GREEN 71f5e43; RED 006ed7f → GREEN 26fe2d0. Reviewer verified 500,000 internal glyphs intact in about 1 ms.
- Verification-loop final exits 0: typecheck tsc --noEmit; lint eslint .; build success in 19 ms; plain npm test final rerun 76 files / 503 passed / 2 skipped / 1 TODO / 11.00 s. Coverage with four workers: statements 88.41%, branches 82.77%, functions 90.03%, lines 95.07%. Security process grep has no matches, diff whitespace clean, protected paths unchanged. Full TDD/review/output index: docs/testing/v0.1.8e-paste-copy.md.

## What's next
- v0.1.9 next; not started. Yaniv still needs the physical paste/agent/Notes checks below.
- Exact last reply is deferred to v0.2 Claude Stop/Codex notify. Prior real usage/billing/resume checks remain for Yaniv; no real sessions/logins were used here.

## Manual checks
- Lossless split UTF-8/CRLF/tab/escape-looking paste, atomic Backspace, typed surrounds, threshold/bounds, cancel/picker restoration and warning precedence: ran in fake TTY/grid tests.
- Local stub agents through private temporary Unix socket and own PTYs, digest-verified first message, recursive temp-file canary scan: ran for both engines. Own PTYs shut down, temporary roots removed.
- Generic copy cleanup, linear long-run regression, /copy/c/all scope/count/target/error/shutdown handling, README/help: ran with fake copiers; real clipboard never touched.
- cd ~/ai-term && ai daemon stop && ai — needs Yaniv: restart only when stopping existing sessions is acceptable; paste a multiline task over 200 chars in command bar, inspect token, edit around/delete/repaste, Enter and inspect start-box first line, then start and verify full message.
- cd ~/ai-term && ai — needs Yaniv: select that agent after reply, empty field c; expect copied count/name and v0.2 limitation note.
- cd ~/ai-term && open -a Notes — needs Yaniv: Cmd+V c result; retain it for comparison.
- cd ~/ai-term && ai — needs Yaniv: same agent, /copy all then Enter; expect copied count/name without v0.2 suffix.
- cd ~/ai-term && open -a Notes — needs Yaniv: Cmd+V /copy all below c result; inspect cleanup and compare both texts.
- cd ~/ai-term && ai — needs Yaniv: start box → four Down presses → paste multiline text; verify token/first-line, Backspace deletion, Esc restoration and >16 KB rejection with nothing inserted.

## Gotchas
- RTK.md referenced by the supplied instruction is absent. No other agent was working in this repo at start. Only the requested reviewer was delegated; review was read-only and serial with primary writes.
- First-message size is UTF-8 bytes, not JS characters; CRLF is one label boundary and preserved verbatim. Small pasted tabs retain old space behavior. Token data stays separate from rendered text; slash dispatch must follow draft metadata, not expanded text.
- Required rejection notes temporarily override slash/budget/daemon notices and clear on the next key/paste. Persistent daemon warning state remains and reappears. Linear suffix scan matters because mirror soft wraps can produce huge logical lines within the 5 MiB cap.
- Existing plain-suite flakes remain: usage-receiver oversized-body write ECONNRESET; one lifecycle log-file symlink replacement EEXIST; one debug-stats timeout/homepage-agents fixed Esc wait under 76-worker load. Unchanged lifecycle/usage serial rerun passed 38; bounded full run, coverage and final plain rerun all passed. No existing tests/usage behavior were changed to hide failures.
- Early fixtures typing b into empty field correctly opened Budget; fixtures were corrected to paste prefixes. Escape waits include existing reply-filter/parser delay. Border-only blank lines are dropped rather than becoming blank separators, per brief.
- Copy still uses active in-memory mirror only. A daemon restart restores records but not old output; test new output after restart. Exact reply extraction is v0.2; don't infer it from decoration-cleaned screen text.
- No new dependency, env.ts/daemon keys.ts/usage modules/spikes/docs/spikes/docs/reviews/.claude/.codex/.agents/package manifests/lock changes. Real ~/.ai-term/CLI credentials/keychain/.env untouched, no real claude/codex session, no network except the explicitly required final origin push. Never stop Yaniv's daemon to run tests.

## New dependencies
- None. Existing vitest, terminal grid/mirror, socket framing and clipboard wrapper suffice.

## Concepts introduced
- Atomic draft fragments (src/client/tui/message-field.ts): typed text and pasted blocks are stored as separate in-memory fragments. A pasted block renders as a short label but expands to its full content for the first message; Backspace removes that block as one edit, and copying/restoring the draft preserves this relationship.
- UTF-8 insertion budget (src/shared/validate.ts and src/client/tui/keys.ts): one character can occupy several bytes, so the first-message limit measures encoded bytes. The parser bounds retained paste memory and keeps consuming through its end marker after rejection; the field checks combined size before changing the draft.
- Linear decoration cleanup (src/client/tui/copy-clean.ts): generic rules remove terminal border decoration without identifying a provider or guessing a reply. Scanning the final glyph suffix once avoids a regex retrying at every point in a long internal rule, which would block the UI during copying.
