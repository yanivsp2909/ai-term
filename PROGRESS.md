# PROGRESS

## Checkpoint
Last commit: eadd58c chore: add isolated Swift notifier spike and measurements
Roadmap step: v0.2.1 partial (D36 notifier spike built and measured; physical permission/display/click checks blocked)
Branch: main. This handover is the last commit; its own hash is in git log.
Started clean at 9bacfae, v0.1.10 done, 547 passed / two native Keychain opt-in skips. Final same 88 files / 547 passed / two skips, 8.14 s. No product code/tests, daemon/protocol, README/architecture, dependencies or protected configuration changes. v0.2.2 not started.

## What works
- `spikes/notifier/build.mjs` compiles a minimal AppKit/UserNotifications Swift 6 app without Xcode/SwiftPM, names it AI Term, bundle id local.aiterm.notifier, LSUIElement, signs ad-hoc and verifies strictly. No custom icon/provider branding. Generated binaries/cache ignored under spikes/notifier/build.
- Toolchain: Swift 6.3.2, macOS 26.5.1 arm64, codesign available. First compile ~4.34 s, warm ~1.01–1.58 s; sign 7–10 ms, verify 3–4 ms.
- `Notifier.swift`: argv-only UUID/text/path validation before APIs; alert+sound authorization, default sound/title/body/session userInfo/threadIdentifier, retained delegate, UUID-only Unix callback. Fixed failures, bounded lifetime and callback send; check/probe modes never request notifications.
- `harness.mjs`: owns one private random temp root/socket (0700/0600), launches direct or open -n -a with argv arrays, prints approved callback UUIDs, tracks only spike helper executables, and prepares same/different-thread, warm-click and post-exit click replays. No ai/daemon/Terminal launch or networking.
- `verify.mjs`: 26 argument/security boundaries plus exact UUID-only callback probe pass. A real probe took ~393 ms including startup. It is not notification click proof.
- Both real launch modes ran. Direct app launch observed ~47–53 ms; a warm open launch ~102 ms (another ~0.56 s including polling). Both eventually failed authorization: numeric UNErrorDomain code 1, SDK NotificationsNotAllowed; no banner was posted. The first direct authorization call remained pending until its own tracked helper was stopped. Later direct failures exit 1; open returning 0 only means launch acceptance.
- `docs/spikes/v0.2-notifier.md` lists every observation/unproved measurement, D43 comparison and v0.2.4 recommendation. Current verdict: no-go for claiming D36/D43 proved; permission/display/real click still need Yaniv. Stable retained helper via Launch Services is the provisional design; cold relaunch socket recovery is a separate gate.
- D43 read-only evidence: local Terminal document roles and do-script dictionary inspected. Recommend evaluating private generated .command + Launch Services first to avoid Automation consent, but new-window vs tab behavior and possible OS warnings are unproved. No .command or AppleScript launch built/executed.
- Requested security-reviewer: serial/read-only, no actionable findings. Independently strict-built/signed/verified, all 26 cases/probe passed, congested socket refused promptly (~7 ms), exit 1 and fixed stderr. Parent did no edits during review.
- Optional swift-reviewer produced no code verdict: mandatory SwiftPM preflight failed because this script-only spike has no Package.swift, and SwiftLint unavailable. This is a tooling mismatch; no project/dependency was added.
- Final checks, all exit 0:
  - `npm run typecheck`: `> tsc --noEmit`
  - `npm run lint`: `> eslint .`, no diagnostics
  - `npm test`: `Test Files 88 passed (88)` / `Tests 547 passed | 2 skipped (549)` / `Duration 8.14s`
  - `npm run build`: `ESM ⚡️ Build success in 18ms`
  - Coverage: statements 87.58%, branches 82.03%, functions 89.51%, lines 92.25%.
  - Node syntax checks, plist lint, codesign strict verify, spike verify.mjs and git diff --check pass.

## What's next
- Finish v0.2.1 with Yaniv's permission, banner name/icon/sound, warm/direct clicks, stacks/threads, Focus suppression and post-exit relaunch checks. Do not call it done from build, signing, socket probe or open's exit code.
- v0.2.2 is the next roadmap step only after Yaniv directs it; nothing from it started here.
- B12/B21 remain outside this spike and open for the Claude gate: Foundry endpoint authentication binding and current env scrub list review. v0.1.10 B13–B20 remain done; full evidence is in 9bacfae's checkpoint.
- Earlier v0.1 real-session, physical paste/copy and Notes checks still need Yaniv; this spike did not run official agent sessions or billing checks.

