# PROGRESS

## Checkpoint
Last commit: 6b86aae fix: start box edits at the end, a new press resets a lost field drag, caret-aware field scroll, shortened spend (GREEN)
Roadmap step: v0.2.4a fixes done (B22, B23, command bar cursor + selection; live look needs Yaniv)
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at 7e7094f after git pull --ff-only (up to date). Baseline 104 files / 619 passed / two native Keychain skips. Final 109 files / 641 passed / same two skips, twice consecutively (9.65 s, 9.92 s).

## What works
- B22, Codex last reply: RED 938e0f9 → GREEN 20a78a7.
  - Cause, from the installed Codex 0.160.1 binary (`tui/src/app/thread_title.rs`, `tui/src/temporary_structured_request.rs`, the "Generate a concise, single-line task title…" prompt): the TUI names each new thread by running a temporary structured thread with a `{title}` output schema. Codex's legacy notify (`hooks/src/legacy_notify.rs`) fires `agent-turn-complete` for that thread's turn too, so its last message is `{"title":"Respond to greeting"}`. It comes from a different thread-id, not a misread field. No Codex setting turns the title thread off.
  - Fix: `src/shared/codex-title.ts` recognises a last message that is a JSON object with only a string `title`. `ai status-notify` drops that notify whole (no POST), and `parseCodexStatus` ignores such a body too. So the title never replaces the reply and never marks a running turn done. Tests cover both orders through the real daemon and `sessions.text lastReply`.
- B23, usage clarity: RED 2c2a701 → GREEN b46f49f (+ snapshot 8391858).
  - Field meanings, from the installed binary: `response.completed` carries the Responses API usage (`ResponseCompletedUsage`: `input_tokens`/`input_tokens_details`, `output_tokens`/`output_tokens_details`). `input_token_count` includes `cached_token_count`, and Codex's own turn metrics export `non_cached_input_tokens` beside `input_tokens` and `cached_input_tokens`. `output_token_count` includes `reasoning_token_count`. The math was already right, so it is unchanged.
  - `UsageTotal.cachedTokens` (optional, for older daemons) is summed per day, period and provider.
  - The Usage tokens row shows `80.8K (71.0K cached)` when every column fits it; else `80.8K (71.0K)` with `(…) cached ·` on the hint line (the 130-col reference); else totals only. Columns now share the panel after the labels, up to 23 cells each.
  - The narrow (<32) panel appends ` (N cached)` only when it fits.
