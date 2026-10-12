# PROGRESS

## Checkpoint
Last commit: e2161aa spike: v0.2 top bar (redraw vs raw)
Roadmap step: v0.2.1b done (top-bar spike). v0.1.6 is still partial: its live checks need Yaniv.
Branch: main, started from adf092d (clean, 165 tests). This handover is committed last; its own hash is in git log.

## What works
- **v0.2.1b top-bar spike (D39):** throwaway harness in `spikes/bar/`, report in `docs/spikes/v0.2-bar.md`. No product code changed.
- **Recommendation: go, with listed limits.** A client-side headless mirror redrawn under a one-row bar is fast and faithful enough. The window-title fallback isn't needed unless the manual feel test says otherwise.
- **Typing latency, p95, 500 keys, two rounds:** redraw adds +0.40/+0.49 ms (echo) and +0.62/+0.63 ms (vim) over raw. Gate is 2 ms: pass. It needs the user-input fast path; without it the cost was +2.03 ms.
- **CPU:**
  - `noise.js` for 30 s: raw 0.74%, redraw 2.89% of one core (flag at 25%: not reached).
  - Extra `yes` flood: raw 79%, redraw 92% (flagged). Redraw sends the terminal 13 KB/s instead of 85 MB/s.
- **Fidelity:** redraw matches the program run directly at the agent's size, cell for cell.
  - Pass: vim (insert, visual, `:split`, click, wheel, `:q`), less (scroll, search), truecolor/256/16 colors and attributes, CJK and emoji (with a modern width table), bracketed paste, Esc, resize, alt screen, title, all 4 mouse encodings with bar clicks dropped, and all 5 Ctrl+E forms. A Ctrl+E inside a paste stays text.
  - Claude Code 2.1.296 and Codex 0.160.1 render, take typing in their input box (no Enter, no prompt sent) and quit with Ctrl+C.
- **Raw passthrough at rows − 1 is confirmed broken:** `less` is off by a row (1,130+ cells), and leaving the alternate screen shows the terminal's own normal screen.
- **Losses vs raw:** OSC 8 link targets, underline style/color, inline images, terminal identity in DA2/XTVERSION answers, some color queries, and flood CPU. The mirror also needs a modern width table: the built-in Unicode 6 table fails emoji (25 cells).
- **Checks on this branch:**
  - `npm run typecheck`: `tsc --noEmit`, exit 0
  - `npm run lint`: ESLint: No issues found, exit 0
  - `npm test`: Test Files 30 passed (30); Tests 165 passed (165)
  - `npx tsc -p spikes/bar/tsconfig.json`: exit 0
- **Still true from v0.1.6f (D40, D41):** every Codex argv starts with one `--no-daemon`; `AZURE_OPENAI_API_KEY` passes through to Codex account sessions; Ask passes explicit ask flags. All permission flags live in `PERMISSION_ARGS` in `src/daemon/env.ts`.

## What's next
- Yaniv runs the v0.1.6f manual checks below. When they pass, mark v0.1.6 done and go on to v0.1.7 (login/keys).
- Yaniv runs the bar feel test (2 minutes, commands in `docs/spikes/v0.2-bar.md`) and decides D39: build redraw, or fall back to the window title.
- If go: the bar's implementation step(s) in v0.2. About 600–700 product lines plus about 300 test lines, files listed in the report.
  - Preconditions: a modern width table in both mirrors (own table, or a new dependency Yaniv approves).
  - Add D39 to the architecture decisions log (it's missing there).

## Manual checks
- Spike, automated in a PTY with a headless terminal: latency, CPU, the fidelity matrix, Ctrl+E forms, and Claude/Codex first screen, typing and quit: ran (numbers in the report).
- Bar feel test in a real terminal (vim and Claude Code, raw vs redraw; flicker, typing feel, colors, cursor shape): needs Yaniv.
- htop (colors, mouse click, F10): needs Yaniv. It isn't installed here; `top` stood in.
- Kitty keyboard path in Ghostty or iTerm2 (the test terminal had none): needs Yaniv.
- Real-terminal emoji widths (Terminal.app vs others) with the redraw harness: needs Yaniv.
- Carried from v0.1.6f, all need Yaniv (commands in `docs/testing/v0.1.6f-fixes.md`):
  - Codex account reply with no Azure error
  - Codex `/status` shows on-request + workspace-write
  - Claude Ask mode and its `ok` reply
  - S6 names-only env check
  - optional: Don't ask unchanged
  - title, palette and cursor after Ctrl+E and `/exit`

## Gotchas
- **xterm parses `write()` on a later timer tick** (at least 1 ms in Node) unless the write follows user input. A redraw client must call `term.input('', true)` after forwarding keys, or it loses about 2 ms per keystroke (`spikes/bar/bar.ts`, `send`).
- **@xterm/headless 6.0.0 has only Unicode 6 widths**, where most emoji are 1 cell. Today's daemon mirror has this too, so snapshots of emoji-heavy screens can already be misaligned.
- **`RESET_MODES` doesn't turn off mode 2031**, which Claude Code turns on. After Ctrl+E, a terminal that supports it keeps sending theme reports. Not fixed (spike only).
- **Codex's update notice:**
  - It ignores Esc for over a second, and Enter on it means "Update now". Ctrl+C skips it.
  - Its main screen keeps an "Update available" banner, so match the menu text ("Skip until next version"), not "Update available".
  - Never script Enter into Codex or Claude.
- **The flood test crashed the driver once,** because a raw `yes` flood fills a JS string in seconds. CPU runs now only count bytes.
- **The driver drops this Claude Code session's `CLAUDECODE` and `CLAUDE_CODE_*` markers** before starting an agent, as a daemon started from a plain shell would.
- **Codex `--no-daemon` rules:** never add the flag anywhere but `src/daemon/env.ts:35`, because Codex rejects it twice. It's top-level only: `codex --no-daemon login status` works, `codex login status --no-daemon` fails.
- **Claude's `default` permission mode:** Claude 2.1.296 accepts `--permission-mode=default`, but its help lists only `manual`. If the alias goes away, switch `PERMISSION_ARGS` to `manual`.
- **Always filter `codex login status`:** it prints a masked key hint.
- **The Bash tool runs zsh:** `$var` isn't word-split, and `timeout` doesn't exist.
- **Idle Codex TUIs:** a `codex --no-daemon` TUI was open in `~/ai-term` during both v0.1.6f and this session (0% CPU, no repo changes). Close it before the next agent starts.
- **Branch coverage** is still below 80% (77.09%); statement, function and line coverage are above.

## New dependencies
- None. The spike uses node-pty, @xterm/headless and tsx, which are already in the repo.

## Concepts introduced
- **Client-side mirror redraw (tmux model)** (`spikes/bar/bar.ts`, `render.ts`): instead of piping the agent's bytes to your terminal, the client feeds them into its own invisible terminal and then paints that terminal's cells wherever it wants, here one row lower. The agent can clear the screen or jump to row 1 as much as it likes; it only changes the invisible copy, so the bar stays put.
- **Passthrough policy** (`spikes/bar/passthrough.ts`): once you redraw, nothing reaches your terminal unless you send it on purpose. Each escape sequence gets one of three choices:
  - forward it, if it's about your terminal's input or look (mouse modes, paste mode, title);
  - answer it from the mirror, if it's about the agent's own screen (cursor position);
  - drop it, if there's no faithful way to pass it (a clipboard read, link ids).
- **Mouse row shift** (`spikes/bar/mouse.ts`): your terminal counts mouse rows from its own top row, which is now the bar. So every click report gets its row reduced by one before the agent sees it, and clicks on the bar itself never reach the agent.
