# AI Term: Architecture

Covers v0.1 in full and the later versions in outline. Each later version gets its full section before its first step starts.

**Core principle.** AI Term is the `ai` command (a TUI) plus a background daemon that owns every session.
- **Account logins** run the official CLIs, Claude Code and Codex, untouched, in a real PTY. AI Term never reimplements them, and never reads, copies or proxies their logins. If something works in Terminal.app, it works inside an AI Term session.
- **API keys** run AI Term's own agent from v0.4. Until then they also run on the official CLIs.

---

## 1. The pieces

```
 your terminal (Terminal.app, Ghostty, iTerm2… later the AI Term app)
 ┌──────────────────────────────┐
 │  ai   (client: TUI)          │  homepage, overlays, attach to a session
 └──────────────┬───────────────┘
                │ Unix socket ~/.ai-term/run/daemon.sock (framed messages)
 ┌──────────────▼───────────────┐
 │  ai daemon   (one per user)  │  sessions, PTYs, screen mirrors, keys,
 │                              │  usage, system stats, state on disk
 └──┬─────────────┬─────────────┘
    │ node-pty    │ node-pty
  claude        codex  …        each agent in its own PTY
```

> **Concept: daemon.** A program that keeps running in the background with no window of its own. The daemon owns the agents, so closing `ai` (or the whole terminal) doesn't kill them. Running `ai` again reconnects to the same daemon and shows the same agents. tmux works the same way. Code: `src/daemon/`.

> **Concept: PTY.** A pseudo-terminal: a kernel device pair that makes a program believe it's talking to a real terminal. The program gets a size (cols × rows), can switch to raw mode, and receives Ctrl+C as SIGINT. `node-pty` creates one and starts the agent attached to it. The daemon writes keystrokes in and reads raw bytes (text plus escape codes) out. Without a PTY, Claude Code and Codex refuse to run or render garbage. Code: `src/daemon/pty-host.ts`.

> **Concept: headless terminal (screen mirror).** `@xterm/headless` is xterm.js without a display. It reads the same bytes the agent prints and keeps the screen in memory as a grid of cells. The daemon keeps one per session, called the mirror. It lets the daemon redraw a session for a client that just attached, and lets the homepage show a live preview. Code: `src/daemon/mirror.ts`.

> **Concept: Unix socket.** A local "network connection" that is a file on disk (`~/.ai-term/run/daemon.sock`). Only processes that can open the file can connect, and we make the file readable only by you. No TCP port, nothing reachable from the network or from a web page. Code: `src/daemon/server.ts`, `src/client/connection.ts`.

**One package, one binary.** Running `ai` with no arguments opens the TUI. `ai daemon` is the internal entry point the client uses to start the daemon. Other subcommands: `ai doctor` (environment checks), `ai daemon stop`, `ai --version`.

**Runtime:** Node.js ≥ 22, TypeScript strict. Bun is not used, because node-pty is a Node native module (D25, verified in v0.1.1).

**node-pty version:** pinned to exactly `1.2.0-beta.15`, with its install scripts approved in `package.json` (npm 11 doesn't run a package's install scripts unless the project approves them). 1.1.0 ships its macOS `spawn-helper` without the execute bit, so every spawn fails with `posix_spawnp failed`, even with its scripts approved. Never a hand-written `chmod`. Move to the stable 1.2.x once it's released.

**TUI renderer:** our own cell renderer (D26), chosen by the v0.1.2 spike.
- **How it works:** the screen is a grid of cells (character, colors, bold), diffed against the previous frame. Only changed cells are written, wrapped in synchronized-output escapes (`\e[?2026h` … `\e[?2026l`) so the terminal paints each frame at once.
- **Why:** with a live preview, Ink used 46% CPU and 17.6 ms keystroke latency (p95). The grid used 14% and 3.1 ms (`docs/spikes/v0.1-tui-renderer.md`).

---

## 2. Repo layout

```
ai-term/
  AGENTS.md  CLAUDE.md  README.md  PROGRESS.md
  docs/
    architecture.md   design.md   design/tokens.json
    spikes/                       # one file per spike step, findings + commands run
  src/
    cli/index.ts                  # `ai` entry: argv → tui | daemon | doctor | version
    shared/
      protocol.ts                 # every message type on the socket (section 4). Change this first.
      models.ts                   # SessionInfo, KeyView, UsageSummary, …
      validate.ts                 # pure validators: model ids, deployment names, paths, branch names
      paths.ts                    # ~/.ai-term layout, created with the right modes
    daemon/
      main.ts                     # startup, single-instance lock, shutdown
      server.ts                   # socket server, framing, per-connection state, input validation
      session-manager.ts          # session records, lifecycle, the only caller of pty-host
      pty-host.ts                 # node-pty spawn/write/resize/kill, flow control
      mirror.ts                   # @xterm/headless + serialize addon per session
      env.ts                      # buildSpawnEnv, buildArgs, resolveExecutable (pure + tested)
      engines.ts                  # claude/codex: installed? version? logged in?
      keys.ts                     # OS keychain via @napi-rs/keyring + key metadata
      providers/foundry.ts        # deployment test requests
      usage.ts                    # usage events in, today/week/month out, budget
      sysstats.ts                 # CPU / RAM / network + per-session process trees
      store.ts                    # atomic JSON read/write with modes
      log.ts                      # logger with redaction
    client/
      connection.ts               # connect, auto-start daemon, hello handshake
      attach.ts                   # full-screen passthrough to a session + home key
      tui/                        # homepage, overlays (layout per docs/design.md)
  tests/                          # vitest
```