- Command bar: selection RED 37eeee2 → GREEN 7adee71; cursor (Yaniv's mid-session request) RED 86f265d → GREEN bd7876b.
  - The field (`src/client/tui/message-field.ts`) is a list of units, each a grapheme or a whole paste token, with a caret and an anchor. Drawing and hit-testing live in `src/client/tui/command-bar.ts`.
  - Cursor: ←/→ move by character; Alt+←/→ (also ESC b / ESC f) move by word, a token counting as one word; Home/End and Ctrl+A/Ctrl+E jump to the ends. Typing and paste insert at the cursor, and Backspace/Delete work at it. The block cursor is drawn reversed over the character at the caret.
  - Selection:
    - A mouse drag in the field or Shift+←/→ selects, in the selection color (accent 38%). The caret block hides while text is selected.
    - Typing or paste replaces the selection. Backspace, Delete and Alt+Backspace remove it.
    - Esc or a click clears the selection; a second Esc clears the field. Ctrl+U clears the field.
    - Alt+Backspace (or Ctrl+W) deletes the previous word.
    - Tokens are always selected and deleted whole.
  - A field drag never copies. Preview drag-copy is unchanged. ↑↓ select agents only while the field is empty, as before. Homepage keys never reach an agent.
- README (keys table and Usage/Codex text), the help key table (`keyTable`), design.md (command bar, Usage tokens row, keyboard table) and architecture.md (B22, B23 field meanings) are updated.
- Review: typescript-reviewer found no critical/high issues. One medium and four lows, all fixed: RED 35f8afd → GREEN 6b86aae.
  - Medium: the start box inherited the bar's caret or selection.
  - Lows: a lost drag release swallowed the next press; a right-edge drag scrolled the text; a wide character at the caret was clipped; spend ≥ $1000 was clipped to a wrong number (now `$1235` / `$123.5K`).
- Final verification, all exit 0:
  - `npm run typecheck`: `> tsc --noEmit`
  - `npm run lint`: `> eslint .`, no diagnostics
  - `npm test`: `Test Files 109 passed (109)` / `Tests 641 passed | 2 skipped (643)` / `Duration 9.65s`
  - `npm test` again: same counts / `Duration 9.92s`
  - `npm run build`: `ESM ⚡️ Build success in 21ms`
  - The diff doesn't touch src/daemon/keys.ts, env.ts, spikes/, docs/spikes/, docs/reviews/ or .claude/. No `sk-` or raw hex in source. `git diff --check` is clean.

## What's next
- v0.2.4b (notifications) only when Yaniv asks. Bar later.
- Live checks below need Yaniv; restart the daemon first so status-notify and usage summaries come from the new build.

## Manual checks
- Selection/cursor/paste-token rules, parser key names, title-notify both orders, usage forms at 100/112/130/220 cols: ran headless with fake TTY, stub sessions and a stub Codex PTY; passed. Rendered field and Usage frames and read them.
- `cd ~/ai-term && npm run build && node dist/cli/index.js daemon stop && node dist/cli/index.js` — needs Yaniv: start a Codex key session, say "hii", wait for done, press c: the clipboard holds the reply, not `{"title":…}`.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv: the Usage tokens row shows e.g. `80.8K (71.0K)` and `(…) cached · b add` at 130 cols (wider windows show `cached` inline).
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv: in the command bar type text, then try ←/→, Option+←/→, Home/End, Ctrl+A/E, a mouse drag, Shift+←/→, Delete, Ctrl+U, Option+Backspace and a multi-line paste. Option keys need "Use Option as Meta key" in Terminal.app (iTerm2: Esc+).

## Gotchas
- End: with text in the field it moves the cursor; with an empty field it follows the preview live, like the letter shortcuts.
- Option+←/→/Backspace depend on the terminal sending ESC sequences (Meta). Without Meta, Terminal.app sends plain arrows or DEL. Ctrl+W is accepted as the word delete for presets that send it.
- Two ESC presses inside 30 ms (as one chunk) are not two Escapes; the parser reads ESC+ESC as an unknown sequence (unchanged behavior).
- The title-thread check is by reply shape. A real agent reply that is exactly `{"title":"…"}` and nothing else would be ignored; the card would then stay running until the next turn.
- `cache_write_token_count` (new in Codex 0.160.1) is not read; OpenAI/Azure don't bill cache writes separately.
- `src/client/tui/keys.ts` (the homepage input parser) changed; the protected `src/daemon/keys.ts` (keychain) did not.
- No real ~/.ai-term, ~/.claude, ~/.codex auth files, ~/.ssh, keychain, .env or real agent sessions were accessed. Codex's installed binary (~/.codex/packages/standalone/releases/0.160.1-…/bin/codex) was read with `strings` only. No network except git pull/push.

## New dependencies
- None.

## Concepts introduced
- Units instead of characters (src/client/tui/message-field.ts): the field stores graphemes and paste tokens as one list, and every position (caret, anchor, drag) counts units. A token is one unit, so no edit or selection can land inside it. A caret plus an anchor is all a selection needs: the range between them.
- Sticky horizontal scroll (src/client/tui/command-bar.ts fieldStart): the first visible unit is kept from the previous draw and moved only when the caret would leave the field or when the text's end fits again. Recomputing it from zero each time would shift the text under the mouse during a drag.
- Notify fan-out (src/shared/codex-title.ts): one CLI process can run several model threads, and a per-turn hook fires for all of them. The receiver must decide which turns belong to the user's conversation, here by the title thread's structured output shape.
