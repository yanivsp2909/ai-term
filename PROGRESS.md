# PROGRESS

## Checkpoint
Last commit: 0f61c8e chore: note why the width-table stand-in typechecks
Roadmap step: v0.1.6g done (three bug fixes and a docs sync). v0.1.6 is still partial: its live checks need Yaniv.
Branch: main, started from 2ee2353 (clean, 165 tests). This handover is committed last; its own hash is in git log.

## What works
- **WIDTH: emoji and wide characters line up.**
  - The daemon mirror, the homepage preview mirror and the homepage grid now all count cells with `@xterm/addon-unicode11` (`src/shared/unicode-width.ts`). Before, the mirrors used xterm's built-in Unicode 6 table and the grid used its own regex, so the three disagreed.
  - Test: `tests/unicode-width.test.ts` runs the spike's emoji and CJK demo through mirror → snapshot → preview → grid → `diffFrame` → a Unicode 11 terminal, and checks every cell.
  - Commits: 6f9a5d1 (dependency), 8806d6e (test), d1a6be1 (fix).
- **B4: theme-change reports are turned off after a session.** `RESET_MODES` now sends `?2031l`. Every exit path that checks reset bytes also checks it: 8 attach reasons, real Ctrl+E from vim, homepage quit, crash and hand-off. Commits: d089f8f (test), 8b68315 (fix).
- **B5: Codex never opens on its update menu.**
  - Every Codex argv starts `--no-daemon -c check_for_update_on_startup=false`. That setting is Codex's own: `codex-rs/config/src/config_toml.rs` at `rust-v0.160.1`, default true. When it's false, `get_upgrade_version` returns nothing, so neither the menu nor the banner appears.
  - Commits: 447b4c2 (test), 545432e (fix; it also updates the spawn-level argv stub).
  - Live check, run through AI Term's own daemon from a temp `AI_TERM_HOME` and a temp folder:
    - Codex 0.160.1 reached its main screen with no menu and no banner, although 0.162.1 is available.
    - The spike's earlier screens without the flag showed "Update available · 0.160.1 → 0.162.1".
    - No prompt was sent. Ctrl+C quit Codex, and the temp daemon was stopped.
- **Docs sync (b591904):**
  - Added D36–D39 and D42–D45 to the decisions log, and `--approve-for-me` to §7.2's never-passed list.
  - One line each for the width table (§5) and the update-check flag (§7.2).
  - 6f5ef1b adds `--approve-for-me` to the test's forbidden-flag list.
- **Review follow-ups:** 9780922 (textCells checked against a real Unicode 11 xterm on 10 edge cases: marks, VS16, skin tone, flag, keycap, Thai) and 0f61c8e (comment on the stand-in typings). code-reviewer found no critical, high or medium issues.
- **Checks on this branch:** build success; typecheck exit 0; lint "No issues found"; tests 31 files, 168 passed.

## What's next
- Yaniv runs the manual checks below. When the v0.1.6f ones pass, mark v0.1.6 done and go on to v0.1.7 (login/keys).
- D39 is pinned (bar spike passed). The bar's build step comes in v0.2. The Unicode 11 precondition from the spike is now met.

## Manual checks
- Emoji line in a session preview lines up (commands in the final report of this session): needs Yaniv.
- B5 Codex live start with no update menu, temp `AI_TERM_HOME`: ran (main screen, no menu, no banner, Ctrl+C quit).
- B4 in a real terminal: after Ctrl+E from Claude Code, switching macOS dark/light sends nothing into the shell: needs Yaniv.
- Carried from v0.2.1b, all need Yaniv: bar feel test; htop; kitty keyboard in Ghostty/iTerm2; real-terminal emoji widths.
- Carried from v0.1.6f, all need Yaniv (commands in `docs/testing/v0.1.6f-fixes.md`):
  - Codex account reply with no Azure error
  - Codex `/status` shows on-request + workspace-write
  - Claude Ask mode and its `ok` reply
  - S6 names-only env check
  - optional: Don't ask unchanged
  - title, palette and cursor after Ctrl+E and `/exit`

## Gotchas
- **Unicode 11 is not grapheme-aware.** A skin-tone emoji (👍🏽) is 4 cells, a ZWJ family is 2 cells per person, and ❤️ and flags are 1 cell per code point. The three AI Term counters agree with each other. Agents (Claude Code's string-width) and some terminals draw these sequences 2 wide, so lines with them can still drift in a real terminal. Plain emoji (🧪, 🧠) and CJK now match. `@xterm/addon-unicode-graphemes` would be the next step, but it's a new dependency.
- **A running daemon keeps its old mirror code.** Widths only change for sessions in a daemon started after this commit. Test with a temp `AI_TERM_HOME`, or restart the daemon.
- **The addon hands its width table only to `terminal.unicode.register`.** `src/shared/unicode-width.ts` captures it once from a stand-in object, so `Grid.text` uses the exact table the mirrors use. Its typings import `@xterm/xterm`, which isn't installed (`skipLibCheck` hides that), like `@xterm/addon-serialize`.
- **Codex `-c check_for_update_on_startup=false`** sits right after `--no-daemon` in `src/daemon/env.ts`, which stays the only place either flag is added.
- **Codex shows "⚠ 1 warning · f2 to view"** in its footer. It did so before this change too (v0.2.1b screens), so it isn't the new flag. Not examined, because reading it means pressing F2 in a session.
- **Idle Codex TUIs:** two `codex --no-daemon` processes not started by this session (PIDs 35182 and 97340) were running throughout. They were left alone.
- **Earlier gotchas still apply:**
  - The Bash tool runs zsh (no `timeout`).
  - Always filter `codex login status`.
  - Claude's `--permission-mode=default` alias.
  - Never script Enter into Codex or Claude.
- **Branch coverage** is still below 80% (77.09%); statement 85.27%, function 86.05%, line 91.51%.

## New dependencies
- `@xterm/addon-unicode11` 0.9.0, the release that matches `@xterm/headless` 6.0.0: the platform's own table (xterm's built-in Unicode 6) counts most emoji as 1 cell, while agents draw them 2 wide. The spike measured 25 misplaced cells on one line. A hand-written table would be a copy of this one to maintain.

## Concepts introduced
- **Unicode width table** (`src/shared/unicode-width.ts`): a terminal has no font metrics. It decides how many columns a character takes from a table of code points (East Asian wide = 2, combining marks = 0, the rest = 1). If the program and the terminal use different tables, every character after the disagreement lands in the wrong column. So AI Term uses one table everywhere it counts.
- **xterm-style cell splitting** (`textCells`): xterm doesn't use grapheme clusters. It gives each code point its own cell, except that a zero-width code point (accent, VS16, ZWJ) joins the cell before it. `Grid.text` now splits the same way, so text the homepage draws itself and text from a mirror take the same cells.
- **Turning off an update check per session** (`src/daemon/env.ts`): `-c key=value` overrides one Codex config key for that run only, without touching `~/.codex/config.toml`. AI Term uses it to stop the update menu without changing the user's own Codex settings.