---

## 3. Daemon lifecycle and files

**Start.** `ai` tries to connect to the socket. If that fails, it starts `process.execPath <path to cli> daemon`:
- detached, with stdin ignored and stdout/stderr going to `~/.ai-term/logs/daemon.log`, then `unref()`
- the client then retries the connection for up to 3 s

The daemon takes an exclusive lock (`run/daemon.pid`, created with `O_EXCL`) so only one daemon runs. A stale pid is checked with `process.kill(pid, 0)`; a pid that belongs to another user, or to a process that started more than 2 s after the lock was written (`ps -o etime=`, pid reuse after a crash and reboot), is stale too.

**Handshake.**
1. The client sends `hello {protocol, version}`.
2. On a protocol mismatch the daemon answers `helloMismatch`.
3. The client then shows "AI Term was updated. Restart the background service? (N agents running will be stopped)". It never restarts silently.

**Stop.** `ai daemon stop` stops all agents (SIGTERM, then SIGKILL after 3 s) and exits. With zero *live* sessions and zero clients for 10 minutes, the daemon exits on its own. Exited records don't keep it alive.

**Daemon restart.** Sessions whose process is gone keep their record with status `exited` and the detail "background service restarted". The scrollback is lost; the record stays until you remove it.

**Files.** `~/.ai-term/` is mode 0700. The daemon refuses to start if it is a symlink or owned by another user.

| Path | Contents | Mode |
|---|---|---|
| `settings.json` | theme, default model/engine/folder, permission default (always `ask`), preview size, budget, key **metadata** (id, provider, label, last4, endpoint, deployments, last test result) | 0600 |
| `state.json` | session records (section 5) | 0600 |
| `usage/YYYY-MM.jsonl` | one usage event per line (section 9) | 0600 |
| `run/` | `daemon.sock` (0600), `daemon.pid` | 0700 |
| `logs/daemon.log` | redacted log, rotated at 5 MB; 3 files in total (`daemon.log`, `.1`, `.2`) | 0600 |
| `sessions/<id>/` | per-session generated files (hook settings from v0.2), deleted with the session | 0700 |

Writes are atomic: write to a temp file in the same folder, `fsync`, `rename`.

**Keys are never in any of these files.** They live in the OS keychain (section 8).

---

## 4. Protocol (client ⇄ daemon)

Frames on the socket: `uint32 BE length` + `uint8 type` + payload. The length counts the type byte plus the payload, not itself. Max frame 4 MiB; a bigger or malformed frame closes that connection.

**Ids:**
- `id` on a control message is only the request/response correlation id.
- The session a message targets is always `sessionId`.

| Type | Payload |
|---|---|
| `0x01` control | UTF-8 JSON: `{id?, kind, ...}`. Requests carry `id`; responses echo it; events have no `id` |
| `0x02` output | 36-byte ASCII session id + raw PTY bytes (daemon → client) |
| `0x03` input | 36-byte ASCII session id + raw bytes (client → daemon, attached sessions only) |

The daemon validates every control message at runtime with hand-written validators in `src/shared/validate.ts`. Clients are treated as untrusted input even though they're local. Unknown `kind` → error response.

