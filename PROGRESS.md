# PROGRESS

## Checkpoint
Last commit: 77ee7d8 test: capture the paste-then-prompt outcome at once; document the login flag
Roadmap step: remaining homepage commands + B24 (tasks 1–8) done
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at ec8a01c after `git pull --ff-only` (already up to date). Baseline 141 files / 886 passed / 2 opt-in Keychain skips. Final 147 files / 937 passed / same 2 skips, twice in a row. Session: Claude Code, Opus 5.5 (the prompt was written for Codex; it was pasted into this session, as with v0.3 splits).
Prompt vs code:
- **`u` didn't exist.** design.md lists `u` as "Usage details (… v0.1 can ship without it)" and it never shipped. `/usage` and `u` now open that popup, by period and provider: the daemon's summary has no by-model or by-agent breakdown, so those wait.
- **The first message is not kept** anywhere after spawn (it goes into argv only), so `/retry` never resends it and says so.
- **Retry replaces the old record** (the prompt says "restart the selected agent"); the worktree record is untouched. A failed `/login` session reruns the login; sessions started by /login now carry `login: true` (older login records lack it and would retry as an agent).
- **`/send` gates beyond the prompt:** besides permission/question waits, exited agents and attached agents (any session or split, on any client), an AI agent must have sent one hook or run-state signal first, because Claude's and Codex's folder-trust prompts report nothing and an Enter there accepts. In practice: start agents with a first message, or go inside once. Without bracketed paste only one line may go. Enter is a separate write 50 ms after the paste, rechecked; kitty flag 8 makes it CSI 13 u.
- **`/send` limits:** 16 KB (16,384 UTF-8 bytes), the first-message cap. Controls except newlines are dropped, tabs included (the prompt says "stripped"). Names match exactly; with names that prefix each other the longest wins (reviewers flagged the surprise; the success note names the recipient).
- **B24 note is a `daemon.notice`, not a warning.** A daemon warning holds the note line, so it would have hidden every other note (including /send refusals) for the daemon's lifetime. Found by running the built app. It shows each time a homepage opens until the daemon restarts.
- **B24 scope:** a corrupt or symlinked state.json is moved aside (the link itself; its target untouched), not refused. A non-list `worktrees` field counts as validate. A single invalid worktree record is still skipped (existing documented behaviour) rather than moving the whole file.
- **`/open`:** `/usr/bin/open -- <path>` was checked to honour `--` (a missing path, no GUI). A folder whose name has an extension (`Tool.app`) is revealed with `-R` instead of launched (review L3). `code` gets a minimal env allowlist, never the shell's API keys.
- No protocol version bump: `sessions.retry`, `sessions.send`, `sessions.find` and `daemon.notice` are additive. An old daemon answers the new commands with "Unknown request kind" until it restarts.
- homepage.ts is now 818 lines (over the 800 guideline); the new handlers live in their own modules where they could.

## What works
- **`/retry`** (`session-manager.ts retry`, homepage `retrySelected`): same engine, model, auth, effort, mode and folder, in its worktree if the record and folder still exist; a new Claude conversation, never Codex's resume picker; an agent that ran in place stays in place even with worktrees turned back on. Refused: running (`<name> is still running · /retry restarts finished agents`), worktree gone, folder gone, a worktree another live agent uses, a busy worktree, a retry already starting.
- **`/send <agent> <text>`** (D50; `send-command.ts`, `session-manager.ts unsendable/send/caughtUp`): Tab completes and cycles running agents; paste tokens go whole; one bracketed paste then Enter. Refusals name the agent: `<agent> is asking for permission, go inside to answer`, `… is asking a question, …`, `… is open in a session or split · type there`, `… has exited · /retry restarts it`, `… may be asking to trust its folder · go inside first`, `… is printing too fast to check · try again`, `… started asking something · text pasted but not sent, go inside`. The daemon waits for its mirror to parse every earlier chunk (and the status signals they queue) before the paste and before Enter. Text is never logged or saved.
- **`/find <text>`** (`mirror.ts find`, `find-panel.ts`, `preview.ts scrollTo`): plain text, case-folded, scrollback + screen, soft wraps joined; ≤ 200 query chars, ≤ 50 hits per agent, 200 total. Popup rows: agent name, line with the match accent + bold. ⏎ selects the agent (showing a hidden preview) and scrolls so the line sits a third down, refinding the matched text near the reported row if the agent printed since.
- **`/open`, `/open code`** (`open-folder.ts`, `shared/executable.ts`): worktree root or cwd; fixed one-line reasons.
- **`/doctor`** (`cli/doctor.ts doctorLines`): the same redacted lines as `ai doctor`, in a popup; `ai doctor` still prints as it goes.
- **`/budget`** = `b`; **`/usage`** = **`u`** (new key) = usage details popup.
- **B24** (`store.ts moveAside`, `session-manager.ts load/readSaved/validateState/migrateState`): read, parse, validate or migrate failure → `state.json.corrupt-<ISO timestamp>` (0600, `-N` if taken), empty list, fixed log `Agent list could not be loaded (<stage>)`, note `couldn't read your agent list; saved it as <file>`. If it can't be moved, the daemon stops with a fixed reason and the file untouched. Lost worktree records leave those folders `Not in AI Term's record`, so S14 refuses to delete them (tested).
- Docs: README command list and keys, design.md (/find popup and the other commands), architecture (requests, B24, D50 as built, S17).

### Tried in the built app (headless PTY, temporary HOME and AI_TERM_HOME, its own daemon, stopped after)
B24 note and move-aside; `/send one echo sent-$((40+2))` ran in a zsh login shell (the preview showed `sent-42`); `/send` unknown name, missing text and Tab completion; `/find` popup and Enter; `/doctor` popup (claude/codex not found on that PATH); `/usage`, `u`, `/budget`; `/retry` refusing a running shell and restarting a stopped one. `/open` was not run: it would open a Finder window on Yaniv's screen.

### Reviewers (fresh context, high, diff ec8a01c..HEAD)
- **security-reviewer:** no CRITICAL or HIGH. MEDIUM M1 (status could be stale behind the mirror queue), LOW L1 (a context report counted as "reported"), L3 (`.app` folder launched), L4 (a directory named `code` shadowed PATH), L6 (non-list worktrees dropped) → failing tests b034167, fixes 0dcfd00. L2 (shells ungated) and L5 (longest-name rule) are by design and documented; the lost-Claude-hook window (M1 part 1) can't be closed here and is documented in D50 and the README.
- **typescript-reviewer:** no CRITICAL or HIGH. MEDIUM: concurrent retries both started; login sessions retried as agents; a /find hit scrolled past its line after more output. LOW: final sigma never matched → failing tests ae28736, fixes 430aa75. LOW longest-name rule (by design), skipped invalid worktree record (existing behaviour) and `.app` (already fixed) not changed. It saw one unrepeatable failure of the paste-then-prompt race test; that test now captures its outcome at once (77ee7d8).

### Final check output
```
npm run typecheck   > tsc --noEmit                      (exit 0)
npm run lint        > eslint .                          (exit 0)
npm run build       ESM ⚡️ Build success in 22ms
npm test (1)        Test Files  147 passed (147) · Tests  937 passed | 2 skipped (939) · 14.53s
npm test (2)        Test Files  147 passed (147) · Tests  937 passed | 2 skipped (939) · 14.43s
```

## What's next
- The next roadmap step. Nothing is left from this one except the manual checks below.

## Manual checks
All need Yaniv, after restarting the daemon when it's safe (`cd ~/ai-term && node dist/cli/index.js daemon stop`):
- /send to an idle agent, needs Yaniv: `cd ~/ai-term && npm run build && node dist/cli/index.js`, start an agent with a first message, wait for it to finish (✓ done), then `/send <name> ` + Tab, paste two lines, ⏎: `✓ sent to <name> · 2 lines` and the agent gets one message.
- /send to one asking permission, needs Yaniv: `cd ~/ai-term && node dist/cli/index.js`, ask an agent in Ask mode to run a shell command, and while it shows `◐ waiting · permission` type `/send <name> 1` ⏎: `<name> is asking for permission, go inside to answer` and nothing reaches it.
- /send to a fresh agent at its trust prompt, needs Yaniv: `cd ~/ai-term && node dist/cli/index.js`, start an agent with no first message in a new worktree, `/send <name> hi` ⏎: `<name> may be asking to trust its folder · go inside first` (also confirms the reviewers' L1 assumption).
- /retry, needs Yaniv: `cd ~/ai-term && node dist/cli/index.js`, select a failed or exited agent, `/retry` ⏎: it restarts in the same worktree (same `ai/<slug>` on the card) and the old card is gone.
- /find, needs Yaniv: `cd ~/ai-term && node dist/cli/index.js`, `/find error` ⏎, ↑↓, ⏎: that agent is selected and its preview shows the line with `↑ N lines back`.
- /open, needs Yaniv: `cd ~/ai-term && node dist/cli/index.js`, select an agent, `/open` ⏎ (Finder opens its worktree), `/open code` ⏎ (VS Code, or the note when `code` isn't on PATH).
- /doctor, needs Yaniv: `cd ~/ai-term && node dist/cli/index.js`, `/doctor` ⏎: the same lines as `ai doctor`; Esc closes.
- B24, needs Yaniv (optional, uses a copy): `cd ~/ai-term && AI_TERM_HOME=/tmp/ai-b24 node dist/cli/index.js` once and quit, then `cd ~/ai-term && AI_TERM_HOME=/tmp/ai-b24 node dist/cli/index.js daemon stop && printf '{"sessions":[' > /tmp/ai-b24/state.json && AI_TERM_HOME=/tmp/ai-b24 node dist/cli/index.js`: the note names `state.json.corrupt-…`; then `AI_TERM_HOME=/tmp/ai-b24 node dist/cli/index.js daemon stop`.
- Headless (ran): the tests above and the built-app run listed under What works.

## Gotchas
- `/send` won't go to an AI agent until it has sent a hook or run-state signal; an agent started without a first message needs one visit inside first.
- A Claude permission prompt is seen only through its HTTP hook. If the hook is lost, a `/send` during the prompt can still hit it (D50). Don't /send to an agent you expect to ask something.
- In tests, unblock `/send` with a hook event such as `Stop`, not `AITermContext`; `SessionManager.sendEnterDelayMs` is static so a race test can widen the window (restore it).
- `String.prototype.replace` with a string replacement eats `$$`; edit scripts that insert template literals must use split/join.
- The macOS temp folder is `/var/folders/…` but `realpath` gives `/private/var/…`; worktree listings use the real path.

## New dependencies
- None.

## Concepts introduced
- **Moving aside instead of overwriting (`store.ts moveAside`):** a state file that fails to load is renamed, never read again or rewritten, before the daemon writes a fresh one. `rename` moves a symlink itself rather than its target, and only a regular file of ours is chmodded, because chmod follows links.
- **Status freshness (`session-manager.ts caughtUp`):** the daemon's idea of an agent's status comes from parsing its output in order. Waiting on the output chain, then one `setImmediate`, means every chunk that arrived before the check, and the status signals it queued, is applied before /send decides.
- **Counting from the bottom (`mirror.find`, `preview.scrollTo`):** the daemon's mirror and the homepage's preview keep different amounts of scrollback but end at the same row, so a row named by its distance from the end means the same line in both, until the agent prints more. Then the preview looks for the matched text nearest that row.

---

## Previous checkpoint (v0.3 splits, retained)

## Checkpoint
Last commit: 7c7a6b7 test: record split latency against a single raw attach
Roadmap step: v0.3 splits (tasks 1–6) done
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at c4e34df after `git pull --ff-only` (already up to date). Baseline 136 files / 839 passed / 2 opt-in Keychain skips. Final 141 files / 886 passed / same 2 skips, twice in a row. Session: Claude Code, Opus 5.5 (the prompt was written for Codex; Yaniv asked for it to run here).
Prompt vs code:
- **Pane key is Ctrl+\, not Ctrl+].** Claude Code 2.1.299's default keybindings include `"ctrl+]":"app:openArtifact"` (Global context; found in the installed binary under ~/.local/share/claude, help run with a temp HOME). The same binary lists Ctrl+\ among the keys it never binds ("Terminal quit signal (SIGQUIT)"). Codex `--help` (temp HOME) lists no keys; its install lives under ~/.codex, which the prompt forbids reading, so nothing further was checked there.
- The daemon lets one connection own one attached agent (server.ts `peer.attached`), so each pane opens its own connection. No protocol or daemon change.
- Splits work whatever the bar setting is: opening one is its own opt-in, and the bar's default-off is about an unexplained Terminal.app spike exit.
- `yes` prints identical lines, so its pane's cells barely change and the diff renderer sends almost nothing. The latency gate was therefore also run with a flood of numbered lines, whose every frame is drawn (about 46 KB/s to the terminal).
- Calmer choices where design.md was silent: a one-column `│` divider between side-by-side panes; the accent underline uses the colon form of SGR 58 (terminals that don't know it skip it, and the underline takes the text color); `◆ marked` on line 3 of the card; marks are capped at 4 and refused for exited agents; a window resized below the minimum shows `make the window bigger · ^E home` and types nowhere.
- From the review: three panes too wide to sit side by side take two on top and one full width below (the prompt lists only side by side), so closing one of four never hides the rest.

## What works
- **Marks and `v` (homepage):** Space marks or unmarks the selected agent (`◆ marked`, accent, glyph + word), up to 4, with a note line count. `v` opens the marked agents in list order and clears the marks; with none marked it reopens the split Ctrl+E left, or shows `Space marks 2–4 agents · v opens them side by side`. Only while the command field is empty.
- **Layout (`split-layout.ts`):** 2 and 3 side by side, 4 as 2×2, 3 falls back to 2-over-1; each pane ≥ 40×10 including its one-row header. A too-small terminal opens as many as fit and the bottom row says `N agents didn't fit`; if only one fits it's a normal attach. Each agent's PTY is attached at pane width × (pane height − 1) and resized on SIGWINCH; leaving detaches each pane, so sizes follow the existing rules.
- **Rendering (`split.ts`, `split-pane.ts`, `tui/split-chrome.ts`):** one client mirror per pane with the bar's passthrough and `BodyRenderer` (now with a column offset). Changed cells only, inside synchronized output; every frame ends with the cursor on the focused pane. Focused pane: 8 ms spacing and same-tick echo; others at most 30 fps. Flood cap: 8 KB parse per event-loop turn per pane; past 1 MB queued, that pane's socket pauses until it is under 256 KB. Headers: glyph + word, bold name, model · branch; focused header surface-2 with an accent underline. Bottom row: `each pane is its own agent in its own worktree` and `^\ next pane · ^\ ^\ sends ^\ · ^E home`.
- **Input (`split-input.ts`, `split-mouse.ts`):** keys and pastes go to the focused agent only. Ctrl+\ (raw, kitty, modifyOtherKeys; kitty releases swallowed) focuses the next pane or closes ended panes; twice within 0.4 s goes back and sends one real Ctrl+\ in the encoding it arrived in. Ctrl+E goes home. The terminal stays in any-motion SGR mouse mode; events are re-encoded for the pane under the pointer in its tracking level and encoding; a press focuses; a drag stays with its pane. Nothing inside a bracketed paste is interpreted.
- **S15:** only the focused pane's passthrough reaches the terminal (modes, cursor shape, title, bell, OSC 52 writes); background panes are cells only. On focus change the terminal takes the new pane's keyboard modes, cursor shape and title (`Passthrough.restore()`). OSC 52 reads always dropped. Kitty flags are set, not pushed, so panes never share stack entries.
- **Exits:** an ended agent's pane shows `■ exited · exit 0` / `✗ failed · exit 1` and `^\ closes`, and takes no keys; Ctrl+\ closes it; one pane left becomes a normal attach. `session.removed` closes a pane; a takeover shows `■ attached elsewhere`; a lost daemon connection ends the split with an error.
- Docs: README key list and split notes, design.md split spec and keyboard row, architecture §12.4, in-app help rows.