## Manual checks
- Build/sign/verify, 26 invalid/boundary argv cases, UUID-only probe, direct/open runtime launches, cleanup, congested socket refusal: ran with own temp roots; details above.
- Notification permission UI and settings inspection: attempted, UI tool returned cgWindowNotFound. No permission accepted/reset by the agent. Both launch modes reported NotificationsNotAllowed.
- Banner says AI Term / icon / heard default sound / live delegate callback / post-exit OS relaunch and callback / same-app grouping / Focus suppression: needs Yaniv; no notification posted here.
- `cd ~/ai-term && node spikes/notifier/build.mjs` — build helper.
- `cd ~/ai-term && node spikes/notifier/verify.mjs` — replay safe headless boundaries/probe.
- `cd ~/ai-term && node spikes/notifier/harness.mjs` — type open, Allow AI Term if asked (or enable it in System Settings → Notifications after code 1), click banner; expect clicked UUID and record name/icon/sound. Type quit-helper then direct and compare. Type stack to inspect grouping. Type second, wait for exit-after-post, type quit-helper, then click the second notification; record relaunch/callback separately. Type quit to clean up. Use one harness at a time.
- D43 .command vs AppleScript actual consent/new-window checks: needs Yaniv in a later explicitly authorized experiment; neither built.

## Gotchas
- Architecture has D36/D42/D43 but no requested §12.1 Notifications or D51 entry. User brief supplied missing details; pinned decisions not reopened. RTK.md remains referenced and absent.
- Current no-go is an authorization/observation limit, not proof macOS lacks the capability. Fallback requested by Yaniv is sound plus notification without click-through until v0.5, still contingent on permission/display proof; do not bypass Focus.
- Cold notification clicks may relaunch with no original argv. Strict helper then exits 2 and cannot recover its socket; only session UUID is in userInfo. Do not add route persistence/product wiring as a workaround in the spike. Recommend long-lived stable helper and separately reviewed restart routing for v0.2.4.
- `/private/tmp` is the macOS real temp path, but Foundation resolvingSymlinksInPath reports `/tmp`; canonical string equality wrongly rejected valid paths. Validation uses exact spike prefix/basename and lstat type/owner/modes instead. Reject nested, traversal and symlinked roots/sockets.
- OS notification identity/authorization can persist after deleting runtime files. Scripts never reset OS permissions, identifiers or notification state. Rebuilding ad-hoc changes the designated code; stable identity permission/rebuild behavior still needs observation.
- No custom icon means actual banner icon is unknown, not verified generic. Same app grouping also depends on OS preferences. Respect Do Not Disturb; homepage status remains authoritative.
- open exit 0 is not helper exit or post success; inspect helper stage diagnostics. Launch logs are private temp files. Callback writes only the UUID, never title/body/raw errors.
- Harness stops only tracked PIDs after checking the current executable path, then cleans only its own random root. The measurement harness and all tracked processes were closed; real ~/.ai-term and Yaniv's daemon untouched.
- Native Keychain skips remain opt-in; no native tests, real CLIs, keychain, .env, ~/.claude, ~/.codex, ~/.ssh or network used except explicit final git push. No other agent edited this repo; reviews were serial/read-only.

## New dependencies
- None. Uses installed swiftc/codesign, Apple frameworks and Node standard library only.

## Concepts introduced
- Bundle identity and ad-hoc signing (spikes/notifier/Info.plist, build.mjs): UserNotifications belongs to the app identity, not the Node launcher. A proper .app supplies its name/id and signed resources; ad-hoc signing has no developer team and proves local integrity, not distribution trust or notification delivery.
- Notification delegate lifetime (spikes/notifier/Notifier.swift): UserNotifications delivers presentation and response callbacks to a delegate while the app event loop runs. Keeping the delegate strongly alive enables warm clicks; it does not guarantee macOS preserves argv when relaunching a terminated helper.
- Private Unix callback (spikes/notifier/Notifier.swift, harness.mjs): the helper connects to a private local socket supplied by the harness and sends one validated UUID. It can prove transport safety without posting notifications, so that probe must not be mistaken for a click test.
- Evidence levels and authorization (docs/spikes/v0.2-notifier.md): successful compilation/signing and launching only establish those stages. A failed authorization prevents the display/sound/click measurements, which remain needs Yaniv instead of being inferred from API structure.
