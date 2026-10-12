# PROGRESS

## Checkpoint
Last commit: 6208948 docs: record successful final suite rerun and baseline flake
Roadmap step: v0.1.8d done
Branch: main. This handover is the last commit; its own hash is in git log.
Started at clean 06f218a, v0.1.8c command registry/menu/effort/mode/resume/shell/clean/help already shipped. Baseline rerun 455 passed / 2 native Keychain opt-in skips / 1 existing TODO, 68 files. Final 477 passed / same skips/TODO, 73 files. /copy and c delivered; no v0.1.9 work.

## What works
- Protocol-first sessions.text accepts only a validated session UUID and returns {copy:{sessionId,text,truncated}} capped at 5 MiB UTF-8. Underlying control chunks ≤1 MiB echo one request id with more; client assembles ≤6 chunks/≤5 MiB, checks identity/metadata/controls and rejects malformed transfers. Existing 4 MiB frame cap unchanged. RED5914d5e → GREEN29b0f8e; socket REDbd92f70 → GREEN3c38f5e; malformed transfer RED9584a34 → GREEN1f401c9.
- Mirror cells supply active scrollback+screen only, never raw PTY bytes. Softwrapped rows join, internal explicit spaces remain, trailing logical spaces and empty tail drop, C0/C1/escape payloads absent. Oldest bytes cut at complete UTF-8 boundary above cap. Running/exited agents/shells work while mirror remains in memory. RED8184ff3 → GREEN8b6debc; reviewer wide CJK/emoji padding regression REDb2f08ab → GREENef609ca.
- /copy in registry and empty-field c use selected session's text through existing clipboard path (pbcopy absolute execFile/empty argv/stdin). c types normally with nonempty field. Notes show copied N lines/name/cap warning, no-selection select an agent first, fixed clipboard unavailable error. Failures log fixed Clipboard copy failed via log.ts, no text/error detail. REDd4d0a2e → GREEN18e3575; fixed error Logger proof0415501.
- Copy target captured at action acceptance even if earlier UI request queues it and arrows change selection. Quit during pending export never invokes clipboard. Reviewer RED87bd549/3e52da3 → GREEN09a12d1; runtime shutdown regression included.
- Canary shell prints AITERMCANARY: copied response includes it, recursive scan of test-home regular files including state/logs finds none. OSC52/title payloads not copied; no raw escapes. Large quote/backslash/CJK response, unknown/invalid UUID, malformed chunks, fake clipboard success/failure and isolation tests pass.
- README /copy/c and help/key registry updated; architecture protocol/S15 and design notes describe explicit copy, runtime-only mirror and cap. Docs131977f; full evidence/review/commit mapping in docs/testing/v0.1.8d-copy.md.
- Requested typescript-reviewer final approval on 06f218a..09a12d1: no remaining actionable findings; 22 copy tests pass. Primary code edits paused during review. Both initial MEDIUM findings fixed/tested; reviewer made no edits and used no real clipboard/home/network.
- Final checks all exit0: typecheck tsc --noEmit, lint eslint ., 73 files / 477 passed / 2 skipped / 1 TODO / 10.95s, build success19ms. Coverage statements87.72%, branches82.07%, functions89.3%, lines94.82%. exec/execSync/shell:true grep no matches; protected paths and full diff whitespace clean.

## What's next
- Yaniv performs actual c → paste into Notes and /copy manual check when safe to restart. Commands in docs/testing/v0.1.8d-copy.md. Real clipboard never touched in tests.
- v0.1.9 next, not started. Prior real usage export/billing and command resume checks still need Yaniv. Existing socket-replacement TODO and unrelated oversized usage-body test flake remain.

## Manual checks
- Mirror logical lines, wide wraps/spaces, ANSI/OSC dropping, 5 MiB UTF-8 cap, active alternate screen: ran in tests.
- Own running/exited /bin/sh canary session via Unix socket, text present in response and absent every test-home regular file: ran. Own PTY stopped and temporary root removed; no real daemon touched.
- Fake copier /copy/c, notes/no-selection/failure, Logger fixed-text failure, stable queued target and quitting mid-copy: ran. No real clipboard access.
- Physical clipboard/Notes: needs Yaniv. cd ~/ai-term && ai daemon stop && ai (restart stops existing agents; use when acceptable). Start/select agent with output after restart, empty field c, expect copied N lines/name note. cd ~/ai-term && open -a Notes; Cmd+V and inspect text. Repeat /copy; nonempty field c types normally.

## Gotchas
- Initial baseline and one final plain-suite run hit existing usage-receiver oversized-body write ECONNRESET. Targeted baseline13/13 and unchanged full reruns passed; final coverage/full plain run pass. No usage code/test modification; flake explicitly recorded, do not claim deterministic usage guard testing.
- Existing frame cap4MiB cannot carry up to5MiB text+JSON in one frame. sessions.text one logical request uses bounded UTF-8 chunks, then returns joined text; no frame limit bump or raw output event. Cap measured bytes, not characters. At most six1MiB chunks allow codepoint-boundary rounding.
- Copy reads active mirror buffer. Normal has 5000 scrollback rows plus screen; alternate screen contains only its active cells. Daemon restart restores records but not terminal output, so old mirrors copy empty text. Never reconstruct from raw bytes/CLI files/disk.
- Truncation keeps newest complete codepoints and may begin mid-oldest logical line; UI prescribed warning says oldest lines cut at5MB. Wide-glyph wrap padding removed only for empty last cell before wrapped2-cell glyph, preserving explicitly written spaces.
- Clipboard failure fixed text only; copied canary/content intentionally unredacted because explicit user copy. No transcript stored/logged or drawn in note. Clipboard text goes stdin, not argv. Test failure logger injected/temporary home only.
- First queued-target test used an unregistered resize event and failed before behavior; fixture corrected to actual previewResized event, reproduced wrong target RED, then fix passed. History kept, no rewrite.
- No dependencies, env.ts/keys.ts/usage code/spikes/docs/spikes/docs/reviews/.claude/package manifests/lock unchanged. Real ~/.ai-term/CLI credential dirs/keychain/.env untouched; no real Claude/Codex sessions. No network except explicitly required final origin push.
- Named TypeScript reviewer was the only agent delegated, explicitly requested; read-only review while parent paused writes satisfies repo serial-work rule.

## New dependencies
- None. Existing xterm mirror, socket protocol, pbcopy wrapper and vitest suffice.

## Concepts introduced
- Cell-derived transcript (src/daemon/mirror.ts): a terminal parses raw bytes into displayed cells, so copying cells preserves visible output while dropping escape commands and hidden OSC payloads. Soft wraps join without adding a newline; wide-character padding needs special handling so copied text matches its logical line.
- Bounded response chunks (src/shared/protocol.ts and src/client/connection.ts): the transcript cap is larger than a protocol frame. One request therefore returns small UTF-8 chunks with matching identity/metadata; the client validates and joins them before the clipboard sees any text.
- Captured action target (src/client/tui/homepage.ts): queued UI work can run after selection changes. Copy stores the selected record when the key is accepted, so it copies that agent even if a later arrow moves the preview.