### Latency (scripts/measure-split.ts, docs/testing/v0.3-split-latency.json)
Method: outer PTY 120×40, real daemon, sockets and client; write to the outer PTY → arrival of the chunk that shows the typed cell and puts the cursor after it (read between complete synchronized frames). 50 warmup + 500 measured keys per run, 15/20/25 ms gaps, two rounds in reversed order, no timeouts. Node v26.3.0 darwin arm64. Split = 2 panes, echo focused, the other pane flooding. Raw = `ai debug attach` with the bar off.

| Config | Round | p50 | p95 | p99 | max | outer KB/s |
|---|---:|---:|---:|---:|---:|---:|
| raw attach | 1 | 1.88 | 2.14 | 2.45 | 4.34 | 0 |
| raw attach | 2 | 1.85 | 2.07 | 2.33 | 2.48 | 0 |
| raw attach + background numbered flood | 1 | 1.88 | 2.06 | 2.22 | 3.08 | 0 |
| raw attach + background numbered flood | 2 | 1.74 | 2.01 | 2.18 | 3.15 | 0 |
| split, other pane `yes` | 1 | 2.28 | 2.63 | 2.80 | 9.36 | 1 |
| split, other pane `yes` | 2 | 2.14 | 2.55 | 2.75 | 3.91 | 2 |
| split, other pane numbered flood | 1 | 2.02 | 2.41 | 3.20 | 6.35 | 46 |
| split, other pane numbered flood | 2 | 2.02 | 2.32 | 2.71 | 5.73 | 47 |

Gate (focused echo p95 within 2 ms of a single raw attach): `yes` +0.49 / +0.48 ms, numbered flood +0.27 / +0.25 ms. **Pass.** These are headless PTY delivery times, not Terminal.app pixels or feel.

### Reviewer (typescript-reviewer, high, fresh context, diff c4e34df..167f744)
No CRITICAL or HIGH. Six findings, all real; failing tests b3ba0ec, fixes 7247f69 and 7c0193b:
- MEDIUM: a sync block ending in a later chunk waited out the 150 ms hold (would delay the focused echo).
- MEDIUM: connections and attachments leaked when the split ended during attach or a connect failed.
- MEDIUM: closing one of four panes on 81–121 columns hid every agent (three side by side need 122).
- LOW: a press after a lost release went to the old pane.
- LOW: one empty input frame per typed key.
- LOW: a full redraw asked for while stdout was blocked was lost.
Not flagged as issues: Ctrl+\/Ctrl+E kitty forms ignore lock modifiers (same as the existing home-key filter); a pane's `session.updated` redraws chrome outside the 30 fps pacing (rare).

### Final check output (all exit 0)
```
npm run typecheck   > tsc --noEmit
npm run lint        > eslint .
npm run build       ESM ⚡️ Build success in 21ms
npm test (1)        Test Files  141 passed (141) · Tests  886 passed | 2 skipped (888) · 13.31s
npm test (2)        Test Files  141 passed (141) · Tests  886 passed | 2 skipped (888) · 13.32s
```

## What's next
- The next roadmap step after v0.3 splits. Nothing is left from this one except the manual checks below.

## Manual checks
All need Yaniv, after an explicit daemon restart when it's safe (`node dist/cli/index.js daemon stop`), each starting with `cd ~/ai-term && npm run build && node dist/cli/index.js`:
- Two agents, needs Yaniv: start two agents, select one and press Space, ↓, Space (both show `◆ marked`), then `v`; both open side by side and the marks are gone.
- Type in each, needs Yaniv: type in the left pane; only it echoes. Ctrl+\ moves focus (header turns surface-2 with the underline); type in the right pane.
- Ctrl+\ twice, needs Yaniv: two quick presses keep focus where it was and send the agent one Ctrl+\.
- Click switches, needs Yaniv: click inside the other pane; it takes focus and the click reaches the agent if it uses the mouse.
- Ctrl+E and v, needs Yaniv: Ctrl+E goes home with both agents running; `v` with nothing marked reopens the same split.
- vim in one pane, needs Yaniv: `/shell` twice, mark both, `v`, run `/usr/bin/vim -Nu NONE` in one; insert, move, `:q`; the other pane is untouched.
- Resize, needs Yaniv: drag the window narrower and wider; panes re-lay and the agents redraw; below 81 columns it shows `make the window bigger · ^E home`.
- Exit, needs Yaniv: `/exit` in one pane's agent; the pane shows `■ exited · exit 0 · ^\ closes`; Ctrl+\ turns the other into a normal attach.
- Headless (ran): layout math for 2/3/4 and too-small terminals; key routing (focused only, Ctrl+\ single/double in raw and kitty forms, Ctrl+E); mouse translation in all four encodings and tracking levels; one pane exiting; resize and too-small; S15 output gating; flood pause/resume; homepage marks and `v` through a headless xterm; the latency harness above.

## Gotchas
- While a split is open the terminal reports every mouse motion (`?1003`), so your terminal's own text selection needs its mouse-reporting bypass, as on the homepage.
- Panes have no scrollback (like the bar), and wheel events reach only agents that turned mouse tracking on.
- `measure-split.ts` reads the cursor only when the terminal is outside a synchronized frame; otherwise a half-delivered frame from the flooding pane shows the cursor parked in that pane and the echo check never matches.
- In tests, `split()` needs a session fixture with both `worktree` and `branch` (or neither); `validateSession` rejects one without the other and the pane silently fails to attach.
- The reviewer's scratch tests are in the session scratchpad, outside the repo.

## New dependencies
- None.

