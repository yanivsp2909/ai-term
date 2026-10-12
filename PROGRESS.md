# PROGRESS

## Checkpoint
Last commit: 11e9da6 docs: record This Mac formula D46 and accuracy measurements
Roadmap step: v0.1.8f done
Branch: main. This handover is committed last; its own hash is in git log.
Started at a5e2cb1 (coverage chore + B7 merged), clean. v0.1.6 closed after Yaniv's live check, per this session's prompt; v0.1.8a This Mac shipped. Prior handover's v0.1.6 partial label was stale.

## What works
- RAM now uses Activity Monitor's Memory Used formula: (Anonymous pages − Pages purgeable + Pages wired down + Pages occupied by compressor) × page size. It includes inactive anonymous memory omitted by the old active-pages formula. Uses existing vm_stat output, no extra sampling command.
- RAM real snapshot: App 7.3024 GB + Wired 3.4660 GB + Compressed 8.9355 GB = 19.7039 GB; old formula 18.2698 GB. Raw counters and immediate sysctl cross-check are in docs/testing/v0.1.8f-measurements.json.
- NET parser proved working by a 20 MB HTTPS download, curl 2,102,371 B/s over 9.513 s. Samples Rx 1.6–5.5 MB/s during the download, then 6.6–10.0 KB/s. Units now scale B/s, KB/s, MB/s with one decimal so light traffic stays visible.
- D46 pinned exactly: one-second sampling, only with subscribers. Same three absolute execFile argv calls; no overlaps, numeric fields only.
- Cost gate: own built daemon, 3 live shell sessions, 60.007 s subscribed, 0.27 CPU s = 0.449944% of one core (<1%). Without subscriber for 30.004 s: 0 stats events, 0 observed fork notifications.
- B8: slash menu hides notes and keeps its border intact; note returns after menu closes.
- Enter on exited/error agent shows `<name> has exited · x removes it`, with no attach or subscription change.
- All five fixes have RED/GREEN commits in docs/testing/v0.1.8f-accuracy.md. No new dependencies, no features outside this step.
- Final required output:
  - npm run typecheck: tsc --noEmit, exit 0
  - npm run lint: eslint ., exit 0 (no issues)
  - npm test: Test Files 40 passed (40); Tests 328 passed | 1 todo (329); Duration 4.90s
  - npm run build: ESM Build success in 12ms, exit 0
  - git diff --check: no output, exit 0
- Coverage verification: statements 88.87%, branches 82.34%, functions 88.08%, lines 94.27%. One pre-existing TODO retained (replaced socket path on Node close).
- Security grep: no exec(, execSync( or shell:true in src. sysstats execFile at line 123 uses absolute SAMPLE_COMMANDS paths and argv; ps requests exactly pid/ppid/rss/%cpu. Existing names/command-line exclusion tests pass.

## What's next
- v0.1.8b usage/cost remains the deferred next This Mac roadmap item; not started. v0.1.7 not started by this session.
- Yaniv's side-by-side Activity Monitor Memory/Network comparison, commands in docs/testing/v0.1.8f-accuracy.md.
- Existing socket replacement TODO and carried v0.2/emoji/bar checks remain outside this step.

## Manual checks
- Raw RAM counters and App/Wired/Compressed total versus vm_stat/sysctl: ran (numbers above). Activity Monitor simultaneous visual comparison: needs Yaniv.
- Real HTTPS download sampled network rates: ran; HTTP 200, 20 MB, positive rates with visible low-rate KB/s values.
- Daemon 1-second CPU with 3 live sessions: ran, 0.45% of one core. No-subscriber 30 s: ran, no samples/forks.
- B8 note/menu and finished-session Enter: ran in cell-renderer/headless tests. Physical terminal feel: needs Yaniv.
- Exact isolated manual command starts `cd ~/ai-term`, then `open -a 'Activity Monitor'`, create a /tmp home, and run `AI_TERM_HOME="$AITERM_STATS_HOME" node dist/cli/index.js`. Full setup/cleanup commands in docs/testing/v0.1.8f-accuracy.md; don't stop the real daemon.

## Gotchas
- Initial baseline consistently failed the coverage chore input fixture with kill EPERM during cleanup. Test-only 651cc0f waits for the exited fixture; production stop handling unchanged. Then baseline 324 passed / 1 todo.
- Yaniv's earlier RAM parts 7.55 + 3.33 + 9.75 sum to 20.63 GB, not 21.59 GB. Fresh same-moment readings are needed. This run did not see Activity Monitor itself.
- Sequential vm_stat/sysctl snapshots differ by 950 pages (~14.84 MiB) because allocation continues. Product computes all RAM parts from one vm_stat snapshot.
- Network measures all non-loopback interfaces; VPN traffic still counts tunnel and physical bytes separately. Parser unchanged because real download established correct counters.
- First sample is baseline, so initial stats arrive about 1 s after subscription. Long samples skip ticks rather than stack.
- CPU gate uses cumulative ps time divided by elapsed wall time; ps %cpu is smoothed/rounded and much lower here. Sampler-command/harness CPU excluded, same v0.1.8a daemon gate.
- kqueue fork notifications may coalesce; subscribed detector observed forks, unsubscribed observed zero. Unit tests independently prove no runner calls with no subscribers.
- Running daemon keeps old code. Test with a fresh /tmp AI_TERM_HOME; do not restart Yaniv's daemon for this check.
- Only own temporary daemons/processes stopped. Real ~/.ai-term, credentials, env.ts, spikes, docs/spikes, docs/reviews, .claude untouched.
- Code/security diff reviewed directly; no concurrent agents used, honoring AGENTS.md.

## New dependencies
- None.

## Concepts introduced
- Anonymous vs. active memory (src/daemon/sysstats.ts): anonymous pages represent app allocations whether active or inactive. Active pages are a queue, so they omit inactive app memory and aren't App Memory; subtract purgeable and add wired/physical compressed pages for Memory Used.
- Scaled rates (src/client/tui/this-mac.ts): cumulative network bytes become bytes per elapsed second. The display chooses decimal B, KB or MB so formatting does not turn a real light rate into 0.0 MB/s.
- Popup ownership (src/client/tui/layout.ts): a popup owns the cells it covers. Hiding the note while the menu is open keeps its border readable and restores the note without changing its state.
