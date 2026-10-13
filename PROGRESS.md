# PROGRESS

## Checkpoint
Last commit: 7e38674 fix: slow quiet wakes to once a minute past 60 s, ignore unreadable quiet times, drop redundant trailing output events (GREEN)
Roadmap step: v0.2.4a done (homepage status; live look needs Yaniv)
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at c0ca308 after git pull --ff-only (up to date). Baseline 100 files / 596 passed / two native Keychain skips. Final 104 files / 619 passed / same two skips, twice consecutively (9.01 s, 8.89 s), plus five more green runs.

## What works
- Task 1, cards: RED 6441ad7 → GREEN 3f485e0, mockup fix RED 13d711b → GREEN fd7b5a1, review fixes RED a3acabf → GREEN 7e38674. New `src/client/tui/agent-card.ts` holds all card text; layout.ts draws it.
  - Line 1: name (bold when selected), right-aligned glyph + word + age; waiting is bold status-waiting. Don't ask keeps its red `!` before the glyph.
  - Line 2: `model · engine` (ink-2), right-aligned `ctx NN%` when it fits beside the whole model text with two cells, else the mockup's bare `NN%`, else nothing; ink-3, status-waiting from 85%. Only when ctxPercent is known.
  - Line 3: activity, then ` · auth` only when the whole auth label fits; no activity → auth alone. waiting → `asks: permission` / `asks: question` / `turn failed: …` (status-waiting); running → last tool (ink-3), or `quiet Ns` after 10 s with no output, tool or status change (ink-3; minutes after 60 s); done → `ready to review` (ink-3); failed → `exit N` / `exit N · reason` / `signal X` (status-error). Debug shells keep their v0.1 line.
  - Sorting: waiting first, then newest (existing sortSessions); the selection is by id, so it stays on the same agent when a status change reorders the list (homepage test).
  - Quiet timer: the homepage wakes once at the next 10 s crossing, then once a second while a visible card shows `quiet Ns`, then once a minute past 60 s; no timer when no visible card is running.
- Daemon (approved by Yaniv for quiet): `src/daemon/output-clock.ts` sends `session.updated` with a fresh lastOutputAt at most every 5 s while an agent outputs, plus one trailing event with the newest time; a status event resets it and drops a pending trailing event; disposed on exit, mirror failure, remove and shutdown. Never persisted (test counts state writes).
- Task 2, top line: `● N waiting` (bold) · `◐ N running` (starting counts as running) · `✓ N to review` · `✗ N failed`, each in its status color, zero counts hidden; budget warning unchanged and first.
- Task 3, preview header: `cpu 4% · 310 MB  ctx 62%` on the right; ctx alone when no usage; none when unknown.
- Task 4, narrow: below a 20-cell card text width ctx and activity drop and the age goes before the status word; compact layouts (60–99 cols) show everything (tests at 60/80/99 cols). The 36-col panel is the narrowest real case.
- Task 5: no command or key text changed, so README is unchanged. architecture §12.1 Homepage records the card rules and the output clock.
- Review: typescript-reviewer found no critical/high; medium 1 Hz forever past a minute and lows (unreadable times, redundant trailing event, mirror-failure dispose) fixed in 7e38674. Its note on wall-clock tests: kept (stable across all runs), listed below.
- Final verification, all exit 0:
  - `npm run typecheck`: `> tsc --noEmit`
  - `npm run lint`: `> eslint .`, no diagnostics
  - `npm test`: `Test Files 104 passed (104)` / `Tests 619 passed | 2 skipped (621)` / `Duration 9.01s`
  - `npm test` again: same counts / `Duration 8.89s`
  - `npm run build`: `ESM ⚡️ Build success in 18ms`
  - No raw hex in card/layout code; S8 grep clean; diff excludes keys.ts, env.ts, spikes/, docs/spikes/, docs/reviews/, .claude/; git diff --check clean.

## What's next
- v0.2.4b (notifications) only when Yaniv asks. Bar later.
- Live look of the cards in a real terminal needs Yaniv (below). Physical Claude/Codex status checks from v0.2.2/v0.2.3 still need Yaniv.

## Manual checks
- Card text, colors, 85% threshold, counts, sorting with selection, quiet timer, narrow/compact, preview ctx, throttled unsaved output events: ran headless with stub sessions and a stub shell; passed. Rendered a 130×45 and 80×30 frame with every status and read it.
- `cd ~/ai-term && node dist/cli/index.js daemon stop && node dist/cli/index.js` — needs Yaniv: restarts the daemon (stops running agents) so it sends output events.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv: start a Claude and a Codex agent; while one asks for permission its card sorts to the top with `● waiting` and `asks: permission`, the top line shows `● 1 waiting`, and ↑↓ selection stays on the agent you picked.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv: leave an agent silent mid-turn for 10+ s and see `quiet 10s` count up; after a turn see `✓ done` and `ready to review`; check `ctx NN%`/`NN%` on cards and in the preview header.

## Gotchas
- Card word is `done`; the top line says `to review` (design.md table lists both words). Line 3 activity replaces auth when auth doesn't fit whole; design.md's later "`! don't ask ·` line-3 prefix" was not added because the prompt keeps the line-1 `!` (calmer, no duplicate).
- Card ctx uses the mockup's bare `NN%` in the 36-col panel because `ctx NN%` would clip `model · engine`; wider (compact) panels show `ctx NN%`.
- quiet relies on daemon output events: sessions from an older daemon only update lastOutputAt on status changes, so restart the daemon. Accuracy is within 5 s.
- tests/homepage-quiet.test.ts and tests/output-events.test.ts use real time (≈1.3 s and ≈6 s); stable here, slow on a very loaded machine.
- No real ~/.ai-term, ~/.claude, ~/.codex, ~/.ssh, keychain, .env or real agent sessions accessed. No network except git pull/push.

## New dependencies
- None.

## Concepts introduced
- Throttle with a trailing edge (src/daemon/output-clock.ts): publish the first event at once, then at most once per interval, and always once more after a burst ends so the last value is never lost. That keeps "last output" accurate to 5 s while a busy agent emits output many times a second.
- Time-driven redraws without a ticker (src/client/tui/agent-card.ts nextCardTick, homepage.ts scheduleCardTick): instead of redrawing every second, compute when the visible text will next change (the 10 s crossing, the next second, the next minute) and set one timer for that moment, recomputed after every draw.
- Priority-based fitting (agent-card.ts cardText): each card part has a rank; when width runs short, lower parts degrade (`ctx NN%` → `NN%` → gone, age dropped) so the status glyph and word always survive. Never color alone.