```ts
// src/shared/protocol.ts (v0.1 surface)
type SessionId = string;            // crypto.randomUUID(), made by the daemon
type Engine = 'claude-code' | 'codex';          // v0.4 adds 'ai-term'
type AuthRef = { kind: 'account' } | { kind: 'key'; keyId: string };
type Permission = 'ask' | 'dontAsk';
type Status = 'starting' | 'running' | 'waiting' | 'done' | 'idle' | 'exited' | 'error';

// requests (client → daemon), each answered with {ok:true, ...} or {ok:false, error:{code, message}}
hello            {protocol: 1, version}            → {protocol, version, daemonPid}
sessions.list    {}                                  → {sessions: SessionInfo[]}
sessions.create  {engine, model, auth, cwd, permission, title?, firstMessage?}  → {session}
sessions.attach  {sessionId, cols, rows}             → {snapshot, cols, rows, modes, session} then output frames stream
sessions.detach  {sessionId}
sessions.resize  {sessionId, cols, rows}             // attached client only
sessions.preview {sessionId | null}                  → {snapshot, cols, rows} then output frames (read-only; null = stop).
                                                      // A subscriber that fell behind gets a catch-up snapshot response with the same request id
sessions.stop    {sessionId}
sessions.remove  {sessionId}                         // exited/error only
sessions.rename  {sessionId, title}
layout.previewSize {cols, rows}                      // size every detached session runs at
engines.status   {}                                  → {claudeCode: EngineStatus, codex: EngineStatus}
                                                      // EngineStatus = {installed, path, version, loggedIn: boolean | null, authMethod: 'subscription' | 'api-key' | 'unknown'}
keys.list        {}                                  → {keys: KeyView[]}
keys.add         {provider, label, secret, endpoint?, deployments?}  → {key: KeyView}
keys.remove      {keyId}
keys.test        {keyId}                             → {results: DeploymentTest[]}
keys.scanEnvFile {path}                              → {found: {name, provider}[]}   // names only, never values
keys.importEnv   {path, names}                       → {keys: KeyView[]}
usage.summary    {}                                  → {summary: UsageSummary}
settings.get     {} → {settings: {theme}}
settings.set     {patch: {theme}} → {settings: {theme}} // v0.1.5: graphite|slate|ink|auto|light only; settings.json 0600
system.subscribe {on: boolean}

// events (daemon → client)
session.updated {session}   session.removed {sessionId}
session.previewResized {sessionId, cols, rows}        // attach/detach/resize: previews request a fresh sized snapshot   usage.updated {summary}   system.stats {stats}
```

`SessionInfo` = `{id, title, engine, model, auth: {kind, provider?, keyLabel?, last4?}, cwd, permission, status, statusDetail, statusSince, exitCode, createdAt, lastOutputAt, ctxPercent: number | null}`.

`KeyView` = `{id, provider: 'anthropic' | 'foundry' | 'openai', label, last4, endpoint?, deployments?, lastTest?}`. There is **no** request that returns a secret. `keys.add` is the only message that carries one, client → daemon. The client drops its copy right after sending.

---

## 5. Sessions: spawn, mirror, size, exit

**Record** (in `state.json`): everything in `SessionInfo` plus `pid` and the spawn recipe *without* env or secrets (engine, model, auth ref, cwd, permission).

**Lifecycle** (owned by `session-manager.ts`):
```
create → starting ──first output──▶ running
running ⇄ waiting ⇄ done          (exact from v0.2 hooks; in v0.1 a live process = running)
any ──exit 0──▶ exited      any ──exit ≠ 0 / spawn failure──▶ error
```
A process exit always wins over a late status event.

**Mirror.**
- Every output chunk goes to the session's `@xterm/headless` terminal (scrollback 5,000 lines) before it goes to any client.
- On attach or preview, the daemon sends `@xterm/addon-serialize`'s snapshot first, then live output. The snapshot carries the cols × rows it was captured at.
- **Snapshot size:** a snapshot must fit one 4 MiB frame. The daemon trims old scrollback until it fits. If the visible screen alone doesn't fit (pathological styling), the request fails with a clear error. Chunked snapshots are a later protocol change, only if that ever happens in practice.

**Size rule** (the one that makes the preview work):
- **Attached:** the session's PTY and its mirror take the attached client's terminal size.
- **Not attached:** they take the **preview size**, which the homepage reports with `layout.previewSize`.
- So switching the selection on the homepage never resizes anything. Entering a session resizes once, and coming home resizes once. Claude Code and Codex redraw on SIGWINCH.

**Terminal queries.** Agents ask the terminal things (cursor position, colors, device attributes).
- **Attached:** your real terminal answers through the client's input.
- **Nobody attached:** the mirror's own `onData` replies are written to the PTY instead, so an agent never hangs waiting for an answer. Replies are budgeted per session (16 KiB burst, 4 KiB/s; `src/daemon/reply-budget.ts`) because node-pty queues writes without limit; a session that floods queries gets the rest dropped.
- **Never both at once.**

**Flow control.** Three separate rules:
- **The mirror:** has its own bounded queue. If the mirror can't keep up, it pauses the PTY until it catches up, even with no client connected.
- **An attached client** (v0.1.4): if its socket buffer exceeds 1 MB, the daemon pauses that PTY and resumes it below 256 KB.
- **Preview subscribers:** never pause a PTY. One that falls behind is dropped from live output and gets a catch-up snapshot when it drains.

**Stop.** SIGTERM to the process group, then SIGKILL after 3 s.

**Exit.** The daemon records the exit code and keeps the mirror and record until `sessions.remove`.

---

## 6. Attach (full-screen session) and the home key

When you enter a session, the client:
1. switches your terminal to the alternate screen and raw mode
2. sends `sessions.attach` with the real size
3. writes the snapshot
4. replays the agent's terminal modes: cursor keys, keypad, bracketed paste, mouse tracking and encoding, focus events, cursor visibility. Some of these aren't in xterm's public `modes` (mouse encoding, cursor visibility), so the mirror tracks them from the output stream itself. Order matters: reset every mouse mode first, then enable the one in use.
5. pipes output frames straight to stdout and stdin straight to the session

