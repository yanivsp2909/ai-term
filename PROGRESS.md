# PROGRESS

## Checkpoint
Last commit: fdeb385 spike: v0.2 status facts
Roadmap step: v0.1.5r done (review checkpoint before v0.1.6); v0.2 status spike done (facts only, no product code)
Branch: `review/v0.1.5r-checkpoint`, pushed to origin. It starts at 609d23b and does not contain `fd79920` (see Gotchas). Local `main` was not changed by this session after that commit appeared.
This handover is committed last; its own hash is in git log.

## What works
- Everything from v0.1.5 (see `docs/testing/v0.1.5-homepage.md`), plus seven review fixes, each committed as a failing test (RED) then the fix (GREEN):
  - The homepage reports `layout.previewSize` only while a preview is drawn. Compact and tiny windows no longer shrink detached sessions to 38×6 or 2×1, which used to destroy scrollback.
  - A signal death not requested by a stop is recorded as `error · signal N` (exitCode null). A user stop is still `exited`.
  - The stale-lock check also treats a foreign-user PID, or a PID that started more than 2 s after the lock was written (`/bin/ps -o etime=`), as stale. A ps that can't run never frees a lock.
  - A click in the preview no longer overwrites the clipboard; copying needs a real drag.
  - Sessions spawn with the user's umask (`0022` verified on a real daemon). Daemon files stay 0700/0600.
  - The control-queue cap is one full 4 MiB frame plus 2 MiB of events, so >2 MiB snapshots no longer disconnect clients. The hunter's real-homepage repro now attaches.
  - Detached terminal-query replies have a per-session budget (16 KiB burst, 4 KiB/s). The query-flood repro went from 995 MB RSS in 20 s to 157 MB after 25 s.
- Review report: `docs/reviews/2026-10-12-checkpoint-review.md`. 0 Critical, 0 High, 7 Medium fixed, 3 Medium as questions, 21 Low listed, plus the attack attempts that held.
- Final checks, run on the branch:
  - typecheck: exit 0 (`tsc --noEmit`)
  - lint: ESLint, no issues found
  - test: 134 passed across 22 files (was 125)
  - build: tsup "Build success"
  - coverage: 85.59% statements, 75.22% branches, 85.27% functions, 91.25% lines
  - `git diff --check` is clean; secret, S8 and S11 greps find nothing in `src/`.

## What's next
- v0.1.6 (agent spawning with `buildSpawnEnv`/`buildArgs`), after Yaniv answers Q1–Q3 in the review report. Q1 (socket trust) should be decided before agents run in session PTYs.
- Before v0.1.6 code, read review rows L1, L2, L3 and L6. The protocol, validator, loader, recipe and settings are still shell-only and will refuse agent sessions until they are widened (protocol first, then both sides).
- Yaniv: decide what to do with `fd79920` and local `main` (see Gotchas). Fast-forward `origin/main` to the review branch if you're happy with it.

## Manual checks
- The eight v0.1.5 physical-terminal checks are still listed in `docs/testing/v0.1.5-homepage.md`: needs Yaniv.
- Review-specific:
  - Real daemon with the user's umask: ran. A session printed `UMASK=0022`; `~/.ai-term`, `run/`, `state.json` and `daemon.log` stayed 0700/0600.
  - Real homepage with a 1,200-line truecolor session (2.28 MB snapshot): ran. `ai` stays up and Enter attaches; before the fix it exited at startup.
  - Query-flood RSS: ran. 157 MB after 25 s, against 995 MB after 20 s before the fix.
  - In a real 80×24 Terminal.app window, open `ai` with a session running `top`, then widen the window: needs Yaniv. Expected: `top` keeps its size while the window is compact and resizes once the preview appears.
  - Click once in the preview, then press ⌘V elsewhere: needs Yaniv. Expected: your earlier clipboard is unchanged.

## Gotchas
- **`fd79920` ("Add review agents, skills and commands for cloud sessions")** was committed to local `main` by Yaniv's setup during this run, between review commits. The follow-up prompt said not to push it, and history may not be rewritten. So the review commits were cherry-picked unchanged onto `review/v0.1.5r-checkpoint`, from 609d23b, and that branch was pushed instead.
  - Local `main` still has `fd79920` plus the original copies of the first ten review commits.
  - The work was done in a temporary worktree, `/tmp/ait-review`, with `node_modules` symlinked. `node_modules` was added to `.git/info/exclude` so the symlink stays untracked.
  - To reconcile, pick one: rebase `fd79920` onto the review branch, or reset local `main` to it and re-apply `fd79920`. Yaniv's call.
- `.claude/` and the new AGENTS.md line were never staged by this session.
- `acquireLock` is now async (`await acquireLock(path)`). It shells out only via `execFile('/bin/ps', [...])`.
- `PtyHost` now has `stopRequested`; `SessionManager` takes an optional 4th constructor argument, `childUmask`. v0.1.6 per-session recipes should keep passing both.
- Unix socket paths over 104 bytes fail with `listen EINVAL`. Test homes must be short (`/tmp/...`), not the scratchpad path.
- node-pty logs "Unhandled pty write error EIO" when writes are still queued as a PTY closes (seen in the flood test). It's noise from node-pty, not ours.

## New dependencies
- None.

## Concepts introduced
- **Token bucket** (`src/daemon/reply-budget.ts`): a budget that refills at a fixed rate up to a cap (the burst). Each reply spends its byte count and is dropped when the bucket is empty. This bounds memory for something we can't observe directly: node-pty's private write queue.
- **PID reuse** (`src/daemon/lock.ts`): process ids are recycled, so "a process with that pid is alive" doesn't prove it's our daemon. The lock file's mtime records when the daemon wrote it. A process that started after that moment can't be the writer, so the lock is stale.
- **umask inheritance** (`src/daemon/pty-host.ts`): the umask is per process and copied into every child at fork. The daemon wants 077 for its private files but must hand children the user's own mask, so it sets the mask just around the synchronous spawn and restores it right after.

## Spike: v0.2 status (2026-10-12)
- `docs/spikes/v0.2-status.md` answers the nine questions with an evidence level each. Scripts and the proposed `StatusEvent` JSON Schema are in `spikes/status/`.
- Live runs used: 2 of 5 Claude (`-p`) and 1 of 3 Codex (`exec`). No permission bypass and no hook-trust bypass. `~/.claude` and `~/.codex` were never read.
- Key facts:
  - Claude: `--settings` hooks merge with the user's hooks. `http` hooks reach 127.0.0.1 with an env-interpolated header, but not on SessionStart. Slow or failing hooks don't block past their timeout.
  - Claude: a 2xx JSON response is a hook decision, so the endpoint must answer 204 with an empty body. Context % exists only in statusLine, which a `--settings` statusLine would replace for the user.
  - Codex: `notify` covers turn-complete only, and fires in exec too. `-c` hooks need trust and were skipped. OSC 9 or BEL is sent on approval and turn-complete if forced (`osc9`, `always`). Context % comes from the OTel `conversation_starts.context_window` plus per-request token counts.
- Changes to the v0.2 plan are listed at the end of the spike doc. The biggest: S12's 64 KB body cap would drop real Claude events; waiting should come from `PermissionRequest`, not `Notification`; Codex needs no hooks endpoint; and any Codex `-c` needs `--no-daemon`, which affects v0.1.6 Foundry too.
- Manual: Tests A, B and C in the spike doc: needs Yaniv.