## Concepts introduced
- **One connection per pane (`src/client/split.ts`):** the daemon tracks one attached agent per socket. Giving each pane its own socket needs no protocol change, and it isolates flow control: a pane flooding output fills only its own socket buffer, so its bytes never queue in front of the focused pane's echo.
- **Flood cap (`split-pane.ts`):** xterm parses a write for up to ~12 ms before yielding. Feeding each pane's mirror at most 8 KB per event-loop turn (and yielding with `setImmediate`, which runs after pending I/O) keeps any one pane from holding the loop, so typed keys and the focused echo get in between.
- **Focus-gated passthrough (`passthrough.ts`, split mode):** the bar's passthrough forwards an agent's mode changes and titles to your terminal. In a split only the focused pane's are forwarded; the rest are remembered and replayed by `restore()` when that pane takes focus. That is how background panes stay "cells only" (S15) without losing their state.

---

## Previous checkpoint (v0.3.2 worktree removal, retained)

## Checkpoint
Last commit: f0b61eb fix: count hidden index edits and agent-written ignore rules as loss
Roadmap step: v0.3.2 worktree removal (tasks 1–6) done
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at e54e575 after `git pull --ff-only` (already up to date). Baseline 131 files / 789 passed / 2 opt-in Keychain skips. Final 136 files / 839 passed / same 2 skips, twice in a row. Session: Claude Code, Opus 5.5.
Prompt vs code:
- v0.3.1 kept worktree metadata only on session records, and `x`/`/clean` deleted them. Worktrees already orphaned that way have no record, so under task 2 they can't be deleted. `/worktrees` lists them read-only as `✗ Not in AI Term's record`.
- v0.3.1 recorded neither the repo nor the base. Older records now find their repo through git, pinned by the folder hash, and use the checkout's current branch as base. The UI says so.
- `git worktree prune` is deliberately not run. `git worktree remove -- <missing dir>` already cleans up a folder deleted by hand (git 2.50.1). Prune would also drop git's records of other missing worktrees in that repo, which breaks "never touch anything outside that one worktree".
- The prompt was cut off after "a crafted"; the reviewers were also told to try crafted state.json records and socket requests.

## What works
- **Task 1, 97f03a1:** `inspectWorktree` in `git.ts`, read-only.
  - Counts changed, untracked and ignored files, plus commits on `ai/<slug>` not in the base. The base is the recorded branch, else the start commit when that branch was deleted, else the checkout's branch for older records.
  - Flags locked, missing, renamed/switched, checked-out-elsewhere and foreign worktrees.
  - Gives a fingerprint of exactly what it saw.
  - Temp-repo tests cover each case alone and combined, merged into base, base moved forward, deleted base and a folder deleted by hand.
- **Tasks 2–3, 323f8f6:**
  - Worktree records sit in state.json beside sessions and outlive the agent; v0.3.1 records are migrated as legacy.
  - `worktree-removal.ts` refuses with fixed texts: not recorded; outside `<home>/worktrees/<repo folder>/<slug>`; any symlink; repo not hashing to its folder; main checkout; not listed by git; not on its branch; locked; branch checked out elsewhere; running or waiting agent; busy with a resume.
  - Clean: `worktree remove --` then `branch -d --`. Loss: typed branch plus unchanged fingerprint, then `--force` and `-D`.
  - A failing step stops and names itself. Deletes share the start queue and exclude resumes.
- **Tasks 4–5, bd04d84:**
  - `x` removes the record, then asks one question: clean is k/Esc/⏎ keep, d delete; loss is listed plainly and needs the typed branch plus ⏎ (pastes ignored).
  - `/clean` keeps every worktree and counts them.
  - `/worktrees` popup: ↑↓, ⏎ opens the same question, Esc closes. It shows unrecorded leftovers.
- **Task 6:** README in bd04d84 (commands, keys, flow) and f0b61eb; architecture S14 and §12.3 with the exact argv, plus design.md, in f3e2fbd and f0b61eb.
- **Final review:** fresh-context security-reviewer and security-bounty-hunter (general-purpose agent) on e54e575..f3e2fbd, read-only, temp repos only. Both independently confirmed the same two bypasses. RED d452a96 → GREEN f0b61eb:
  - **HIGH:** `assume-unchanged`/`skip-worktree` hid edits from status, and from git's own plain remove, so one `d` deleted them. Now `ls-files -v` flags count as changed.
  - **MEDIUM:** `info/exclude`, a repo `core.excludesFile` or an uncommitted `.gitignore` (the agent can write all of them) could turn untracked work into "ignored". Now a path stays ignored only if `check-ignore -v` names a `.gitignore` tracked in the repo.
  - **LOW:** nested repos are now called out (`repos`).
  - **Theoretical:** a `.git` pointed at a sibling admin dir. Now the admin dir's `gitdir` must point back at `<path>/.git`.
  - Also: literal pathspecs for git, and a 300 s timeout for removal (the reviewer flagged that 10 s could cut a big removal part way through).
  - Not fixed, documented in §12.3 Known limits: the millisecond window between the recheck and git's own remove (same-user boundary, D35; git refused a symlink swap in the reviewer's test); legacy records pinned only by the 40-bit folder hash.

### Final check output (all exit 0)
```text
npm run build       ESM ⚡️ Build success in 19ms
npm run typecheck   > tsc --noEmit
npm run lint        ESLint: No issues found
npm test -- --reporter=dot (twice in a row)
 Test Files  136 passed (136)
      Tests  839 passed | 2 skipped (841)
   Duration  12.95s / 13.15s