**Ownership.**
- One client is attached to a session at a time. A new attach takes over, and the previous client gets `session.detached {sessionId, reason: "attached elsewhere"}`.
- A stale detach from the old client can't detach the new one.
- Input frames are accepted only from the current owner; everything else is dropped and logged without content.

AI Term draws nothing over the session in v0.1 (the frame bar comes in v0.2).

**Home key: Ctrl+E** (D11). One key, no modes.
- **Inside any session** (Claude Code, Codex, later AI Term's agent): Ctrl+E goes to the homepage, and the agent keeps running. The client never forwards it, in any of the forms it can arrive in:
  - the raw byte `0x05`
  - the kitty keyboard protocol (`CSI 101;5u`, including event-type variants)
  - xterm modifyOtherKeys (`CSI 27;5;101~`)
  
  Sequences split across reads are handled. Inside a bracketed paste (`\e[200~` … `\e[201~`), a `0x05` is pasted text, not the home key.
- **On the homepage:** ⏎ goes back into the selected agent; `/exit` quits `ai`. The agents keep running in the daemon.
- **Ctrl+Shift+E:** most terminals send the same byte, so it works too.
- **⌘E:** can't be used. Terminal.app and iTerm2 keep ⌘ keys for themselves and never pass them to a program.
- **Cost:** inside sessions, Ctrl+E no longer jumps to the end of the line. Use End (Fn+→) instead.

On the home key the client sends `sessions.detach`. It then resets every mode the agent may have turned on (mouse, bracketed paste, focus events, cursor keys, kitty keyboard, cursor visibility, colors), leaves the alt screen and raw mode, and redraws the homepage. The agent keeps running.

**Cleanup is guaranteed** on every way out: home key, the session exiting (`[session exited with code N]`), the daemon dying, and an uncaught error in the client. SIGKILL skips it, and so do SIGHUP and SIGQUIT today (listed in `docs/reviews/2026-10-12-checkpoint-review.md`).

**`/exit` chain.** The chain is: session → home → shell.
- Typing `/exit` inside Claude Code or Codex is *their* command: the agent exits, the session becomes `exited`, and the client returns home.
- `/exit` typed on the homepage quits `ai`. The daemon and the other agents keep running.
- Running `ai` again brings it all back.

**Resize while attached:** SIGWINCH in the client → `sessions.resize`.

**Mouse and selection inside a session:** passed through untouched. The agent's own selection and copy work exactly as in Terminal.app.

---

## 7. Spawning: engines, routing, env

### 7.1 Routing in v0.1
| You pick | Runs | Auth |
|---|---|---|
| Claude model, account | Claude Code | your Claude login (Claude Code's own) |
| Claude model, Anthropic key | Claude Code | `ANTHROPIC_API_KEY` from the keychain |
| GPT model, account | Codex | your ChatGPT login (Codex's own) |
| Foundry deployment that passed its test through Codex | Codex with a Foundry provider | Foundry key from the keychain |

- **Foundry on Codex:** Codex only speaks the Responses API (it rejects `wire_api="chat"`). A Foundry deployment is offered in `/model` only after its test request through Codex succeeds. Deployments that only speak Chat Completions (possibly Grok, Kimi, GLM, DeepSeek) wait for AI Term's own agent in v0.4 (D30).
- **"Account" means whatever the CLI is logged in with:**
  - `claude auth status --json` and `codex login status` say whether that's a subscription or an API key. Codex is currently logged in with an API key.
  - AI Term shows the method on the engine check and on each card.
  - A session is marked `sub` only when the CLI reports a subscription (D31).
  - AI Term never opens the CLIs' credential files; the masked hints the CLIs print are dropped, never shown or stored.

From v0.4, key sessions default to AI Term's own agent. A setting sends them to Claude Code or Codex instead.

### 7.2 Arguments (`buildArgs`, pure, unit-tested)
- Executable: `resolveExecutable('claude' | 'codex', PATH)` walks PATH and returns the absolute path of the first regular, executable file. Not found → the session goes to `error` with "claude not found in PATH".
- Model: one argv element `--model=<id>`, only if `isValidModelId(id)`: `/^[A-Za-z0-9][A-Za-z0-9._:\[\]\/-]{0,79}$/`. The leading-character rule plus the single-element form mean a "model" can never be read as another flag.
- First message: the last argv elements are `--` and then the message as one element. Both CLIs take a positional prompt, and both accept `--` (help-level parsing verified in v0.1.1). If a live run shows the prompt isn't delivered, fall back to typing it into the PTY with bracketed paste after the first output.
- Foundry on Codex: `-c` overrides only, nothing written to `~/.codex` (from docs; the live test is pending in `docs/spikes/v0.1-cli-facts.md` #3 and #4). Each override is one argv element:
  - `-c model_provider="aiterm_foundry"`
  - `-c model_providers.aiterm_foundry.name="AI Term Foundry"`
  - `-c model_providers.aiterm_foundry.base_url="<endpoint>"`, for example `https://narvis-resource.openai.azure.com/openai/v1` (no `api-version` on `/openai/v1`)
  - `-c model_providers.aiterm_foundry.env_key="AITERM_FOUNDRY_KEY"`
  - `-c model_providers.aiterm_foundry.env_http_headers={"api-key"="AITERM_FOUNDRY_KEY"}` (the value is the env var's *name*, never the key)
  - `-c model_providers.aiterm_foundry.wire_api="responses"`
  - `-c model_providers.aiterm_foundry.requires_openai_auth=false`
  - `--model=<deployment>`

  The endpoint goes into a `-c` value, so it's validated first: `https://`, a hostname, no quotes or whitespace.
- **Permission mode:**
  - `ask` (default) adds nothing.
  - `dontAsk` is chosen per session only, never as a saved default, and is shown with a red `!`. It adds exactly one flag per engine: Claude Code `--permission-mode=bypassPermissions`; Codex `--ask-for-approval=never` plus `--sandbox=workspace-write`. Codex stays sandboxed: don't-ask never means `--dangerously-bypass-approvals-and-sandbox`.
  - Flag spellings verified in v0.1.1. Claude Code also has a mode literally named `dontAsk`, which denies tools that aren't pre-approved. That is not our Don't ask; we never use it.
- Never passed: `--dangerously-skip-permissions`, `--yolo`, `--dangerously-bypass-approvals-and-sandbox`, `--full-auto`, `danger-full-access`.

### 7.3 Environment (`buildSpawnEnv`, pure, unit-tested)
**Base** = the daemon's own env. That's the env of the shell that first started `ai`. `ai daemon stop` and a restart pick up a changed shell env.

**Always set:**
- `TERM=xterm-256color`
- `COLORTERM=truecolor`
- `TERM_PROGRAM=AITerm`
- `LANG=en_US.UTF-8`, only if `LANG`, `LC_ALL` and `LC_CTYPE` are all unset

**Always removed:**
- `npm_*`, `npm_config_*`, `INIT_CWD`, `NODE_ENV`
- `AI_TERM_*` (set again per session from v0.2)

**Own-provider rule.** A session first removes its own provider's credential and routing variables, then sets only what its auth calls for. The other provider's variables pass through untouched: a Claude session running your tests may legitimately need `OPENAI_API_KEY`, exactly as in Terminal.app.

`CLAUDE_AUTH_VARS` (removed for every Claude Code session):
- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`
- `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `CLAUDE_CODE_OAUTH_SCOPES`
- `ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_WORKSPACE_ID`
- `ANTHROPIC_AWS_*`, `ANTHROPIC_BEDROCK_*`, `ANTHROPIC_VERTEX_*`, `ANTHROPIC_FOUNDRY_*`, `AWS_BEARER_TOKEN_BEDROCK`
- `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_SIMPLE`

`CODEX_AUTH_VARS` (removed for every Codex session):
- `OPENAI_API_KEY`, `CODEX_API_KEY`, `OPENAI_BASE_URL`
- `OPENAI_ORG_ID`, `OPENAI_ORGANIZATION`, `OPENAI_PROJECT_ID`
- `AZURE_OPENAI_API_KEY`, `AITERM_FOUNDRY_KEY`
- plus anything v0.1.1 finds Codex reads

| Session | Env after base |
|---|---|
| Claude Code · account | remove `CLAUDE_AUTH_VARS`. `CLAUDE_CONFIG_DIR` left as inherited (your normal `~/.claude`, with your skills and agents) |
| Claude Code · Anthropic key | remove `CLAUDE_AUTH_VARS`; set `ANTHROPIC_API_KEY=<from keychain>`. Config dir: the normal one, so your skills and agents work (provisional; revisit after Yaniv's first-run approval test, `docs/spikes/v0.1-cli-facts.md` #1–2) |
| Codex · account | remove `CODEX_AUTH_VARS`. `CODEX_HOME` left as inherited |
| Codex · Foundry key | remove `CODEX_AUTH_VARS`; set `AITERM_FOUNDRY_KEY=<from keychain>`; provider via `-c` (7.2) |

Why stripping matters: an exported `ANTHROPIC_API_KEY` overrides a logged-in Claude subscription, and `CLAUDE_CODE_OAUTH_TOKEN` silently switches accounts. Without the strip, an "account" session could bill your API key without telling you.

**The secret's lifetime.**
1. Read from the keychain in `session-manager.create` immediately before `buildSpawnEnv`.
2. Passed into the env object only.
3. After `pty.spawn`, the env and secret references are dropped.

Never logged, never stored, never sent to a client.

**Known limit.** Env hygiene controls the process env only. An `env` block or `apiKeyHelper` in your own `~/.claude/settings.json`, or `model_provider` in `~/.codex/config.toml`, still applies, exactly as in Terminal.app. AI Term never reads or edits those files.

---

## 8. Keys (OS keychain)

> **Concept: OS keychain.** The operating system's encrypted password store: Keychain on macOS, Credential Manager on Windows, Secret Service (GNOME Keyring / KWallet) on Linux. The OS encrypts it with your login and only gives entries back to your user account. We use `@napi-rs/keyring` to reach all three from Node. Code: `src/daemon/keys.ts`.

- Each key is an entry with service `ai-term` and account `<provider>:<keyId>`. Its metadata (label, last4, endpoint, deployments) lives in `settings.json`. last4 is computed once, when the key is added.
- `keys.add`: validate the input (provider known; the secret is a non-empty string ≤ 512 chars with no whitespace; the endpoint is `https://`), write to the keychain, then store the metadata. If the keychain is unavailable, refuse with a clear message. There is never a plain-file fallback.
- **Import from .env.**
  1. `keys.scanEnvFile` reads the file in the daemon and returns only the *names* of known key variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`, …).
  2. You pick which ones to import.
  3. `keys.importEnv` moves the values straight into the keychain.
  
  The file is never modified, and the UI suggests deleting it.
- **Foundry test.** For each deployment, one `POST <endpoint>/responses` with `{model: <deployment>, input: "ping", max_output_tokens: 16}` and a 15 s timeout. On 404 or 400 it tries `chat/completions`. The result per deployment is ready / not a chat model / error (HTTP status + the provider's error code, never the key). Requests go only to the configured `https://` endpoint, with the key in the `api-key` header.
- Removing a key deletes the keychain entry and its metadata. Sessions already running keep their env until they exit.

---

## 9. Usage, cost, budget

- **Scope:** every session whose effective auth is an API key. That's AI Term's keyed sessions, plus Claude Code or Codex when their own login is an API key (D31). Subscription sessions show `sub` and are not counted. AI Term never reads Claude Code's or Codex's own files to count anything.
- **Source per engine:** OpenTelemetry the CLI exports itself, received by a local OTLP/HTTP receiver in the daemon. Payloads are JSON (`http/json`), never protobuf. Each session gets its own runtime-only receiver credential, sent as a header, never in argv or logs.
  - **Claude Code (metrics only):**
    - env: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=none`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://127.0.0.1:<port>/v1/metrics`, `OTEL_EXPORTER_OTLP_METRICS_HEADERS=x-ai-term-session=<credential>`, `OTEL_METRICS_INCLUDE_SESSION_ID=true`, `OTEL_METRIC_EXPORT_INTERVAL=10000`
    - metrics read: `claude_code.token.usage` (input / output / cacheRead / cacheCreation) and `claude_code.cost.usage` (USD, Claude Code's own estimate)
    - cumulative vs delta handling and restart de-duplication are specified before the receiver is written
  - **Codex (logs):**
    - `-c otel.log_user_prompt=false`, `-c otel.exporter={otlp-http={endpoint="http://127.0.0.1:<port>/v1/logs",protocol="json",headers={"x-ai-term-session"="<credential>"}}}`
    - only the token counts of `codex.sse_event` / `response.completed` are kept; the rest of every event is dropped unread, because tool output in other events can contain your code
    - cost is estimated from the price table
  - The exact payload shapes are confirmed by live tests #5 and #6 in `docs/spikes/v0.1-cli-facts.md` before v0.1.8.
- **Event** (`usage/YYYY-MM.jsonl`): `{ts, sessionId, provider, model, inputTokens, outputTokens, cachedTokens?, costUsd, costSource: 'cli-estimate' | 'price-table'}`. Neither is a bill: both are estimates and the UI says so.
- **Price** when the CLI doesn't report cost: a bundled snapshot of the Models.dev catalog, plus per-deployment price overrides for Foundry in settings. Shown as estimated.
- **Summary:** today / this week (Monday start, local time) / this month, as cost and tokens, by provider, recomputed incrementally.
- **Budget:** optional daily / weekly / monthly limit in settings.
  - **v0.1:** crossing a limit turns the top-bar count amber and shows a warning line. Nothing is blocked.
  - **v0.4:** AI Term's own agent stops *before* a request that would cross the limit.
  - **Claude Code and Codex:** AI Term can only stop the session after the fact, never block a request in flight.

---

## 10. This Mac (system stats)

These run only while a client subscribes, sampled every 2 s:
- **Per session:** `ps -axo pid=,ppid=,rss=,%cpu=` (execFile, no shell). The daemon builds the process tree and sums each session's PTY child and all its descendants into CPU % (share of the whole machine) and RSS.
- **Machine CPU:** deltas of `os.cpus()` times. The client keeps the last 10 samples for the sparkline.
- **Machine RAM:** macOS uses `vm_stat` (active + wired + compressed pages × page size), because `os.freemem()` under-reports on macOS. Linux uses `/proc/meminfo`.
- **Network:** deltas of `netstat -ibn` byte counters on non-loopback interfaces (macOS), `/proc/net/dev` on Linux. Machine-wide only: per-process network isn't reliable on macOS.

---

## 11. Security rules as checks

How to verify each: **Unit** = vitest. **Grep** = must find nothing in `src/` (outside the allowed file named). **Manual** = Yaniv runs it; the agent reports each manual check as *ran* (with what it saw) or *needs Yaniv*.

| # | Rule | Check |
|---|---|---|
| S1 | Socket is private | Unit: `~/.ai-term` and `run/` are created 0700 and the socket is private from the moment it's bound (restrictive umask at bind, then verified 0600; never briefly world-accessible). Startup refuses a symlinked or foreign-owned dir. Manual: `ls -la ~/.ai-term ~/.ai-term/run`. |
| S2 | Protocol input is validated | Unit: oversize frame, malformed JSON, unknown kind, bad types and out-of-range sizes are all rejected without crashing the daemon. |
| S3 | Keys only in the keychain | Manual: add canary key `sk-ant-AITERMCANARY0000`, then `grep -r AITERMCANARY ~/.ai-term` and the repo → nothing. |
| S4 | Keys never leave the daemon except into a child env | Unit: no response or event contains a stored secret (canary test over every handler). Grep: no `getPassword` outside `src/daemon/keys.ts`. |
| S5 | Keys and env never logged | Unit: the logger redacts values of keys matching `/(KEY|TOKEN|SECRET|PASSWORD)/i` and strings matching `sk-`, `sk-ant-`. Grep: no logging of `process.env` or a spawn env. |
| S6 | Account sessions spawn without API keys | Unit: `buildSpawnEnv` for Claude account with every `CLAUDE_AUTH_VARS` entry in base → none present; same for Codex. Manual: inside an account session, `! env \| grep -iE 'anthropic\|oauth\|api_key'` → nothing. |
| S7 | A key session sets only its own key | Unit: Claude key env has `ANTHROPIC_API_KEY` = keychain value and no other `CLAUDE_AUTH_VARS`; Foundry env has `AITERM_FOUNDRY_KEY` and no `OPENAI_API_KEY` from the keychain. |
| S8 | No shell strings | Grep: no `exec(`, `execSync(`, `shell: true`, or a single-string command passed to `spawn`/`execFile`. |
| S9 | Validated arguments | Unit: model validator rejects a leading `-` and spaces; cwd must exist and be a directory; deployment names follow the same pattern as model ids. |
| S10 | Permission prompts never skipped by default | Unit: `buildArgs` with default settings contains no permission flag; `dontAsk` adds exactly the flags in 7.2; settings refuse `dontAsk` as a saved default. Grep: the permission flags appear only in `src/daemon/env.ts`. |
| S11 | Never read CLI credentials | Grep: no `auth.json`, `.credentials.json`, `security find-generic-password`, and no file reads under `~/.claude` or `~/.codex`. |
| S12 | Local HTTP endpoints locked down: usage receiver (v0.1.8), status endpoint (v0.2) | Unit + manual curl: bound to `127.0.0.1` only, random port; per-session credential compared with `timingSafeEqual`; `Host` must equal `127.0.0.1:<port>` (else 421); any `Origin` → 403; non-JSON → 415; bodies never logged. Status endpoint: body > 64 KB → 413, success → 204 with an empty body (a hook response must never carry a decision). Usage receiver: only `POST /v1/metrics` and `/v1/logs`, body > 1 MB → 413, success → 200 with `{}` (what OTLP exporters expect), only usage numbers kept. |
| S13 | .env import is read-only and value-blind | Unit: `scanEnvFile` returns names only; the file's mtime and content are unchanged afterwards. |
| S14 | Deletion asks first (v0.3) | Unit (temp repo): removing a worktree with uncommitted, untracked or unmerged work is refused without explicit confirmation. |
| S15 | Background sessions can't reach your terminal | Unit: the homepage preview renders from mirror cells only. No raw agent bytes reach your terminal unless you're attached, so a background agent can't set your clipboard (OSC 52), retitle your window or ring the bell. |
| S16 | Keys go only where they belong | Unit: Foundry test requests refuse a non-`https://` endpoint and send the key only in the `api-key` header to that host. |

---

## 12. Later versions, outline

- **v0.2 Frame bar + live status.** The client draws one row above an attached session and gives the PTY one row less. Status comes from Claude Code HTTP hooks passed per session with `--settings=<sessions/<id>/claude-settings.json>`:
  - `UserPromptSubmit` → running
  - `PostToolUse` → running
  - `Notification` matching `permission_prompt|elicitation_dialog|agent_needs_input` → waiting
  - `Stop` → done
  - `StopFailure` → done, with detail
  
  Codex uses `-c notify=[…]` with a helper, and OSC 9 as a secondary signal. A status endpoint in the daemon follows S12, with a per-session token (HMAC of a per-launch secret, passed in env, never argv). The endpoint always answers 204 with an empty body, so the status channel can never make decisions. Also in v0.2: macOS notifications for waiting/done, and the context-left % where the engine reports it.
- **v0.3 Splits + worktrees.** Several attached sessions in one client screen. One git worktree per agent session on branch `ai/<slug>`, with git via `execFile` and `--` before refs and paths. Branch names are validated strictly. Deleting a worktree with uncommitted, untracked or unmerged work needs explicit confirmation.
- **v0.4 AI Term's agent.** Vercel AI SDK + Models.dev; tools read, write, edit, bash, search; Ask / Don't ask; reads `AGENTS.md`; `/model` (keyed models only); exact cost; hard budget.
- **v0.5 The app.** An Electron terminal that opens straight into `ai`. Renderer sandboxed (`contextIsolation`, no `nodeIntegration`, `sandbox`), narrow typed preload, CSP, no navigation, links http/https only.

---

## 13. Decisions log

Pinned decisions are not reopened unless Yaniv asks. Proposed ones stand unless he objects.

| # | Decision | Status |
|---|---|---|
| D1 | AI Term = the `ai` TUI + a background daemon. The Electron app (v0.5) is the best terminal to run it. Replaces the old Electron-first plan and its D1 to D20. | Pinned |
| D2 | Routing: account → official CLI (Claude Code / Codex). API key → AI Term's agent from v0.4 (official CLIs until then); a setting can send keys to the official CLI. | Pinned |
| D3 | AI Term's agent uses the Vercel AI SDK + Models.dev; no hand-written provider adapters. | Pinned |
| D4 | A Claude subscription is only ever used inside real Claude Code. | Pinned |
| D5 | TypeScript everywhere. | Pinned |
| D6 | macOS first with no macOS-only design; Linux and Windows by v0.8. | Pinned |
| D7 | Everything local: state in `~/.ai-term`, no cloud server; "share" = export a file. | Pinned |
| D8 | Homepage: agent list left, live preview right, Usage and This Mac under the preview, command bar at the bottom, status counts top right (docs/design.md). | Pinned |
| D9 | `/model` on the homepage picks model and engine. Inside Claude Code / Codex, their own `/model`. Inside AI Term's agent, keyed models only. | Pinned |
| D10 | `/cd` on the homepage sets the folder for the next agent; AI Term's agent supports `/cd` anytime. | Pinned |
| D11 | Home key: Ctrl+E from inside any session goes to the homepage. On the homepage, ⏎ enters the selected agent and `/exit` quits `ai`. No other home keys. | Pinned |
| D12 | v0.1 sessions are full screen; v0.2 adds the frame bar; v0.3 splits. | Pinned |
| D13 | Permissions: Ask / Don't ask. Ask is the default and the only saveable default; Don't ask is per session with a red marker; Codex stays sandboxed. | Pinned |
| D14 | One instruction file, `AGENTS.md`; a one-line `CLAUDE.md` (`@AGENTS.md`) covers Claude Code. | Pinned |
| D15 | Keys live only in the OS keychain; never `.env` or plain files. "Import from .env" reads, never writes. | Pinned |
| D16 | Account sessions start with their provider's keys stripped; key sessions get only their own key. | Pinned |
| D17 | AI Term never reads or copies CLI logins. Extra Claude/Codex accounts (v0.6) get their own config folder with skills, agents and commands symlinked. | Pinned |
| D18 | Client ⇄ daemon over a user-only Unix socket (named pipe on Windows). No network ports except 127.0.0.1 endpoints that follow S12. | Pinned |
| D19 | Worktree per agent session from v0.3; never delete one with unmerged work without asking. | Pinned |
| D20 | Builders: Codex on GPT-6.1 Sol by default (high; xhigh for hard steps). Claude Code (Opus 5.5) only for release gates, steps Yaniv marks important, and bugs Codex failed twice, because Claude usage is limited. Security checks are written into every Codex prompt. | Pinned |
| D21 | Every UI version goes through Claude Design first (design system + mockups + review). | Pinned |
| D22 | Live preview = the mirror's cells rendered by the client, read-only, `p` toggles it; keys on the homepage never reach an agent. | Pinned |
| D23 | Size rule: detached sessions run at the preview size; attached at the client's size. | Proposed |
| D24 | Keychain access through `@napi-rs/keyring`. | Proposed |
| D25 | Node ≥ 22, not Bun (node-pty). node-pty's install scripts are approved in package.json. | Pinned |
| D26 | TUI renderer: our own diffed cell grid with synchronized output (v0.1.2: 14% CPU / 3.1 ms vs Ink 46% / 17.6 ms). | Pinned, unless Yaniv sees flicker in `node spikes/renderer/main.js grid` |
| D27 | Usage counts API-key sessions only; subscription sessions show `sub`. | Pinned |
| D28 | Notifications (macOS, with sound) for waiting and done arrive with v0.2 hooks. | Pinned |
| D29 | Manager agent (goal → tasks → many agents) is a v2+ idea; nothing before v1.0 is built for it. | Pinned |
| D30 | Foundry through Codex only for deployments whose Responses test passes; the rest wait for AI Term's agent (v0.4). | Pinned |
| D31 | "Account" = whatever the CLI is logged in with. AI Term shows subscription vs API key from the CLI's own status command, and counts usage for API-key auth. | Pinned |
