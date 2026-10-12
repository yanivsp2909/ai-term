# Notifier spike

Only a spike: it never starts ai, touches its daemon, or opens Terminal. The generated bundle has the display name **AI Term**, id **local.aiterm.notifier**, LSUIElement, no custom icon, and an ad-hoc signature. macOS notification authorization belongs to that identity and persists outside the spike's temporary files; the scripts do not reset it.

Build and verify (no npm dependencies):

```sh
cd ~/ai-term && node spikes/notifier/build.mjs
cd ~/ai-term && node spikes/notifier/verify.mjs
cd ~/ai-term && node spikes/notifier/harness.mjs
```

At the harness prompt:

1. Type `open`, then Allow the **AI Term** alert/sound permission if asked. If authorization fails with code 1, enable AI Term in System Settings → Notifications, then retry; the helper never changes settings for you.
2. Click the banner body/default action (not dismiss). Expect an exact `{"clicked":"<UUID>"}` line. Record the banner's app name, icon and whether sound was heard.
3. Type `quit-helper`, then `direct`; click and compare. Direct mode launches Contents/MacOS; `open` uses `open -n -a` and Launch Services.
4. Type `stack`; inspect app grouping and same-agent versus different-agent threads.
5. Type `second`: it posts, waits three seconds and exits. Wait for `exit-after-post`, type `quit-helper` to stop any other spike instances, then click the delivered notification. Observe whether macOS relaunches AI Term and whether the callback is delivered. Do not relaunch manually before this click.
6. Type `quit` to stop only tracked spike helpers and remove its private temp directory. `probe` exercises the real UUID-only socket writer without notification APIs; it is not evidence of a notification click.

The harness binds a fresh `/private/tmp/ai-term-notifier-XXXXXX/click.sock` (directory 0700, socket 0600). It prints both UUIDs and tracks only helper PIDs at the exact built executable path. It refuses all callback bodies except one approved UUID. Direct helper argv must include `--session`, `--title`, `--body`, `--temp-dir`, `--socket`; optional `--lifetime` is 5–600 seconds (default 120), `--exit-after-post`, `--check`, `--probe-click`. Unknown/duplicate flags are rejected. Text limits count Unicode scalars and forbid controls/format characters.

Cold relaunch is deliberately unproved: only the session UUID is in notification userInfo; the socket comes from launch argv, and macOS may not preserve that argv on click. A no-args relaunch exits 2 with fixed text. The helper never recovers a route from defaults, files, arbitrary notification data or another daemon.

Evidence and proposed v0.2.4 design: `docs/spikes/v0.2-notifier.md`.