coverage of the new code (worktree tests): 96.15% lines, 86.54% statements
```
Git argv in `src/daemon/git.ts` (the only git execFile); every positional ref and path follows `--`. The exceptions are option values: `-bai/<slug>` (git needs it before `--`), `--format=%(ahead-behind:<base>)` (a validated plain branch, hex commit or HEAD), and `check-ignore --stdin` (names on stdin, `./`-prefixed):
```text
rev-parse --path-format=absolute --show-toplevel [--git-common-dir --absolute-git-dir]
show --no-patch --format=%H --
worktree list --porcelain -z --
for-each-ref --format=%(refname) -- refs/heads/
for-each-ref --format=%(ahead-behind:<base>) -- refs/heads/ai/<slug>
status --porcelain=v1 -z --untracked-files=all --ignored=matching --
ls-files -v -z --          ls-files -z -- <.gitignore sources>
check-ignore -v -z --stdin
worktree add -bai/<slug> -- <path> <HEAD>
worktree remove -- <path>          branch -d -- ai/<slug>          (clean)
worktree remove --force -- <path>  branch -D -- ai/<slug>          (confirmed loss only)
```
Grep: `--force` and `-D` appear only at git.ts `forceRemoveWorktree`/`forceDeleteBranch`, called only in the loss branch of `deleteWorktree`. There is no `rm`/`fs.rm`/`rmdir` on a worktree path and no `prune`. S8: no `exec(`, `execSync(` or `shell: true`.

## What's next
- The next roadmap step (v0.3 splits). Nothing is left from v0.3.2 except the manual checks below.

## Manual checks
All need Yaniv, after an explicit daemon restart when it's safe (`node dist/cli/index.js daemon stop`, then `node dist/cli/index.js`), starting in ~/ai-term:
- Clean flow, needs Yaniv: start an agent in a repo, let it exit, then `x`. Expect `remove worktree and branch ai/<slug>? k keep · d delete`. Esc shows `worktree kept: <path>`. Repeat and press `d`: `✓ deleted worktree and branch …`. Afterwards `git worktree list` and `git branch` no longer show it, and `git status` in your checkout is unchanged.
- Loss flow, needs Yaniv: in an exited agent's worktree, `echo x > new.txt` and make one commit; `x` lists `1 untracked · 1 commit not in main`; `d` only types; typing the branch name and ⏎ deletes.
- `/worktrees`, needs Yaniv: lists v0.3.1 leftovers as `✗ Not in AI Term's record` and never offers to delete them; ↑↓/⏎/Esc work.
- `/clean`, needs Yaniv: the result line says `kept N worktrees · /worktrees reviews them`.
- Headless (ran): temp-repo git tests for every loss and refusal case; real SessionManager plus git delete paths; socket round-trip; homepage key flows replayed through a headless xterm.

## Gotchas
- `branch -d` compares with the original checkout's current branch. If that isn't the recorded base, a clean delete can stop at `Worktree removed; branch delete failed`; the record is dropped and the branch stays.
- A start that fails after `git worktree add` (subfolder checks) still leaves an unrecorded worktree, as in v0.3.1.
- A freed slug can be reused by a later start. An old exited session whose worktree was deleted then points at the new agent's folder, and resuming it would start there.
- The status/ls-files output cap is 16 MiB. A tree too large to list is refused (`Git check failed`), never deleted.
- An agent-enabled sparse checkout counts every skip-worktree entry as changed, so it always needs the typed confirmation.
- In tests, the homepage writes only changed cells; read the screen through `@xterm/headless` (see `tests/worktree-flow.test.ts`), not the byte stream.
- The reviewers' scratch scripts are in the session scratchpad, outside the repo.

## New dependencies
- None.

## Concepts introduced
- **Index flags (`src/daemon/git.ts`, `hiddenEntries`):** `git update-index --assume-unchanged`/`--skip-worktree` tell git to stop looking at a file, so `git status` and plain `git worktree remove` treat edits to it as absent. `git ls-files -v` reveals them (lowercase tag or `S`), and AI Term counts them as changed.
- **Ignore sources (`committedIgnores`):** a file can be ignored by `.gitignore`, `.git/info/exclude` or `core.excludesFile`. `git check-ignore -v` names the rule's source. Only a committed `.gitignore` is trusted, because the other sources live outside history and can be written by anything in the worktree.
- **Fingerprint confirmation (`worktree-removal.ts`):** the daemon hashes exactly what it showed you. A delete must send that hash back and is refused if anything changed in between, so a confirmation always matches the loss you actually saw.

---

## Previous checkpoint (v0.3.1 worktree starts, retained)

## Checkpoint
Last commit: 1269435 fix: preserve trailing spaces in git top-level paths
Roadmap step: v0.3.1 done (worktree starts, tasks 1–7) + extra task 8 done (open-homepage terminal activation).
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at 15e646e after git pull --ff-only (already up to date). Baseline: 126 files / 767 passed / 2 existing opt-in native Keychain skips. Final: 131 files / 789 passed / same 2 skips, twice consecutively. No other skips introduced.

## What works
- Tasks 1–2, 74a29b0: git process boundary, protocol/validators and allocation. Temp-repo tests cover no repo, unborn HEAD, spaces, branch collision, hostile titles and forty-character suffixes. Worktrees are outside the checkout, keyed by canonical repo path hash; private layout directories are 0700, owned and not symlinks. Only execFile/argv is used, with timeout, fixed errors and no inherited git routing. Hooks, fsmonitor and recursive submodules are disabled.
- Tasks 3–6, d01df57: new agent PTYs use their own branch/worktree and relative /cd subfolder; fallback starts in place with a card note. Shells and login sessions stay in place; resume reuses saved worktree metadata. Session persistence, cards, bar, debug ls, default-on settings and read-only start preview are wired. x and /clean retain worktree/branch and display kept paths. Tests use real temp git repos and inspect the actual PTY spawn cwd, original status/worktree list, reload and resume.
- Task 7, 27ac856: README commands/keys and architecture/design describe worktrees, preview, setting, retention and click activation.
- Extra task 8, d01df57: fixed TERM_PROGRAM → bundle map, validated click subscription, exact `/usr/bin/open -b <bundle>` argv with minimal PATH/timeout, own-terminal CSI 5 t, unknown-terminal note. Actual server selection/activation tested with a stub launcher. Helper, notifier banners/rate limits and closed-homepage launcher were untouched.
- Final fresh-context reviewers at high, serial and read-only temporary snapshot: typescript-reviewer and security-reviewer. Each confirmed finding has a failing test commit then fix:
  - MEDIUM, branch/tag short-ref ambiguity: RED 07f17e3 → GREEN 68a2034; use full refs/heads/ names so a same-name tag cannot hide branch collisions.
  - MEDIUM, trailing-space repo path confusion: RED 8721812 → GREEN 1269435; remove exactly git's final newline, preserving valid trailing spaces. Two sibling repos test wrong-repo HEAD/branch/worktree routing.
  - No other confirmed findings. 91cf4e6 adapts the removal-error test double to the new metadata read and clarifies a test title. An initial full-suite run exposed that fixture gap; final runs are green.

### Final check output (all exit 0)
```text
npm run typecheck
> tsc --noEmit
npm run lint
> eslint .
npm run build
ESM ⚡️ Build success in 19ms
npm test -- --reporter=dot (twice consecutively after final fix)
 Test Files  131 passed (131)
      Tests  789 passed | 2 skipped (791)
   Duration  12.04s / 11.38s
```
Baseline and some full runs emit the known node-pty EIO write diagnostic; no failed tests or unhandled test errors in final runs. The two native Keychain checks remain opt-in and were not run under the user limit.

S8 grep: no process exec(, execSync( or shell: true. Only existing RegExp .exec at mouse-rows.ts:56 and passthrough.ts:121. Sole production git execFile: git.ts:12. Git command argv audit:
```text
rev-parse --path-format=absolute --show-toplevel   (no positional refs/paths; cwd is execFile option)
rev-parse --is-inside-work-tree                    (no positional refs/paths)
show --no-patch --format=%H --                     (implicit HEAD)
worktree add -bai/<slug> -- <worktree path> <HEAD commit>
worktree list --porcelain -z --
for-each-ref --format=%(refname) -- refs/heads/
status --porcelain --untracked-files=normal --
```
Git requires -b's branch option value before --; `rev-parse --verify -- HEAD` and `check-ref-format --branch -- <branch>` were tried only in a temporary repo and Git rejects them. The generated branch alphabet is stricter than check-ref-format. Every positional ref/path in production follows --. `git diff --check 15e646e..HEAD` is clean. No prohibited paths/modules or npm dependencies were changed.

## What's next
- v0.3 worktree deletion / cleanup safety (Claude's next step); splits are not implemented here.
- Earlier carry-overs below remain; real UI/CLI checks listed here need Yaniv. No user daemon or session was stopped.

## Manual checks
All commands below start in ~/ai-term. Needs Yaniv; none require pasting credentials into chat.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after an explicit daemon restart when safe: /cd ~/ai-term, choose Codex, start two agents; each shows ai/codex and ai/codex-2 (or later unused suffixes), distinct cwd in its external tree, and branch on card/bar/debug ls. Observe each folder-trust prompt and report it.
- `cd ~/ai-term && git worktree list --porcelain && git status --short && git branch --show-current` — needs Yaniv after two starts: both external trees listed, main stays checked out, no agent-created files in your checkout.
- `cd ~/ai-term && node dist/cli/index.js debug ls` — needs Yaniv: both ai/ branches appear.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv: /cd an existing non-repo temp folder and start an agent; cwd stays there and card says worktree off: not a git repo.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv: /settings w toggles worktrees; /shell stays in /cd; x or /clean on finished worktree agents shows worktree kept: path, with tree/branch retained.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv in Terminal.app: move another app in front and click a live-agent notification; Terminal app activates and the correct ai window rises, agent selects, Enter attaches. Record CSI 5 t behavior; no Automation prompt expected.
- `cd ~/ai-term && printf '[5t'` — needs Yaniv in Terminal.app: direct raise-window probe (whether it brings this window forward).
- `cd ~/ai-term && TERM_PROGRAM=unknown node dist/cli/index.js` — needs Yaniv: click selects only, homepage says selected <name> from a notification.
- Headless temp-home checks: ran — git/names/security/fallback/cwd/collisions/reload/resume/retention; UI model/card/bar/start box/settings; exact activation argv and server/client click routing. Real official CLI trust prompts and Terminal.app focus were not observed: the user's no-logins/no-computer-use limits exclude those checks.

## Gotchas
- Prompt checkpoint matches code (15e646e / 767 tests). README/design still described branch as deferred and Automation as necessary; updated for this step. RTK.md is referenced but absent; no RTK command used. The Codex process in ai-term was this session (verified parent PID), not another editing agent. Reviewers only used a temp snapshot after implementation.
- Reasonable decisions: v0.3.1 label for this worktree-start slice; excluded login sessions as well as plain shells; resumes preserve saved worktree, even with setting off; absent setting means on; default names Codex/Claude Code produce codex/claude-code slugs. No name/branch editor was added. Preview rechecks at start; external races may change suffix or HEAD between preview and spawn.
- Empty/untracked selected subfolders are created in the new worktree without copying their local contents. Private layout/selected cwd dirs are 0700; ordinary checked-out project directories retain git's normal permissions behind the private root. Repo path controls are refused; space paths, including trailing spaces, work.
- Failed git allocation retains any partial directory/branch because this step never deletes. Its slug stays occupied for later starts. A symlinked layout is rejected before reading through it.
- Known CLI issues are documented, not solved: trust may be asked per folder; ignored dependency/local env files are absent. Temp-repo evidence confirms local ignored/untracked content is not included. Actual installed CLI trust behavior was not tested, and no real .env was read.
- Real ~/.ai-term, ~/.claude, ~/.codex, ~/.ssh, keychain and .env were untouched. Only project and temporary folders were written; network only git pull/push. Main changes/commits are the requested development work; product git never commits or changes the user's selected checkout.

## New dependencies
- None.

## Concepts introduced
- Linked worktree (`src/daemon/git.ts`): git creates another checkout with its own selected branch while sharing the repository's object store. AI Term starts it from a pinned HEAD commit, so local checkout edits do not silently enter the agent's task.
- Path identity and reservation (`src/daemon/worktrees.ts`): canonical top-level path hashes separate same-named repos, and a per-home promise queue serializes allocation from different socket clients. Existing branch names and filesystem allocations reserve a slug; no cleanup deletes user work.
- Launch Services activation (`src/daemon/terminal-activate.ts`, `src/shared/terminal-app.ts`): open -b activates a known terminal app without Apple Events. CSI 5 t requests that terminal to raise its particular client window; the terminal controls whether the request is supported.

---

## Previous checkpoint (v0.2 release, retained)

## Checkpoint
Last commit: 8e7b717 test: await the stopped homepage's done promise in the L2 case
Roadmap step: v0.2.7 done (notification click-through) + v0.2 release gate done. **v0.2 is closed** on automated evidence; the click/banner and Foundry re-add checks below are Yaniv's manual checks.
Branch: main. This handover is the last commit; its own hash is in git log.
Started at 70fdae4 after git pull --ff-only (already up to date). Baseline 118 files / 720 passed / 2 opt-in Keychain skips. Final 126 files / 767 passed / same 2 skips. Session: Claude Code, Opus 5.5.
Prompt vs code: B12 and B21 are not recorded anywhere in the repo (no Bugs section has them); the prompt's descriptions were used. architecture §12.1 said a click "brings your terminal forward", which needs Automation; not done, and §12.1 now says so.

## What works
- Part A, click-through (pushed before part B):
  - Helper (RED 307d59d → GREEN 7e20924). userInfo carries the session UUID. Delegates are set before app.run(), so a cold relaunch gets the click. Only the default action counts. It sends exactly `{"clicked":"<uuid>"}\n` to `<home>/run/click.sock` after these checks: home and run are 0700, owned and not symlinks (lstat); the socket is 0600 and owned; the peer uid matches. One-second bound, SIGPIPE off, fixed errors. `--click <uuid>` runs the same send. No click and no argv: exit 2 after 3 s.
  - Daemon (RED 21a6f4d → GREEN 5bb1f00). `click-receiver.ts` gives the click socket its own listener, bound through the shared `private-socket.ts` (extracted from server.ts, B6 temp-bind and rename). Limits: 128 bytes, one line, strict JSON, lowercase UUID, 1 s deadline, 4 connections. Unknown and finished agents are dropped with a log line; at most one action per second. A homepage that sent `clicks.subscribe` gets `session.select`; otherwise `terminal-launch.ts` handles D43. The `.command` is `/bin/sh` + the absolute node/ai paths + the UUID, written 0700 in a mkdtemp folder under the 0700 `launch/`. The daemon runs `execFile('/usr/bin/open',['-a','Terminal',file])`; the file deletes itself when it runs, with a 60 s fallback and a sweep at start.
  - Client (RED cb10ced → GREEN 5e5ddcc). The homepage selects only and never attaches; an unknown id is ignored. `ai --attach <uuid>` validates the UUID before connecting, then opens the homepage inside that agent; a gone or finished agent stays home with a note. README and architecture §12.1/§3/§4 are updated (1e93ef6).
- Part B, release gate. Three fresh-context reviewers (security-reviewer, security-bounty-hunter via general-purpose, silent-failure-hunter) worked on a read-only snapshot of 1e93ef6; a researcher read the official docs for B21. Every confirmed finding below has a failing test commit, then a fix commit:
  - **HIGH (bounty), source-mode code execution.** tsx read tsconfig.json from the agent's project folder, so a repo's `paths` could make the Claude status line or Codex notify (which runs outside Codex's sandbox) execute repo code. Reproduced (marker file). RED e3fcf00 → GREEN e636574: in source mode, `/usr/bin/env TSX_TSCONFIG_PATH=<repo>/tsconfig.json` is pinned in the status line, the notify argv and the `.command`; daemon auto-start uses the absolute loader with the repo as cwd. Built mode is unaffected.
  - **MEDIUM, B12.** RED de0475c → GREEN ac48a28, docs c0f8d17. Details below.
  - **MEDIUM-LOW (security), notification starvation.** One flapping agent could fill the global 10-a-minute budget. RED c66af09 → GREEN 1d6a662: each agent is also capped at 3 a minute.
  - **MEDIUM (silent-failure):**
    - M1: an orphaned Keychain entry wasn't named anywhere; the log now names the `provider:uuid` account.
    - M2: a failed request is logged with its kind and the fixed reason.
    - M4: the Claude status line being left off is logged.
    - M5 (part): click-route startup failures log a fixed cause.
    - LOW L2: only an older daemon's `DaemonRequestError` for `clicks.subscribe` is ignored.
    - RED 9be64de → GREEN 8ec5b01; test follow-up 8e7b717.
  - **LOW (bounty), S12/S15.** `Expect: <other>` got Node's 417, and cell text kept U+2028/2029. RED f4e603e → GREEN 38b9482.
  - **B21.** RED 438f87a → GREEN 6bf35dc (+ d6653a5 for the pinned list). Details below.
- **B12 outcome.** A Foundry Keychain entry is `{v:1,secret,endpoint,deployments}`. withSecret refuses a changed settings.json copy (`Foundry key details changed outside AI Term; add the key again`) or an unbound or legacy entry (`Foundry key must be added again to bind its endpoint`), with no trust on first use. `keys.test` probes only the bound values. A spawn refuses argv whose base_url or deployment isn't bound, which also closes a time-of-check/use gap between two reads.
- **B21 outcome** (code.claude.com/docs/en/env-vars and learn.chatgpt.com/docs/config-file/environment-variables, 2026-10-13). Each list is scrubbed for its own CLI only:
  - Claude: `CLAUDE_CODE_USE_ANTHROPIC_AWS`, `CLAUDE_CODE_USE_MANTLE`, the five `CLAUDE_CODE_SKIP_*_AUTH`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`, `CLAUDE_CODE_CLIENT_CERT/KEY/KEY_PASSPHRASE`.
  - Codex: `CODEX_ACCESS_TOKEN`, `OPENAI_FEDERATION_RULE_ID`, `OPENAI_IDENTITY_TOKEN_FILE`.
  - Not added: `ANTHROPIC_UNIX_SOCKET` and the `*_FILE_DESCRIPTOR` names are not on the official page. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` stay inherited per the §7.3 table. Generic AWS/GCP/proxy/CA variables stay too.

### Not fixed, with reasons
- **Silent M3** (a corrupt state.json stops the daemon with only "Daemon failed"): v0.1 startup path outside the v0.2 surface. Logging raw errors risks S5; it needs per-stage fixed reasons. Next step.
- **Silent M5 (rest).**
  - The helper can't report a failed click: a GUI app's stderr is lost, and a fallback launch would need ai's state.
  - A homepage attached to another agent counts as "open": the prompt says select, and the selection waits for Ctrl+E (documented).
  - No visible note on select: calmer option.
- **Silent L1:** `open` without -W can't see a helper failure. Already documented in v0.2.4b.
- **L3:** status bodies dropped by size, timeout or JSON get no log; a log line wouldn't restore the lost Stop.
- **L4:** stage-specific spawn logs; diagnostic only.
- **L5:** the importEnv rollback message hides the first reason.
- **L6:** a post-rename fsync failure in atomicWrite.
- **L7:** Foundry readiness on any 2xx; the user chose the host.
- L3–L7 are rare, low-impact or need a design. Listed for later.
- **Bounty LOW 3:** another macOS user can read agent argv via setuid `ps`, including the Codex usage credential (D52, pinned) and the first message (v0.1.6 argv delivery, pinned). Forging only inflates that session's usage. Reopening needs Yaniv.
- **Bounty LOW 6:** clicks always reach `~/.ai-term`; a daemon on another AI_TERM_HOME gets none. Documented in §12.1, and the wrong helper-env comment is corrected (32fd75a).
- **Security note:** a project's own `.claude/settings.json` `env` or Codex config can still reroute a key session after folder trust. This is the documented §7.3 Known limit; AI Term doesn't read CLI config.

### Final checks (all exit 0)
```text
npm run typecheck   > tsc --noEmit
npm run lint        > eslint .
npm run build       ESM ⚡️ Build success in 22ms
npm run build:notifier  Notifier built and ad-hoc signed: /Users/yanivsp/ai-term/build/notifier/AI Term.app
npm test -- --reporter=dot (3 consecutive runs, exit 0 each)
 Test Files  126 passed (126)
      Tests  767 passed | 2 skipped (769)
   Duration  11.00s / 10.83s / 10.92s
S8 grep: no exec( / execSync( / shell: true (only RegExp .exec in mouse-rows.ts:56, passthrough.ts:121)
sk- in src: only redaction/filters (log.ts, validate.ts, status-line.ts, usage-parse.ts) and "--ask-for-approval" in env.ts
permission flags outside src/daemon/env.ts: none
git diff --check 70fdae4..HEAD: clean
```
One earlier run exited 1 on an unhandled rejection from a new test (fixed in 8e7b717); the node-pty EBADF stderr is the known baseline line.

## What's next
- v0.2 is closed. Next roadmap step: v0.3 (splits + worktrees), only when Yaniv starts it.
- Carry-overs: silent-failure M3 startup reasons; L3–L7 above. The Terminal.app bar spike exit stays open (bar default off, nonblocking per Yaniv).

## Manual checks
- Rebuild and restart, needs Yaniv (stops running agents): `cd ~/ai-term && npm run build && npm run build:notifier && node dist/cli/index.js daemon stop && node dist/cli/index.js`
- Click with ai open, needs Yaniv: `cd ~/ai-term && node dist/cli/index.js`. Start two agents and select one; when the other's banner appears, click it. The other agent is selected, and Enter attaches.
- Click with ai closed, needs Yaniv: `cd ~/ai-term && node dist/cli/index.js`. Start an agent with a task, `/exit`, wait for its `done` banner and click it. A new Terminal window (or tab, per Terminal preferences) opens `ai` inside that agent; Ctrl+E goes home.
- Same without a banner, needs Yaniv: `cd ~/ai-term && node dist/cli/index.js debug ls` and copy an id, `/exit` any ai, then `cd ~/ai-term && "build/notifier/AI Term.app/Contents/MacOS/AITermNotifier" --click <id>`.
- Click for a removed agent, needs Yaniv: `cd ~/ai-term && "build/notifier/AI Term.app/Contents/MacOS/AITermNotifier" --click "$(uuidgen | tr A-Z a-z)" && tail -1 ~/.ai-term/logs/daemon.log`. Nothing opens; the log says `Notification click for unknown agent dropped`.
- Foundry key after B12, needs Yaniv: `cd ~/ai-term && node dist/cli/index.js`. In /settings, test (`t`) the existing Foundry key: it must refuse with `Foundry key must be added again to bind its endpoint`. Remove it (`x`), add it again (`a`), then `t`: deployments test as before.
- Ran headlessly: built-helper click payload and refusals (temp socket); daemon receiver, routing branches and the exact `.command` (stub launcher); homepage select and `--attach` (fake connection); B12/B21/source-mode/Expect cases. No banner was posted, no Terminal was opened, no real key or login was used.

## Gotchas
- Older Foundry keys refuse until re-added; that's deliberate (no trust on first use). Re-adding needs the key again, or an .env import.
- The Keychain item ACL trusts the node binary, so a same-user node process could still read entries (D35 boundary). B12 binds where a key goes; it doesn't hide the key from the user's own processes.
- The click socket is `~/.ai-term/run/click.sock`. The helper honours AI_TERM_HOME only for direct `--click` runs; real clicks always use `~/.ai-term`.
- `server.ts` now binds through `private-socket.ts`; `socketAnswers` is re-exported from server.ts for existing imports.
- In source mode, status commands depend on `/usr/bin/env` and the repo's tsconfig.json path passing the strict path alphabet; otherwise they're left off (logged).
- Review snapshot worktree was in the session scratchpad and has been removed; the unrelated `/private/tmp/ait-review` worktree from an earlier session is untouched.

## New dependencies
- None.

## Concepts introduced
- Cold-launch delivery (`native/notifier/Notifier.swift`): when a banner is clicked after its app exited, macOS relaunches the app without argv and delivers the click to whatever UNUserNotificationCenter delegate exists while launch finishes. That's why the delegate is set before `app.run()`, and why the route to the daemon must be a fixed path rather than an argument.
- Document launch (`src/daemon/terminal-launch.ts`): `open -a Terminal file.command` asks Launch Services to open a file with Terminal, as a double-click would. Terminal runs it in a new shell. No Apple Events and no Automation permission are involved, unlike AppleScript `do script`.
- Peer credentials (`native/notifier/Notifier.swift`, `getpeereid`): a Unix socket can report the uid of the process at the other end. The helper checks it's the user's own, in addition to the file's owner and mode.
- Secret binding (`src/daemon/keys.ts`): data that decides where a secret may go is stored inside the secret's own protected entry. A writable side file (settings.json) can then only be compared against it, never trusted.
- Module resolution pinning (`src/daemon/env.ts` `sourceTsconfig`): tsx resolves path aliases from the tsconfig.json of the current folder. Commands that run inside someone else's project pin their own tsconfig with `TSX_TSCONFIG_PATH`.

---
## Previous checkpoint (v0.2.6, retained)

## Checkpoint
Last commit: 7186961 docs: record measured product bar latency gate on this Mac
Roadmap step: v0.2.6 done — tasks 2–6 delivered; task 1 Terminal.app spike exit remains open by Yaniv's explicit nonblocking override.
Branch: main. This handover is the last commit; its own hash is in git log.
Continued at 112839b after git pull --ff-only (already up to date), preserving the existing 114-file / 672-passing baseline and two native Keychain opt-in skips. The original 540ebe8/670 checkpoint and later 3a0c949 prompt are historical; the checkout was further ahead. Session is Codex, not Claude Code/Opus.

## What works
- Task 2: d22de29 confirms existing shared Unicode 11 registration in daemon and attached client mirrors. Snapshot/cell tests agree on CJK, skin tones, ZWJ families and flags. No width dependency added; Unicode 11 already existed. This proves mirror agreement, not every terminal's grapheme shaping.
- Tasks 3–4: eda9fe0 / 0bbb675 / 6d7e778 implement opt-in client mirror/cell rendering and saved bar setting. Default **off** per latest instruction. Off preserves full-height raw passthrough and skips probing; on gives the daemon PTY rows−1, including resize. Failed DA1 probe (250 ms) falls back raw and logs once; one-row terminals also use raw. Early probe input survives fallback.
- Bar: surface tokens, glyph + status word, bold name, engine · model, other-session counts and ^E home. Counts drop first, then model; engine is retained when it fits (cc39ab5). Name/home are clipped or omitted when needed to keep the status word. No animation; unchanged bar bytes aren't emitted or rebuilt. Branch in the design was future worktrees data, absent in current code; explicitly deferred to v0.3 in design.md.
- Renderer: synchronized changed-cell output, same-tick idle draw after the public xterm user-input hint, one frame per 8 ms under floods, agent sync waits at most 150 ms (including a sync begin after a frame was already scheduled). Palette/default/RGB colors and accessible cell attributes stay intact. Cursor is restored after bar-only updates. All four mouse encodings shift rows, bar clicks/releases drop, arbitrary split reports and paste markers survive. Home keys are filtered before mouse rewriting; lone Escape retains its 30 ms ambiguity timeout.
- Exact spike query table covered: screen-relative queries answered by the mirror; CSI 18 t reports rows−1; input/title/cwd/theme/copy modes forward; OSC 52 reads, unsupported color/window queries, pixel mouse and inline images drop. Title-stack operations require enabled xterm windowOptions (covered). Reattach carries validated cursor shape, sanitized title, kitty root/push flags and theme reports.
- Task 5: README, design.md and architecture.md document the setting, shortcut, narrow layout, raw fallback and losses: OSC 8 targets (text stays), curly/dotted/colored underlines (plain underline stays), inline images. Product attach has no client-owned child: the daemon owns its PTY; client EOF detaches, cleanup never stops the agent. The spike's client child.onExit callback therefore has no equivalent in product attach. Unexpected input could still make vim quit; the unknown cause isn't declared fixed. Daemon-owned vim was observed staying alive and retaining text across attach/resize/Ctrl+E/reattach with bar both off and on.
- Task 6: RED 64fbf1d → GREEN ab66666. Signed helper --status reads getNotificationSettings without prompting, emits exactly allowed/denied/not-asked/unknown and exits 0. Real direct binary and open -W -n -g --stdout launches each returned **denied**, exit 0, for the same signed bundle on this Mac; direct identity parity confirmed. Native --status test ran, helper rebuilt and signature verified.
- Daemon execFile argv-only status reads: timeout 3 s, maxBuffer 128, fixed PATH; daemon start and once per minute timer, in-flight deduplication and cached state. Settings overlay explicitly requests refresh; ordinary settings reads used by attach return cached state immediately (b60d1bc RED → e3f4b80/2e40abd fix). No helper wait in session paths. Cached denied suppresses notification launches and logs once. Failed/unrecognized/unverified reads are unknown. All four wording states have stub-helper coverage; instructions wrap and scroll to selected rows in short settings (64ae92c RED → 0b33fc8 GREEN).
- Read-only performance-optimizer: confirmed input hint, identified deferred daemon parsing shared by raw/redraw and 8 ms busy-frame delay. No daemon typing changes made. Used actual separate daemon/socket/client/outer PTY measurement rather than claiming spike timing applies to product.

### Latency evidence (milliseconds, this Mac, bar forced on)
Method: scripts/measure-bar.ts, 120×40 outer PTY; raw agent 120×40, bar-on agent 120×39. Actual daemon SessionManager/DaemonServer and configured attach; temp HOME/cwd/AI_TERM_HOME, fixed echo/vim argv. 50 warmup + 500 measured keys per run, 15/20/25 ms gaps; raw/on order reversed in round 2. Output arrival timestamp validated against new body cell and cursor. Eight runs: 4,000 measured keys, zero timeouts. Artifact: docs/testing/v0.2.6-bar-latency.json; Node v26.3.0 darwin arm64.

| Program | Round | raw p95 | on p95 | delta | gate ≤2 ms |
|---|---:|---:|---:|---:|---|
| echo | 1 | 2.48 | 2.88 | +0.40 | pass |
| echo | 2 | 2.27 | 2.66 | +0.39 | pass |
| vim | 1 | 2.47 | 3.20 | +0.73 | pass |
| vim | 2 | 2.70 | 2.85 | +0.15 | pass |

These are headless PTY delivery measurements, not Terminal.app pixels or subjective feel. Gate does not cover input arriving just after a bar/output frame; the mandated 8 ms throttle can delay that busy path. Final review fixes affect Escape/probe fallback/kitty root restoration/narrow layout, not the quiet measured ASCII typing path.

### Final reviewer and checks
One fresh-context high typescript-reviewer pass through 7186961, read-only, no remaining material correctness/security/requirement findings. Initial review preflight caught a test mock type; fixed before review continued. Three real findings:
- Lone Escape buffered by mouse filter: feb6f14 RED → d1af1ac GREEN.
- Early typing discarded on failed probe: 99837eb RED → fcb4994 GREEN.
- Nonzero root kitty flags reset on reattach: 99837eb RED → fcb4994 GREEN (separate failing test in same commits).
Reviewer independently ran three targeted files / 44 passed, typecheck/lint exit 0, diff check clean. During implementation ran touched test files only; final suites include all files.

Final output tails, all exit 0:
```text
npm run typecheck
> tsc --noEmit
npm run lint
> eslint .
npm run build
ESM ⚡️ Build success in 18ms
npm test -- --reporter=dot (run 1)
Test Files 118 passed (118)
Tests 720 passed | 2 skipped (722)
Duration 10.26s
npm test -- --reporter=dot (run 2, immediately consecutive)
Test Files 118 passed (118)
Tests 720 passed | 2 skipped (722)
Duration 10.26s
```
Two skips are unchanged opt-in native Keychain tests; not enabled under the no-keychain constraint. Existing node-pty flood test still prints EIO/EBADF stderr as baseline did; both suites green. No additional tests skipped. git diff --check clean.

## What's next
- v0.2.6 tasks 2–6 complete. Next roadmap step: notification click-through, only in a new explicitly requested step.
- Yaniv runs the still-open Terminal.app trace later, then chooses when to enable bar and perform subjective feel/agent checks. No request to wait for trace; no block imposed.

## Manual checks
- Daemon-owned vim, typing, resize, Ctrl+E and retained text on reattach: ran headlessly with real isolated PTYs, both bar off/on. Product benchmark echo/vim: ran, gate pass. Cell/query/mouse/paste/settings/denied suppression: ran targeted tests. Native status and signed bundle checks: ran; no notification posted or permission prompted.
- Trace — needs Yaniv: `cd ~/ai-term && node scripts/diagnose-bar.mjs redraw --trace` (hands off; auto-quits surviving vim after 2.5 s).
- vim feel — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — /settings → bar on (h), /shell, `/usr/bin/vim -Nu NONE -i NONE -n`, type, Esc, :q.
- top — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — bar on, /shell, `/usr/bin/top`, q.
- Claude Code — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — bar on, select Claude Code, type and check permissions; no real login accessed in this session.
- Codex — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — bar on, select Codex, type and check permissions; Ctrl+C skips an update notice, never approve an update during this check.
- Paste — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — bar on, multiline paste including Ctrl+E remains text.
- Mouse — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — bar on, vim `:set mouse=a`, click/wheel, bar press/release ignored, Esc immediate after normal ambiguity delay.
- Resize — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — bar on, resize during vim/top; agent has rows−1.
- Ctrl+E — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — bar on, Ctrl+E home, agent keeps running, reattach retains text.
- Bar off — needs Yaniv: `cd ~/ai-term && node dist/cli/index.js` — /settings h → bar off; next attach raw/full-height.
- Notification parity repeat — ran; optional Yaniv command: `cd ~/ai-term && node --input-type=module -e 'import {execFileSync} from "node:child_process";import {mkdtempSync,readFileSync,rmSync} from "node:fs";import {tmpdir} from "node:os";import {join,resolve} from "node:path";const app=resolve("build/notifier/AI Term.app"),dir=mkdtempSync(join(tmpdir(),"ai-status-")),out=join(dir,"status");try{process.stdout.write("direct: "+execFileSync(join(app,"Contents/MacOS/AITermNotifier"),["--status"],{timeout:3000}));execFileSync("/usr/bin/open",["-W","-n","-g","--stdout",out,"-a",app,"--args","--status"],{timeout:3000});process.stdout.write("open: "+readFileSync(out,"utf8"));}finally{rmSync(dir,{recursive:true});}'`
- Benchmark repeat — ran: `cd ~/ai-term && node --import tsx scripts/measure-bar.ts 500` (temp daemon only; takes about two minutes; writes the measurement artifact).

## Gotchas
- Mac spike exit cause remains **unknown**. Successful probe, 4,430 vim bytes and clean exit 0 do not prove why vim quit. Prior exact replies/sizes/late focus/mouse/query headless replay did not reproduce it. Trace remains available and nonblocking per Yaniv; default bar off is deliberate.
- The product's daemon ownership avoids client EOF/child lifetime coupling, but cannot guarantee against a terminal report being interpreted as editor input. Never report task 1 fixed without a proven reproduction.
- The original design had `· branch`; current session data has no branch until worktrees v0.3. Current task specifies engine/model; docs now explicitly defer branch. Old spike report claims D39/2031 absent; current architecture and RESET_MODES already include them. Trust current code.
- No new npm dependency. No protected source/status/env/notifier-spike/review/config directories edited. No real ~/.ai-term touched or user daemon stopped. No ~/.claude, ~/.codex, ~/.ssh, keychain or .env access; no computer use or network except git pull/push. Review/performance agents read-only; root alone edited.
- Existing daemon processes need the new build before recognizing new settings/protocol fields. This session built code but did not restart Yaniv's real daemon.

## New dependencies
- None; @xterm/addon-unicode11 was already installed.

## Concepts introduced
- Client mirror (`src/client/session-screen.ts`): the agent's escape sequences update an in-memory terminal at its own rows−1 dimensions. The renderer draws its cells one row lower, so clears and cursor moves cannot overwrite AI Term's bar.
- Input fast path (`src/client/session-screen.ts`): xterm normally parses on a later timer; its public input('', true) hints that the next write is a typing echo. Idle rendering runs in that same tick; floods keep the 8 ms cap.
- Permission cache (`src/daemon/notification-permission.ts`): authorization is a separate fact from whether an app could launch. A bounded background read caches one fixed enum; session transitions only consult it and never wait on a process.
- Probe fallback (`src/client/terminal-probe.ts`): DA1 confirms that startup queries completed; missing optional colors/kitty support do not fail it. A timeout selects raw for this attach while preserving ordinary input, which keeps startup keystrokes from disappearing.

---
Previous handovers (historical; the checkpoint above supersedes their blocking/default statements):

## Checkpoint
Last commit: 1aa2d47 fix: restrict exit trace to terminal response formats (GREEN)
Roadmap step: v0.2.6 partial — BLOCKED at task 1 (hands-off Terminal.app exit trace pending)
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at 3a0c949 after git pull --ff-only (already up to date). Baseline: 114 files / 671 passed / two existing opt-in native Keychain skips (9.45 s).

## What works
- Existing product behavior remains unchanged. Read PROGRESS first, then current diagnostic/test, AGENTS, README, full bar spike report and spike startup/exit/query/mouse/renderer paths, design/tokens, architecture, current attach and daemon/shared width modules. No product changes or notifier changes.
- Yaniv supplied the first real Terminal.app diagnostic: OSC 10 `rgb:e6ce/e6ce/e6ce`, OSC 11 `rgb:213d/2743/33e7`, DA1 `CSI ?1;2c`; no extra probe bytes, kitty false, startup 6.745 ms, child 4430 bytes, child exit code 0/signal 0, reason program exited. This proves the probe succeeded, but does not show post-probe input, EOF, size or elapsed time to exit. The clean exit alone cannot name what made vim quit.
- Replayed those exact three replies through an outer node-pty driver on this Mac; unchanged spike and diagnostic both kept vim open, accepted typing and only quit after explicit Esc + :qa!. Also tested 20x4, 120x40 and 220x60 outer PTYs, plus late DA1, CPR, OSC colors, focus in/out and SGR mouse reports. None reproduced the spontaneous exit. These are headless startup checks, not pixel/feel verification or latency measurements.
- Read node-pty's macOS spawn and exit handling: it allocates its own PTY/termios and rows/cols; its macOS kqueue/waitpid callback is the source of the reported exit. The new trace checks whether the PID is still alive at that callback, without claiming this bookkeeping is the cause.
- Task 1 diagnostic expansion: RED c1d8a05 → GREEN c36b7ea.
  - `cd ~/ai-term && node scripts/diagnose-bar.mjs redraw --trace` is hands-off: do not type, paste, click or resize. If vim survives, it sends Esc + :qa! automatically after 2500 ms; autoQuitSent distinguishes that from an earlier exit.
  - One BAR_DIAGNOSTIC JSON line now includes PTY size; timestamped recognized post-probe terminal reports from outer stdin and child.write; omitted-byte counts; stdin end/close; child close/exit timing; input-read-error presence; whether the child PID was alive at node-pty's exit callback; kill signals; and vim's VimLeavePre values (dying, exiting, actual lines/columns, an allowlisted qa/q/other command category).
  - Captures at most 4096 bytes across both streams, in memory only, during the first second. Explicit response grammars only; ordinary or encoded typed keys are count-only. The optional VimLeavePre file is temporary, numeric/category-only, removed with the temp directory; no runtime keys, accounts, agents or real daemon used.
  - Headless exact-reply trace ran: 120x39 child PTY; no outer input after probe; mirror CPR/DA2 replies; autoQuitSent true; vimLeave dying 0/exiting 0/quitCommand qa; exit after 2513 ms; PID no longer alive at callback. No spontaneous exit.
- Fresh-context TypeScript reviewer at high: two real findings, both got failing-test and fix commits.
  - MEDIUM fragmented replies disappeared from the trace: RED 8fd05e8 (ESC[ / I split across reads loses focus reply) → GREEN df2de77 (bounded per-stream assembly recognizes it).
  - HIGH broad CSI grammar could print kitty-encoded typed letters; bare ZZ/ZQ also matched ordinary text: RED 0fc1167 (synthetic encoded text leaked) → GREEN 1aa2d47 (exact terminal response formats, no ordinary keys). No additional material findings.
- Final verification after all review fixes, all exit 0:
  - `npm run typecheck`: `> tsc --noEmit`
  - `npm run lint`: `> eslint .`
  - `npm run build`: `ESM ⚡️ Build success in 17ms`
  - Targeted tests/bar-diagnostic.test.ts: 2 passed.
  - `npm test -- --reporter=dot` twice consecutively: `Test Files 114 passed (114)` / `Tests 672 passed | 2 skipped (674)` / 9.82 s then 9.67 s.
  - Existing daemon-core flood test still emits node-pty EIO/EBADF stderr in baseline/final suites. Both exit 0. Unchanged native Keychain opt-in skips not enabled.
  - git diff --check clean. Only scripts/diagnose-bar.mjs, tests/bar-diagnostic.test.ts and this handover changed. No new dependencies; no protected paths or product code changed.

## What's next
- BLOCKER: no spontaneous-exit reproduction or proven cause. Yaniv explicitly authorized one more diagnostic run and requires stopping for its result.
- Need the single BAR_DIAGNOSTIC line from `cd ~/ai-term && node scripts/diagnose-bar.mjs redraw --trace` in Terminal.app, with no input during the run. The diagnostic automatically quits surviving vim after 2.5 s. Do not label task 1 fixed until its actual cause is reproduced and covered by a test.
- Then finish original tasks 2–5 and task 6 in order: shared width agreement in attached client mirror (table already exists), renderer/query/mouse/input fast path, themed bar/rows−1, saved bar on/off and failed-probe raw fallback, docs; notifier --status + verified identity or unknown fallback + asynchronous cached permission checks/settings/denied suppression.
- Performance agent and product latency gate remain unreached; echo/vim raw/redraw p95 not measured. No bar ships. Next roadmap step after v0.2.6 remains click-through notifications; not part of this session.

## Manual checks
- Exact Terminal.app replies, varied sizes and late query/focus/mouse reports: ran headlessly; no spontaneous exit. Trace, fragmented reports, encoded-key omission: ran with real outer PTYs.
- `cd ~/ai-term && node scripts/diagnose-bar.mjs redraw --trace` — needs Yaniv now: hands-off Terminal.app exit trace; it auto-quits. Reply with one BAR_DIAGNOSTIC line.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: /shell then vim, typing and :q.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: /shell then /usr/bin/top, q quits.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: Claude Code typing/permission checks; real login not run.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: Codex typing/permission checks; real login not run.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: multiline paste, Ctrl+E in pasted text stays text.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: vim mouse click/wheel, bar press/release ignored.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: resize preserves rows−1 PTY.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: Ctrl+E goes home, agent keeps running.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: /settings bar off, attach original raw path; setting not built.
- Notifier direct-launch authorization parity: not reached; no --status mode exists yet, no permission conclusion made.

## Gotchas
- No cause is established. Optional query absence, a clean PTY exit code, and 4430 drawn bytes do not show why vim exited. Do not invent a fix from these observations.
- Trace mode adds only an exit autocmd and controlled delayed quit to vim; spike files remain unchanged. It retains bounded input in memory to assemble replies but emits only known terminal reports. The user must use a hands-off run for this trace to distinguish unexpected input.
- Shared Unicode 11 table already exists in daemon/preview mirrors; confirm attached client integration later. D39 and 2031 reset already exist. RTK.md absent. These stale notes remain documented in preceding handover.
- No real ~/.ai-term, ~/.claude, ~/.codex, ~/.ssh, keychain or .env access; no computer use; no network except git pull/push; no user daemon stopped. No other editing agent spawned; reviewer read-only. Session is Codex, not Claude/Opus.
- Follow the original task-6 notifier override only after task 5, the 2 ms latency gate, two final quiet full suites, high fresh-context review and separate RED/GREEN commits for real findings.

## New dependencies
- None.

## Concepts introduced
- Vim exit hooks (`scripts/diagnose-bar.mjs`): VimLeavePre runs immediately before vim exits and exposes v:dying/v:exiting. Numeric values and a small allowlisted command category help distinguish a regular quit from abnormal termination without exporting the editor's contents or command history.
- Incremental report capture (`scripts/diagnose-bar.mjs`): a PTY data event can end halfway through a terminal response. The diagnostic assembles up to 4 KB per combined streams in memory and emits only explicit response formats, so read boundaries cannot hide a reply or turn an encoded key into recorded text.

---

## Previous checkpoint (3a0c949, retained)

## Checkpoint
Last commit: 5167cad fix: keep diagnostic vim writes in temporary cwd (GREEN)
Roadmap step: v0.2 bar + notification authorization partial — BLOCKED at task 1 (Terminal.app diagnostic pending)
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at 540ebe8 after git pull --ff-only (already up to date). Baseline: 113 files / 670 passed / two existing opt-in native Keychain skips (9.81 s).

## What works
- Existing v0.2 status, homepage cards and v0.2.4b notifications remain at the previous checkpoint. No product code changed.
- Task 1 investigation: read the entire bar spike report, startup probe and all exit paths, current attach, daemon mirror, shared width code, design and architecture §12.1/D39.
  - The probe asks OSC 10, OSC 11, kitty and DA1. It finishes on DA1 or after 250 ms. Lack of kitty/color answers does not itself exit the harness.
  - `bar spike: program exited` is emitted only after node-pty's child onExit event, which the spike currently ignores the numeric code/signal for. No cause for Yaniv's immediate exit is established.
  - Headless outer PTY driver on this Mac answered DA1 as Terminal.app (`CSI ?1;2c`) and ignored kitty and OSC 10/11. Both raw and redraw vim stayed alive after 1.8 s, accepted `TERMINAL_APP_DRIVER`, and quit only after the driver sent Esc + `:qa!`. Redraw probe facts: kitty false; startup 8.54 ms. These are startup checks, not latency measurements or Terminal.app visual verification.
- Safe pending diagnostic: `cd ~/ai-term && node scripts/diagnose-bar.mjs`.
  - Runs the unmodified spike in Terminal.app with disposable vim, temporary HOME and cwd, literal child env. It instruments node-pty's CommonJS spawn before tsx loads the harness, so it can print numeric child exit/code, byte count, bounded recognized terminal probe replies (hex), probe facts and reason in one `BAR_DIAGNOSTIC {...}` line.
  - No raw typed-input trace, agent, login, real daemon, real ~/.ai-term or notification access. Temporary state is removed at normal exit. No writes to spikes/ or docs/spikes/.
  - RED ee2492b: diagnostic absent, 1 failing PTY test. GREEN ee2ab0f: DA1-only startup, typing and actual vim exit recording pass. The test uses an outer headless screen to inspect positioned text.
- One requested fresh-context high TypeScript reviewer pass on the code diff; one MEDIUM finding, no additional correctness/security findings.
  - Finding: diagnostic child cwd was the checkout; vim's `file bar probe` plus `:w` could create a file there.
  - RED bd15053: actual vim `:pwd` shows the checkout rather than the temp directory, 1 failing test. GREEN 5167cad: cwd is temporary HOME; the same test passes.
- Final verification after the review fix, all exit 0:
  - `npm run typecheck`: `> tsc --noEmit`
  - `npm run lint`: `> eslint .`
  - `npm run build`: `ESM ⚡️ Build success in 17ms`
  - `npm test -- --reporter=dot` twice consecutively: `Test Files 114 passed (114)` / `Tests 671 passed | 2 skipped (673)` / 10.09 s then 9.70 s.
  - Existing daemon-core flood test emits node-pty EIO/EBADF stderr in the baseline and final suites; both suites exit 0. The two skips are the unchanged native Keychain opt-in cases; did not enable them.
  - `git diff --check` clean. Only scripts/diagnose-bar.mjs, tests/bar-diagnostic.test.ts and this handover changed. No new dependencies.

## What's next
- BLOCKER: Yaniv's Terminal.app immediate-redraw-vim exit was not reproduced. Need the single BAR_DIAGNOSTIC JSON line from `cd ~/ai-term && node scripts/diagnose-bar.mjs` in Terminal.app. If vim stays open, type a few characters, then Esc + `:qa!` + Enter. Task 1 explicitly requires waiting for this result before building. Do not guess the cause.
- After the diagnostic establishes a cause and its regression test, finish tasks 2–5: shared width agreement in the attached client, session-screen renderer/query/mouse/same-tick path, themed bar + rows−1 resizing, bar on/off default on + failed-probe raw fallback, README/design/architecture. Then task 6: notifier --status, verified direct-launch identity or unknown fallback, cached asynchronous daemon checks, settings states and denied suppression.
- Typing-performance agent and latency measurements were not reached. No redraw/raw echo/vim p95 table is measured for a product implementation. The 2 ms gate is unresolved; no bar ships from this session.
- After completion, the next roadmap step remains click-through notifications per the preceding checkpoint; do not start it within the current bar/authorization step.

## Manual checks
- DA1-only headless raw/redraw vim startup + typing + explicit quit: ran; no immediate exit. Diagnostic PTY test: ran; actual temp cwd and exit report verified.
- `cd ~/ai-term && node scripts/diagnose-bar.mjs` — needs Yaniv: Terminal.app startup evidence. Reply with BAR_DIAGNOSTIC line; no credentials or screenshot needed.
- `cd ~/ai-term && node scripts/diagnose-bar.mjs raw` — needs Yaniv only if comparison is useful after the first result.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: /shell then vim, typing and :q; current product is raw passthrough.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: /shell then /usr/bin/top, q quits.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: Claude Code typing and permission flow; real login checks not run.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: Codex typing and permission flow; real login checks not run.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: multiline paste, Ctrl+E inside paste stays text.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: vim mouse click/wheel, bar press/release ignored.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: resize attached terminal, PTY gets rows−1.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: Ctrl+E goes home and agent keeps running.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv after implementation: /settings bar off, attach uses original raw path (setting not built yet).
- Notification direct-launch authorization parity: not reached; status helper is not implemented, so there is no valid --status diagnostic yet. Do not claim permission is known.

## Gotchas
- Code disagrees with the spike's stale prerequisites: src/shared/unicode-width.ts already registers @xterm/addon-unicode11 in the daemon and preview mirrors. Existing unicode-width test covers CJK, skin tones, ZWJ families and flags with Unicode 11 semantics (separate emoji members, not grapheme shaping). Attached client mirror still needs integration and agreement tests; no dependency decision made yet.
- D39/§12.1 now exist and RESET_MODES already resets 2031. These spike findings are stale.
- design.md's bar includes `· branch`; the prompt excludes it, and worktrees start at v0.3. Follow the prompt for this step and document that decision when implementing.
- RTK.md is referenced by the supplied instructions but absent from the repository. No RTK command used.
- This session is Codex, not Claude Code/Opus; the requested high fresh-context TypeScript reviewer was used. No other repository editing agent was started.
- The pending diagnostic blocks subsequent tasks by explicit user requirement. Preserve the task-6 override allowing notifier changes only after task 5.
- No real ~/.ai-term, ~/.claude, ~/.codex, ~/.ssh, keychain or .env read; no computer use or network except git pull/push. No user daemon or sessions stopped.

## New dependencies
- None. The diagnostic reuses existing node-pty, tsx and @xterm/headless.

## Concepts introduced
- Diagnostic instrumentation (`scripts/diagnose-bar.mjs`): node-pty exposes a CommonJS module object, so a wrapper can observe its public spawn and exit events before loading the unchanged spike. This preserves the suspected startup path while recovering the exit evidence the spike discards.
- Terminal capability probe (`scripts/diagnose-bar.mjs`, existing spike): terminal reply bytes say which keyboard and color features the outer terminal implements. DA1 completes this spike's startup; absent optional replies mean unsupported/unknown capabilities, and are not proof of a program-exit cause.

---

## Previous checkpoint (v0.2.4b, retained for existing behavior and evidence)

## Checkpoint
Last commit: d8bffb0 fix: tolerant settings read for notifications, staged signed build swap, accept unassigned code points, compare waiting reasons (GREEN)
Roadmap step: v0.2.4b done (notifications without click-through; real banner, sound and Allow prompt need Yaniv)
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at 1b720c4 after git pull --ff-only (up to date). Baseline 109 files / 641 passed / two native Keychain skips. Final 113 files / 670 passed / same two skips, twice consecutively with the dot reporter (9.64 s, 9.44 s).

## What works
- Task 1, helper: RED 97fbc4e → GREEN 86f45a2 (+ lint fix 1420cc5).
  - `native/notifier/Notifier.swift` + `Info.plist` (bundle id `local.aiterm.notifier`, name "AI Term", LSUIElement). Argv only: `--session <UUID> --title --body` (+ `--check` = validate and exit). It requests alert+sound authorization and posts one notification: title, body, default sound, threadIdentifier = session id, no trigger. It exits 2 s later, and gives up after 120 s if the Allow prompt is never answered. No click socket, no time-sensitive/critical level.
  - No argv (a cold launch, e.g. after a click) or bad argv → `Invalid notifier arguments`, exit 2. The spike's argv cases are adapted (its click/socket/lifetime flags are now refused) and pass against the built app.
  - `npm run build:notifier` (`scripts/build-notifier.mjs`): xcode-select + `xcrun --find swiftc` check (fixed message and exit 1 without the toolchain). swiftc builds a staged bundle; it is ad-hoc signed and verified, then swapped in whole at `build/notifier/AI Term.app`.
- Task 2, policy (D42): RED 541e1fe → GREEN aae75d9. `src/daemon/notify-policy.ts`:
  - waiting (permission, question, turn failed) always; done only when no client is attached.
  - Same status and reason → no repeat; nothing for starting/running/exited/error; nothing when the setting is off.
  - The body is the name (cleaned, 60 code points max) plus `waiting: <reason>` or `done`.
- Task 3, sending: RED 0b9259b → GREEN cc685a6.
  - `SessionManager.applyStatus` emits `statusChanged(session, previous, next, attached)`, guarded so a listener can't break status.
  - `src/daemon/notifier.ts` reads the setting per notification and runs `execFile('/usr/bin/open', ['-n','-g','-a',app,'--args',…])` with `PATH=/usr/bin:/bin`, never awaited.
  - Failures are logged once per daemon run with fixed text. `engines.status` carries `notifier: ready | not built | launch failed`.
- Task 4, setting: RED 8b044b9 → GREEN 6441ab4. `notifications` (boolean, default on) in settings.json. `/settings` row `notifications: on|off (n)`, toggled by n or Enter. A fixed `notifications unavailable: helper not built · run npm run build:notifier` / `… helper failed to launch` line appears when needed.
- Task 5, docs: f5e3e7f. README covers `npm run build:notifier`, the notifications paragraph and the `/settings n` key row. architecture.md §12.1 says v0.2.4b ships without click-through and records the helper, launch, policy and failure details. design.md /settings DEFAULTS lists notifications.
- Reviews (fresh context, high): no critical/high findings from either reviewer. Each real finding got a failing test, then a fix.
  - Security: RED 9f59f69 → GREEN 59493ec.
    - MEDIUM: unbounded helper launches from a flapping Codex card, now capped at 1 per agent per 5 s and 10 a minute, logged once.
    - LOW: `launch failed` now clears after a success.
    - LOW: the helper now refuses separators, private use and surrogates.
    - Its fourth point (a denied or rejected helper is invisible behind `open`'s exit 0) is documented, not fixable from the daemon.
  - TypeScript: RED 66f8261 → GREEN d8bffb0.
    - MEDIUM: one malformed key entry made the notifier's settings read fail and silenced notifications; it now reads through a store that skips bad keys.
    - LOW: codesign ran after the swap; the whole bundle is now staged, signed and verified first.
    - LOW: refusing *unassigned* code points could silently drop names macOS tables don't know; now accepted (the daemon strips them anyway).
    - LOW: two failed turns with different error text re-notified; reasons are now compared.
    - Its design note, that a waiting alert inside an agent's 5 s gap is dropped, was kept as a trade-off.
- Final verification, all exit 0:
  - `npm run typecheck`: `> tsc --noEmit`
  - `npm run lint`: `> eslint .`
  - `npm run build`: `ESM ⚡️ Build success in 17ms`
  - `npm run build:notifier`: `Notifier built and ad-hoc signed: /Users/yanivsp/ai-term/build/notifier/AI Term.app`
  - `npx vitest run --reporter=dot` twice: `Test Files 113 passed (113)` / `Tests 670 passed | 2 skipped (672)` / 9.64 s and 9.44 s
  - The diff doesn't touch src/daemon/keys.ts, env.ts, spikes/, docs/spikes/, docs/reviews/, .claude/, .codex/ or .agents/. No secrets, raw hex or hidden bidi characters were added. `git diff --check` is clean. No new npm dependencies.

## What's next
- After Yaniv's replay confirms banner, name, icon and sound: click-through (callback socket via a fixed private path, select or attach the agent, D43 Terminal launch through a generated `.command`), as the next step. Not started.

## Manual checks
- Ran (headless): argv cases against the built helper (`--check` only, nothing posted), `open -n -g -a <helper> --args … --check` with a minimal env (exit 0; a missing app exits 1), policy, sender, setting and panel tests with stubs.
- `cd ~/ai-term && npm run build && npm run build:notifier && node dist/cli/index.js daemon stop && node dist/cli/index.js` — needs Yaniv: restarts the daemon (stops running agents) so it has the notifier.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv: start a Codex agent and make it ask for permission (e.g. a network command). Expect the Allow prompt for "AI Term" the first time. After Allow, a banner titled "AI Term" with `<name> · waiting: permission` and the default sound; record the icon.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv: let an agent finish while you stay inside it (attached) → no banner. Let one finish while you're on the homepage → `<name> · done` banner.
- `cd ~/ai-term && node dist/cli/index.js` — needs Yaniv: `/settings`, press n → `notifications: off`; trigger waiting → no banner; n again to turn it back on.
- If no banner: System Settings → Notifications → AI Term must allow alerts; the helper can't report a denial to the daemon.

## Gotchas
- The helper's permission belongs to `build/notifier/AI Term.app` in this checkout. Moving the repo means a new Allow prompt. The spike's `spikes/notifier/build/AI Term.app` has the same bundle id at another path.
- The launch method is `open -n -g -a` (Launch Services): `-n` because only a fresh instance gets `--args`; `-g` so the terminal keeps focus. `open` exits 0 once the app starts, so a helper denied permission still shows `ready`.
- One notification per agent per 5 s and 10 a minute in all; extras are dropped (homepage status still shows them) and logged once.
- Clicking a notification relaunches the helper with no argv; it exits 2. Nothing else happens yet.
- `tests/notifier-helper.test.ts` skips its helper-binary cases when the app isn't built; the path and swiftc-missing cases always run.
- The build-script review fix is tested by reading the script's step order; a real codesign failure can't be triggered without a fault-injection switch.
- No real ~/.ai-term, ~/.claude, ~/.codex auth, ~/.ssh, keychain, .env or agent sessions were accessed. No notification was posted. No network except git pull/push.

## New dependencies
- None (swiftc/codesign are system tools; the build is optional).

## Concepts introduced
- Launch Services launch (`src/daemon/notifier.ts`): `open -a` asks macOS to start an app the way the Dock would, so the app gets its own identity, permissions and parent (launchd). A plain child process of the daemon would be "responsible" to the daemon's terminal. `-n` forces a new instance so `--args` arrive, and `-g` keeps it in the background.
- Edge-triggered notifications (`src/daemon/notify-policy.ts`): notify on a *change* into a state, compared by what the user would be told (status plus reason), never on the state itself. Repeated hooks or repainted titles then can't produce repeated banners.
- Staged build swap (`scripts/build-notifier.mjs`): build and sign a complete copy aside, verify it, then rename it into the fixed path. Readers see either the old complete bundle or the new one, never a half-signed mix.
