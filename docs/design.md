# AI Term: Design

Approved in v0 (Claude Design). Mockups: canvas "AI Term screens" (https://claude.ai/artifact/MgKPBbpXjasCDJUbwWQKoo); design system: https://claude.ai/artifact/Qmj47GkxjoLXNbA5X1HyXT. Agents can't open those, so this file is the spec. When this file and a mockup disagree, ask.

## Direction

**Quiet chrome, loud content.** The agents' output is the product; everything around it recedes. One accent color (teal). Status colors are the only loud things, and only when an agent needs you.

Every UI decision passes three tests:
1. Does it cost typing latency or redraw time? Then it goes.
2. Can you do it from the keyboard? If not, it isn't done.
3. Is it calm? No decoration, no animation that isn't information.

> **Concept: design tokens.** A token is a named design value (`accent`, `ink-3`) defined once and used everywhere instead of raw colors. Dark and light are the same names with different values, so switching theme swaps one table. Our source is `docs/design/tokens.json`. The TUI turns each color into a truecolor escape (`\e[38;2;r;g;bm`), or the nearest 256-color index when the terminal doesn't support truecolor.

---

## Tokens

Full values and usage notes are in `docs/design/tokens.json`. Code reads colors only from there (through one theme module), never raw hex.

| Token | Dark (Graphite) | Light | Use |
|---|---|---|---|
| `bg` | `#1E1F22` | `#FAFAF9` | ground. Fixed palettes paint it; auto inherits the terminal background with SGR 49 |
| `surface` | `#26282C` | `#F1F1EF` | command bar field, popups, frame bar, preview terminal area |
| `surface-2` | `#313338` | `#E8E9E6` | selected row, key caps, logo badges. Never a large area |
| `line` | `#4A4D55` | `#9EA3AB` | box borders and dividers. Decorative: nothing is told apart by a border alone |
| `ink` | `#E8E9EC` | `#1B1D21` | primary text |
| `ink-2` | `#B0B5BE` | `#4A515C` | secondary text: model, engine, numbers |
| `ink-3` | `#9CA2AD` | `#5A6270` | hints, labels, placeholders |
| `accent` | `#5AD8CC` | `#07706A` | prompt chevron, running mark, links, + counts, selection bar |
| `on-accent` | `#0B1A19` | `#FFFFFF` | text on an accent fill |
| `status-waiting` | `#F5BC55` | `#8F5300` | ● waiting. The loudest color; never decoration |
| `status-error` | `#F47B7E` | `#B22C34` | ✗ failed, `!` don't ask, − counts |
| `status-done` | = `ink-2` | = `ink-2` | ✓ done: calm, not a signal |
| `status-running` | = `accent` | = `accent` | ◐ running |

**Themes (v1.2.6).** Every theme is a column of `docs/design/tokens.json` (`value.<theme>.<dark|light>`), read only through the one theme module (`src/shared/theme-tokens.ts`). Each built-in has a dark and a light variant, and every text token (ink, ink-2, ink-3, accent, status-waiting, status-error) holds 4.5:1 or more on bg, surface and surface-2, on-accent on accent too (`tests/v126-themes.test.ts`). One accent hue (teal) in all of them.
- **`graphite`** (default): the two columns above. Dark chosen by Yaniv on 2026-10-11 after trying each live in Terminal.app.
- **`slate`:** blue-gray. Its dark is the slate palette of 2026-10-11 (bg `#1B2029`, surface `#232935`, surface-2 `#2D3443`, line `#46506A`, ink `#E6EAF0`, ink-2 `#AEB6C4`, ink-3 `#9AA4B5`, accent `#58D6C9`); its light is a cool blue-gray paper.
- **`ink`:** the original darkest (bg `#111317`, surface `#191C21`, surface-2 `#242830`, line `#3A3F48`, ink `#E6E8EB`, ink-2 `#A3A9B4`, ink-3 `#8E96A3`, accent `#4FD1C5`); its light is plain white paper with near-black ink.
- **`dune`:** warm sand neutrals, the same teal.
- **`contrast`** (High contrast): black and white grounds; every text token holds 6:1 or more.
- **Variant:** `dark`, `light` or `system`: dark or light by the terminal's own background (OSC 11, 200 ms; no reply is dark). In the app, system follows macOS light/dark. Unset: dark in a terminal and system in the app, as each was before variants. `light` alone is still the name of graphite light.
- **`auto`** ("match my terminal"), not a column of tokens.json:
  - The background is never painted (SGR 49), so it is exactly the terminal's own color.
  - At startup, the terminal is asked for its background (OSC 11, 200 ms timeout). Panels are derived from it: surface = 5% toward white, surface-2 = 11%, line = 24%. On a light background, mix toward black instead and use the light text tokens.
  - No reply: slate dark.
  - The rules are in `spikes/renderer/theme.js`.
- **A theme file of your own:** `~/.ai-term/themes/<name>.json` with an optional `name` (its label, 1–32 printable characters) and a `dark` and a `light` set holding every base token above as `#rrggbb`. The derived tokens (status-running, status-done, status-idle) are filled in and may not be set. A file that is incomplete or wrong is refused whole, with one line naming what's wrong (`missing light.bg, light.ink`), never half-applied; it can't be saved, and a saved one that breaks later is graphite with a note. Contrast isn't checked for your own files: that's your call.

**`/theme`** (v1.2.6): a surface box at the top right, flush with the edge (at most 66 cols), titled `Theme`, so the homepage behind it stays in view and is drawn in whichever theme is highlighted. Lines: `the homepage behind shows the highlighted one` (ink-3), one row per theme (built-ins, then your files as `<label> · your file`, then `Match my terminal`), the saved one marked `· in use`, then one `✗ <file> refused · <reason>` row per refused file (status-error), then the footer `↑↓ theme · ←→ dark, light or system · ⏎ picks · Esc goes back` (ink-3). The highlighted row is surface-2 with `›` and bold, its variants at the right in accent, the current one in brackets: `[dark] · light · system` (Match my terminal: `uses your terminal's background`). ⏎ saves and notes `✓ theme <label> · <variant>`; Esc restores the saved theme and saves nothing. Static: each key is one redraw.

Status colors keep their hue across the themes: waiting is amber, error is red, done = ink-2.

**Diff tints:** added lines use `accent` at 16% over the background, removed lines `status-error` at 16%.

**Selection highlight:** `accent` at 38%.

## Status marks

Never color alone: every status has its own glyph and a word somewhere on screen.

| Status | Glyph | Color | Word |
|---|---|---|---|
| running | ◐ | accent | running |
| waiting | ● | status-waiting (bold) | waiting |
| done | ✓ | status-done | done / to review |
| idle | · | ink-3 | idle |
| exited | ■ | ink-3 | exited |
| error | ✗ | status-error | failed |

**Other marks:**
- `!` (status-error) = this agent runs in Don't ask mode
- `◉` (accent) = live preview
- `↗` = a link
- `sub` (ink-3) = runs on a subscription, no API cost

---

## Homepage (v0.1)

Reference size 130 × 45 cells. Everything is drawn with box borders in `line`, panel titles sitting on the top border.

```
 AI Term_   notify on                                ● 1 waiting   ◐ 3 running   ✓ 2 to review   ✗ 1 failed
╭ Agents 7 ──────────────────────╮ ╭ fix-login-redirect ─────────────────────────────────────── ◉ live ╮
│▎CL fix-login-redirect   ● 4m   │ │ claude code · opus-5.5                             ctx 62%  +18 −4 │
│▎   opus-5.5 · claude code  62% │ │ ┌──────────────────────────────────────────────────────────────┐ │
│▎   asks: npm test -- auth      │ │ │ … the selected agent's real screen, live, read-only …        │ │
│ KI store-refactor      ◐ 12m   │ │ │                                                              │ │
│    kimi-k3 · ai term       38% │ │ │                                                              │ │
│    editing src/store/cart.ts   │ │ └──────────────────────────────────────────────────────────────┘ │
│ GP flaky-tests         ◐ 38m   │ ╰──────────────────────────────────────────────────────────────────╯
│    gpt-6.1-sol · codex     91% │ ╭ Usage ─────────────────────────╮ ╭ This Mac ─────────────────────╮
│    ! don't ask · npm test      │ │            today  week   month │ │ CPU 31% ▂▃▅▇▆▄▃▅▆▄  agents 19%│
│ GR readme-pass         ✓ 1h    │ │ spend      $2.76  $11.02 $41.80│ │ RAM 14.2/32 GB    agents 2.3 GB│
│    grok-4.6 · ai term          │ │ tokens     1.9M   7.9M   31.0M │ │ NET ↓ 1.4 MB/s  ↑ 0.2 MB/s    │
│    +40 −22 · ready to review   │ │ budget     none   none   b add │ │                               │
╰────────────────────────────────╯ ╰────────────────────────────────╯ ╰───────────────────────────────╯
╭──────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ › What do you want to build?█                                                                         │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────╯
   opus-5.5 · claude code   ~/code/ai-term   ask   worktree           ↑↓ agents  ⏎ open  p preview  / commands
```

### Top line
- **Left:** `AI Term` (bold) + `_` in accent, then `notify on` (ink-3 + accent). The notify part appears from v0.2.
- **Right:** status counts, in the order waiting, running, to review, failed, each with its glyph and color. A count of zero is hidden.
- **When a budget is crossed (v0.1):** a warning in status-waiting is added: `budget: today $10.40 / $10`.

### Agents panel (left, 36 cols)
- **Title:** `Agents N` (N in ink-3).
- **Cards:** one per session, newest first, except that waiting agents always sort to the top.
- **Card** (3 lines, 1 blank cell of padding):
  - Logo badge: 4 cols × 2 rows, surface-2 fill, two bold letters (CL Claude, GP GPT, KI Kimi, GR Grok, DS DeepSeek, GL GLM). The badges stay in the app too: no real provider logos without written permission (D51).
  - Line 1: name (bold when selected), right-aligned status glyph + word + age (`4m`, `2h`, `3d`).
  - Line 2: `model · engine · ai/<slug>` (ink-2; branch drops before model at narrow widths), right-aligned `ctx NN%` (ink-3; status-waiting from 85%). ctx appears only when the engine reports it (v0.2+).
  - Line 3, auth for Claude/Codex: `own login · sub`, `own login · API key`, `own login`, or `API key ····last4`. From v0.6.1 the agent's own total follows it once it has one (cost per task, `/settings` o): `API key ····last4 · $0.42` (`<$0.01`, `$0.30+?` when part had no price) or `own login · sub · 12.3K tok`; when the activity text needs the room, the activity wins, as for auth. Their status word stays on line 1; a red `!` marks Don't ask, with its full word in the selected preview title. Debug shell cards keep their existing activity line. Later activity details follow:
    - waiting: the question in status-waiting
    - running: the last activity in ink-3 (v0.1 shows the task you typed; live activity from v0.2)
    - done: `+N −M · ready to review`
    - failed: `exit N · reason` in status-error
    - don't ask: prefixed by `! don't ask ·` in status-error
- **Selected card:** surface-2 background + a 1-col accent bar (`▎`) on the left edge.
- **Too many agents to fit:** the list scrolls and keeps the selected card visible.

### Preview panel (right, top)
- **Border title:** the agent's name (bold). Top-right on the border: `◉ live` (or `◌ scrolled back`).
- **Header line:** `engine · model` (ink-2) left; right `ctx NN%  +N −M`.
  - From v0.1.8a, the selected agent's own usage sits at the right end of this line as `cpu 4% · 310 MB` (ink-3), before any ctx/diff text. This Mac only shows totals, and the cards stay unchanged.
- **Terminal area:** surface background. Shows the selected agent's mirror, cell for cell, with its colors.
- **Read-only:** nothing you type on the homepage ever reaches an agent.
- **`p`** hides or shows the preview. Hidden: the Agents panel and the Usage + This Mac row take the space; the preview border shows `▸ preview hidden · p`.
- **Scrolling:** mouse wheel or PgUp/PgDn scrolls back. A banner on top: `↑ 38 lines back · the agent keeps running  End follow live`. When new output arrives while scrolled back, a bottom banner says `● N new lines below` (status-waiting if the agent is waiting).
- **Copy on select:** dragging highlights (accent 38%); release copies to the OS clipboard and flashes `✓ copied N lines` (on-accent on accent) for 1.2 s. Option+drag (macOS) or Shift+drag elsewhere falls back to the terminal's own selection.
- **Empty:** with no agents, the preview shows a short intro: what AI Term does, ⏎ to start, `/login` to connect.

### Usage panel (under the preview, left)
- **Columns:** today / week / month.
  - `spend` row: bold values.
  - `tokens` row: ink-2, compact (`1.9M`). When a period has cache reads, its cached share follows in ink-3: `80.8K (71.0K cached)` when every column fits that, else `80.8K (71.0K)` with `(…) cached ·` before the hint line, else the totals alone. Columns share the panel after the labels, at most 23 cells each (B23, 2026-10-13).
  - `budget` row: the limit per period or `none`, with `b add` (key cap + accent) at the end.
- **Scope:** API-key sessions only. Subscription sessions aren't counted.
- **`u`** (or `/usage`, 2026-10-14): opens Usage details, a surface popup like Help titled `Usage`: per period `TODAY  ≈ $1.50 · 2.0K tokens (500 cached) · budget $10` (ink; status-waiting with `· ! over budget` when crossed), then one ink-2 row per provider, then (v0.6.1, cost per task) `BY AGENT (start to now)` with one ink-2 row per agent that has a total: `  <name>  ≈ $0.42 · 1.5K tokens` for API keys, `  <name>  9.0K tokens · plan limits, not dollars` for subscriptions, then the scope line in ink-3. By model waits until the daemon aggregates it.

### This Mac panel (under the preview, right, 36 cols)
- **CPU:** `CPU 31%` (bold value), a 10-sample sparkline in accent (`▁▂▃▄▅▆▇█`), right `agents 19%`.
- **RAM:** `RAM 14.2/32 GB`, right `agents 2.3 GB`.
- **NET:** `NET ↓ 1.4 MB/s  ↑ 200.0 KB/s` (machine-wide). Each rate uses B/s, KB/s or MB/s with one decimal.
- Updated every 1 s, and only while the homepage is open (D46).

### Command bar
- **Field:** surface background with a line border. `›` in accent, your text, block cursor. Placeholder: `What do you want to build?` (ink-3).
- **Line under it:** left, the defaults for the next agent: `model · engine   folder   auth   effort   permission   worktree` (worktree appears from v0.3). Auth uses the next agent's `own login · sub/API key` or `key ····last4`; folder is clipped before auth. Right, the key hints. Keys appear only here, not repeated in panels.
- **⏎ with text:** opens the **Start a new agent** box (below).
- **Paste:** more than one line or 200 characters renders as one `[pasted · N lines]` token. Its exact contents and newlines stay in memory. Backspace removes a token whole; typed text can surround it. The combined first message is limited to 16,384 UTF-8 bytes; an insertion over the limit adds nothing and notes `too long for a first message (16 KB): start the agent, then paste inside`. Small pastes stay literal.
- **Cursor and selection (2026-10-13, Yaniv's request):** ←/→ move by character, Alt+←/→ by word, Home/End and Ctrl+A/Ctrl+E to the ends (End with an empty field still follows the preview live). Typing and paste insert at the cursor; Backspace/Delete work at it. A paste token is one step and is deleted whole. A mouse drag in the field, or Shift+←/→, selects (accent 38%, the block cursor hides while text is selected); typing or paste replaces the selection, Backspace/Delete remove it, Esc or a click clears it (a second Esc clears the field). Ctrl+U clears the field; Alt+Backspace (or Ctrl+W) deletes the previous word. A field drag never copies; ↑↓ keep selecting agents only while the field is empty.
- **⏎ with an empty field:** goes inside the selected agent.
- **`/` at the start:** opens the filtered command menu. ↑↓ moves the selected-card highlight through commands, wrapping; typing resets to the first match. Each row shows command and argument hint, a short description, and current value at the right in ink-3. ⏎ picks the highlighted command; `/effort` and `/mode` insert their argument prefix, and `/theme` opens its list (v1.2.6). Tab completes the highlighted command, then cycles supported argument values. Esc closes. Outside the menu ↑↓ selects agents.

### Start a new agent (box over the command bar)
- **Box:** surface fill, accent border, title `Start a new agent`. Rows: model (+ `/model`), folder (+ `/cd`), branch (`auto` from v0.3), mode (`ask` → `auto` → `don't ask` for Claude; Codex `ask` ↔ `don't ask`; Don't ask shown in status-error with `!`), effort (`CLI default` or the selected CLI's documented level), first message ("your text above is its first message").
- **Keys:** ↑↓ selects rows; m model, c folder, e effort; Tab cycles the available modes. ⏎ starts, Esc returns to editing. Mode is per session and resets to Ask after start/cancel.
- **First-message row:** paste tokens carry over from the command bar and can be inserted here too. Show the token plus its first line, clipped by the row width; never flatten or truncate its stored contents. Esc restores the draft with tokens intact.
- **Worktree preview (v0.3.1):** one quiet line `new worktree · ai/<slug> from <short HEAD>`; dirty checkouts add `uncommitted changes in your checkout aren't included`. The preview is read-only; the start rechecks branch/path availability.
- **After starting:** the new agent is selected and the preview shows it starting.

### /model picker
- **Popup:** surface box, title `Select model`, provider tabs on its top row, then filter and models.
- **Tabs:** `ANTHROPIC · OPENAI · FOUNDRY · <resource>`; one Foundry tab per configured resource. Future keyed providers get their own tab. Opens on the current selected/default model's provider.
- **Keys:** ←→ switch provider (Tab also moves right); ↑↓ select a model inside that provider; ⏎ selects; Esc returns without changing the selection.
- **Filter:** typing searches model names across all providers, jumps to the first matching provider, and selects its first result. All provider tabs remain available. A custom valid ID in an Anthropic/OpenAI tab uses the CLI's own login; Foundry only lists tested ready deployments.
- **Each row:** `model · engine · auth`. CLI-managed auth is `own login · sub`, `own login · API key`, or `own login` when unknown. Saved key rows stay `key ····last4`.
- **Footer:** `own login → official CLI · Foundry key → ai term (or its CLI: /settings r)` from v0.4.1 (D47; Anthropic and OpenAI keys keep their CLIs until v0.4.2). A Foundry row's engine reads `ai term`, or `codex` with `keys run on: the cli`.

### /cd
A path field with completion. It sets the folder for the next agent only. A folder that doesn't exist or isn't a directory is an inline error.

### /settings
- **Popup** with sections:
  - **KEYS** (OS keychain): label, endpoint, `key ····last4`, plus `+ add key` (paste, or import from .env).
  - **ENGINES:** Claude Code / Codex, each with `✓ installed` and `✓ logged in` (or `✗ not logged in` with `/login`).
  - **DEFAULTS:** model, folder, permissions (`ask` only; don't ask is per agent), theme, effort (`CLI default` or selected engine level; e edits), copy on select, budget, notifications (`on`/`off`, n toggles; default on), worktrees (`on`/`off`, w toggles; default on), attached bar (`off`/`on`, h toggles; default off, applies at next attach), keys run on (`ai term`/`the cli`, r toggles; default ai term, D47's fallback). From v0.6.1, `cost per task: on · cards and /usage (o)` (D55, default on); from v0.6.2, `presets: on · /preset (s)` (D55, default on); from v1.2.6, the theme row names the variant (`theme: slate · light · ⇥ change · /theme previews`) and `app fonts: terminal default 13 · chrome default 13 · ligatures off · the AI Term app only (F)` opens the fonts form (its rows `terminal font`, `terminal size · ←→`, `chrome font`, `chrome size · ←→`, `ligatures · Space`, footer `↑↓ field · type a family (empty: default) · ⏎ saves · Esc goes back`; Esc returns to /settings). Permissions remain Ask-only as saved defaults. The notifications row adds permission words: `on · allowed`, `on · blocked: turn on AI Term in System Settings → Notifications`, `on · not asked yet: you'll be asked at the first notification`, or `on · permission unknown`. If notifications can't be sent, a fixed `notifications unavailable: …` line follows.
- **Footer:** `keys are never shown in full and never written to .env`.

### /login
- **Providers list:** Anthropic, OpenAI, Microsoft Foundry, then "from v0.6" entries (xAI, OpenRouter, Ollama, other endpoint).
- **OpenAI choice:**
  - **ChatGPT account:** runs Codex's own login inside AI Term.
  - **API key:** keychain; runs on AI Term's agent from v0.4, on Codex until then.
- **Anthropic:**
  - **Claude account:** Claude Code's own login runs inside AI Term, full screen, with a side note "What happens".
  - **API key:** keychain.
- **Foundry:** endpoint, key (masked, `✓ saved to the OS keychain`), deployments (comma separated), then a test table per deployment (✓ ready + api + latency, ✗ not a chat model · skipped). ⏎ on a row sets a per-deployment endpoint.
- **First run:** `ai` opens /login when no engine is logged in and no key exists.

---

### /copy and /copy all
- `/copy all` copies the selected session's parsed scrollback and screen. Wrapped rows join into logical lines. Generic cleanup removes box-drawing borders at line edges and decoration-only box/rule/spinner lines, collapses blank runs, and trims the ends. Internal borders and code indentation remain. Running/finished agents and shells work while their mirror remains in memory.
- `/copy` and empty-field c copy the same cleaned whole session until exact last reply comes from Claude's Stop hook and Codex notify in v0.2. Never guess last reply from the screen.
- Success note: `✓ copied N lines from <agent name>`, plus `(oldest lines cut at 5 MB)` when capped. `/copy` and c also add `· last reply only comes with v0.2`. No selection: `select an agent first`. Clipboard failure: `Copy failed: clipboard unavailable`, with fixed-text logging. Copied content is never drawn in a note.

### /effort and /mode
- Both accept an argument from the selected engine's documented values or open a small ↑↓/Tab/Enter/Esc picker when submitted without one. Effort always includes `CLI default`, which passes no effort option. Defaults and the start box show effort and mode before starting.
- Claude auto is its own permission mode. Codex has no distinct auto option in installed help; its menu row says auto unavailable. Don't ask uses the red `!` and remains per-session; saved permission is always Ask.

### /resume, /shell, /clean and /help
- `/resume` acts on the selected exited/failed AI agent, preserving its folder, model, auth, effort and mode. Claude continues the stored conversation UUID; older records without it show a note. Codex opens its own resume picker in that folder. A running agent or shell gets a note.
- `/shell` starts a plain login shell in the current `/cd` folder, selected with a preview afterward.
- `/clean` asks `remove N finished agents? y/n`; y removes only those exited/failed list records. n or Esc cancels. Running sessions and project files are untouched. It never deletes worktrees: the result line adds `kept N worktrees · /worktrees reviews them`.

### Worktree question and /worktrees (v0.3.2)
- **After `x`** on an agent with a worktree, one small surface box above the command bar, titled `Worktree ai/<slug>`. Lines: the folder (ink-3); the agent when shown from /worktrees (`agent <name> · <glyph> <word>`); the state; quiet notes (ink-3); the question.
  - **Clean:** `✓ nothing would be lost` (status-done), then `remove worktree and branch ai/<slug>? k keep · d delete`. Keep is the default: k, Esc and ⏎ keep.
  - **Loss:** `! would be lost: 3 changed files · 2 untracked · 4 commits not in main` (status-waiting), then `type ai/<slug> and ⏎ to delete · k or Esc keeps` and an input row `› …█`. k and ⏎ keep while the input is empty; Esc always keeps. A wrong name shows `type ai/<slug> exactly to delete` (status-error). Pastes are ignored here.
  - **Notes:** `N ignored files go with it`; `folder already deleted by hand; git still lists it`; `its base branch is gone; commits counted from where it started`; `base not recorded; compared with your checkout's <branch>`.
  - **Results** in the note line: `worktree kept: <path>`, `✓ deleted worktree and branch ai/<slug>`, `worktree kept: <path> · <fixed reason>` for a refused worktree (no question is asked), or the failed step `Worktree removed; branch delete failed · ai/<slug>`. If the worktree changed since it was shown, it is checked again and the question shows `Changed since you confirmed; check again`.
- **`/worktrees`:** a surface popup like Help, titled `Worktrees N`. Two lines per worktree: `ai/<slug>  <folder>` (bold when selected, with surface-2 fill and the accent `▎` bar), then its state with glyph and word: `✓ nothing would be lost`, `! <loss>`, `■ Worktree is locked`, `<agent glyph> <word> · Stop the agent first`, or `✗ <fixed reason>` (status-error), followed by `· agent <name> · <glyph> <word>` when its agent still exists. Footer: `↑↓ choose · ⏎ keeps or deletes · Esc closes`. ⏎ opens the same question over the list; the list reloads after it.
- Nothing animates; `checking what would be lost` and `deleting` are static lines.
- `/help` lists registry commands and the key table in a calm surface overlay. ↑↓ scrolls, PgUp/PgDn pages, Esc closes; long lines wrap at narrow widths. Homepage keys remain isolated from agents.

### /account and limits (v0.6.4, 2026-10-15)
- `/account` notes list accounts (`work · claude · default · …`); `/account add …` notes `✓ account <name> added · log in below` and opens that CLI's login session; `default`, `use` and `rm` answer in one note.
- Start box: `a` steps own login → each account of the engine; an ink-3 line `account        <name> · a` appears once one is picked. Card line 3 reads `account <name> · sub` in place of `own login · sub`; the start box model row says `account <name>` too. A question that needs you stays above a limit line.
- A limit: card line 3 `⏸ limit · resets 15:00` in status-waiting (it replaces the activity, like a question); the homepage note once: `<agent> hit its limit · resets 15:00 · wait, or /handoff <agent> claude:<account>`. Calm: no popup, no sound beyond the usual notifications.

### /handoff (v0.6.3, 2026-10-15)
- Off by default (D55: it spends tokens); `/settings` → `handoff: off · /handoff spends tokens (g)`.
- `/handoff <agent> claude|codex` opens a surface popup titled `Handoff` (the D49 ask): `Hand off <agent> → <engine>` (ink), then who writes the note (`summary by <model> · key ····last4 · it reads the end of <agent>'s screen`, or `summary written by <agent> itself, as its next reply`), then `estimated 1.0K–3.0K in · 200–2.0K out · $0.0004–$0.0022` (or `uses your plan's limits` / `price ?`), then what follows in ink-3, then `⏎ hands off · Esc cancels`. A paste never answers it.
- While it runs the note line reads `◐ handing off <agent> → <engine>`; after, `✓ handed off <agent> → <new name> · summary 2.4K in · 310 out · $0.0007` (the real numbers) or `handoff stopped: <reason>`.
- The old card's line 3 reads `handed off → <new name>` in ink-3. The new agent's name is `<agent> · <engine>`.

### /preset (v0.6.2, 2026-10-15)
- A preset is a saved start setup for one new agent; it never starts anything by itself. `/preset <name>` opens the start box filled with it (the usual accent border; ⏎ starts, Esc returns to editing); the box adds a line in ink-3 under its key hints: `preset         <name> · worktree on|off`, and the worktree line reads `worktree off · this preset` when it is off. In the start box `p` (on any row but the message row) steps to the next saved preset by name; one whose key or folder is gone shows `✗ preset <name>: …` in the error line and the box keeps what it had.
- `/preset save <name> [first message]` keeps the next agent's setup as it is now; the note says `✓ preset <name> saved`, plus ` · ! don't ask` in the same note when that was the chosen mode. `/preset` lists them in a surface popup titled `Presets` (one ink-2 row each: name · model · engine · auth · mode · folder · worktree · first message), `/preset rm <name>` notes `✓ preset <name> removed`. Off in `/settings` (`s`): `presets are off · /settings s turns them on`. Design is silent on a separate presets screen; the calmer option, a popup and a note, was chosen.

### /retry, /send, /find, /open, /doctor, /budget and /usage (2026-10-14)
- `/retry` acts on the selected exited/failed agent: a fresh start with its saved engine, model, auth, effort, mode and folder, in its worktree if that still exists. The new agent replaces the old card and is selected; the note says `✓ restarted <name> in its worktree · its first message isn't resent`. A running agent gets `<name> is still running · /retry restarts finished agents`.
- `/send <agent> <text>` (D50) is the only way homepage text reaches an agent. The name must match exactly; Tab completes and cycles running agents' names. Paste tokens go whole. Success: `✓ sent to <name>` (`· N lines` when multi-line). Refusals are one note line naming the agent: `<agent> is asking for permission, go inside to answer`, `<agent> is asking a question, go inside to answer`, `<agent> is open in a session or split · type there`, `<agent> has exited · /retry restarts it`, `<agent> may be asking to trust its folder · go inside first`, `<agent> is running a tool and may ask permission · try again when it finishes`, `too long to send (16 KB): go inside and paste`.
- **`/find <text>` popup:** a surface box like Help, titled `Find “<text>” · N` (`N+` when capped), `· searching every agent` (ink-3, static) until results arrive. One row per hit: the agent's name (ink, bold when selected, at most 18 cols), then the line (ink-2) with the match in **accent + bold**, so it reads without color too. The selected row has surface-2 fill and the accent `▎` bar. Rows follow the agent list order, newest line first inside each agent. No hits: `no matches in any agent` (ink-3). Capped: `showing the first 200 · type a longer search to narrow it` (ink-3). Footer: `↑↓ choose · ⏎ shows it in the preview · Esc closes`. ⏎ closes the popup, selects that agent (showing the preview if it was hidden) and scrolls the preview so the line sits a third of the way down; the usual `↑ N lines back` banner and End follow live apply. Plain text and any case; nothing typed is a pattern.
- `/open` and `/open code` act on the selected agent's folder (its worktree root when it has one; a folder name with an extension is revealed, not launched): `opened <path> in Finder` / `in VS Code`, or a one-line reason (`VS Code's code command isn't on PATH · <path>`, `folder is gone · <path>`).
- `/doctor` shows the `ai doctor` lines in a surface popup titled `Doctor`, `· checking Node, the daemon, files and the CLIs` until they arrive. `/usage` is `u`; `/budget` is `b`. These popups scroll with ↑↓/PgUp/PgDn and close with Esc.
- A damaged agent list (B24) shows the note `couldn't read your agent list; saved it as <file>` (ink-3, the ordinary note line) each time a homepage opens until the background service restarts. It is a note, not a warning, so it never hides other notes; the next note replaces it.

## Inside a session

- **v0.1, full screen:** AI Term draws nothing; the agent owns every cell. **Ctrl+E** goes to the homepage and the agent keeps running.
- **v0.2, frame bar:** one row on top, surface background.
  - **Left:** status glyph + word + name (bold) + `engine · model`. Worktree agents append `· ai/<slug>`.
  - **Right:** `others ◐ 2  ✓ 1  ✗ 1` + `^E home`.
  - Opt-in with `/settings` → `bar: on` (`h`); default off while the Terminal.app spike exit remains unexplained. Off is full-height raw passthrough. Failed startup probe falls back to raw for that attach.
  - The agent gets one row less and follows terminal resizes. Counts drop first at narrow widths, then branch, then model; glyph and status word remain. Nothing animates; redraw only when text/cells change.
- **v0.3, splits:** panes side by side, each with a one-row header (glyph, name, model, branch); the focused pane's header is surface-2 with an accent underline. The bottom row shows `each pane is its own agent in its own worktree` and the pane keys.
  - **Opening (2026-10-14):** Space marks or unmarks the selected agent; its card shows `◆ marked` (accent, bold) at the end of line 3, and the note line counts `N marked · v opens them side by side` (`Space marks one more` at one). At most 4; an exited or failed agent can't be marked. `v` opens the marked agents in list order and clears the marks. With none marked, `v` reopens the split Ctrl+E left, or shows `Space marks 2–4 agents · v opens them side by side`. Both keys act only while the command field is empty.
  - **Layout:** 2 or 3 panes side by side, 4 as 2×2. Side-by-side panes are separated by a one-column `│` divider in `line` (calmer than touching bodies; the lower headers separate the 2×2 rows). Each pane is at least **40 columns × 10 rows**, header included; the agent gets the rows under its header. Three panes too wide to sit side by side take two on top and one full width below (so closing one of four never hides the rest). Too small for all of them: as many panes as fit open, and the bottom row starts with `N agents didn't fit` (status-waiting); if only one fits it is a normal attach. A window resized below the panes' minimum shows only `make the window bigger · ^E home` until it grows; nothing is typed meanwhile.
  - **Headers:** glyph + status word (status color), bold name, `model · ai/<slug>` (ink-2). Unfocused headers are surface. Model and branch drop first when narrow. An ended agent's header reads `■ exited · exit 0` or `✗ failed · exit 1` with `^\ closes` on the right; a pane another client took over reads `■ attached elsewhere`.
  - **Bottom row:** `each pane is its own agent in its own worktree` (ink-3) left, `^\ next pane · ^\ ^\ sends ^\ · ^E home` (ink-3) right.
  - **Keys:** typing and paste go to the focused pane only. **Ctrl+\** focuses the next pane, or closes ended panes when there are any; twice within 0.4 s sends one real Ctrl+\ to the agent that was focused. (Not Ctrl+]: Claude Code binds it by default.) A click focuses the pane under the pointer and reaches that agent in its coordinates; mouse input only ever reaches the focused pane, so wheel or motion over another pane does nothing until it's clicked (v0.3 gate). **Ctrl+E** goes home and the split is remembered for `v`. One pane left becomes a normal attach.
  - Nothing animates; background panes redraw at most 30 times a second, the focused pane at once.

## Keyboard (homepage)

| Keys | Action |
|---|---|
| ↑ ↓ | slash menu: highlighted command; otherwise select agent (preview follows) |
| ⏎ | empty field: go inside the selected agent · with text: start a new agent |
| p | hide / show preview (only when the command field is empty) |
| c / /copy / /copy all | cleaned whole session; c and /copy disclose last reply comes with v0.2; c only shortcuts in an empty field |
| PgUp PgDn · End | scroll the preview · follow live (End: empty field only; otherwise cursor to end) |
| d / r / s | diff (v0.7) / rename / stop the selected agent (s asks first) |
| x | remove an exited or failed agent from the list, then keep or delete its worktree (keep is the default) |
| Space / v | mark or unmark the selected agent for a split / open the marked agents side by side (none marked: reopen the last split) |
| b / u | budget / usage details (also `/budget`, `/usage`) |
| /retry · /send · /find · /open · /doctor | restart a finished agent · send text to a running one · search every agent · open its folder · the doctor report |
| / / Tab | command menu / complete selected command and cycle argument values |
| /help ↑↓ / PgUp / PgDn / Esc | scroll / page up / page down / close |
| Esc | close a popup; clear the field |
| Ctrl+C twice | quit `ai` (agents keep running) |

Letter keys act as shortcuts only while the command field is empty; otherwise they type.

## Motion

- Nothing animates.
- Redraws happen only on change, and the preview at most 30 times a second.
- No spinners: `◐` is static.
- The sparkline moves because the data moves, every 1 s (D46).
- If an effect costs redraw time, it goes.

## macOS desktop window

The app uses a hidden native title bar with traffic lights inset 16 px from the left and 14 px from the top. A 40 px draggable chrome strip sits above the terminal, which starts at 48 px including its 8 px top padding. Chrome uses the system sans font from the tokens; the terminal uses the approved installed JetBrains Mono → SF Mono → Menlo → system monospace chain. No font is distributed. **App fonts (v1.2.6, `/settings` → app fonts, `F`):** a terminal family and size (9–32, default 13) apart from a chrome family and size (11–26, default 13, the chrome-body token; the title strip now uses it), each family put first in its token chain as one quoted name (letters, digits, spaces, dots, dashes, underscores), and ligatures on/off (default off). ⌘+/⌘− zoom on top of the saved size; ⌘0 goes back to it. A terminal running `ai` keeps its own font. The first launch shows one quiet line: “Closing or quitting keeps your agents running.” Later launches show AI Term. No animation or vibrancy.

Light/dark/system is in View. The window, its chrome and xterm wear the saved theme (v1.2.6): the app's main process reads the saved theme, its variant and the app fonts from settings.json (and a theme file of your own from the themes folder), watches both, and sends the window a checked look; a system variant follows the native appearance. Each change updates the window/xterm colors first; `ai` then probes OSC 11 again, reads the saved theme and redraws. Attached AI Term bars and split chrome share the live theme; the agents' own colors remain their own output.

Native menu shortcuts: ⌘K command palette, ⌘F scrollback Find, ⌘T Start a new agent, ⌘1–9 homepage selection in displayed order, ⌘D marked split, ⌘E home, ⌘, Settings. These dismiss existing forms without confirming them. Edit has ⌘C Copy, ⌘V Paste, ⌘A Select All; search-field selection follows the same actions. View has ⌘+/⌘−/⌘0 font size and appearance; Window has ⌘M Minimize and Zoom. App has About, Settings, Hide/Hide Others (⌘H/⌥⌘H), Quit (⌘Q); File has Close (⌘W). Closing or quitting only ends the outer client, keeping agents in the daemon. Other terminal keys, including Option as Meta, are unchanged.

Ligatures (v1.2.6) come without an addon: while they are on, a character joiner draws the usual programming sequences (`=>`, `!==`, `->`, `<=`, `&&`, `::` …) as one unit, so a font that has them can form them; a font without them looks as before, and off registers nothing. With ligatures on and the terminal's first family not installed (measured on a canvas against the generic fallbacks; nothing is loaded), the title strip reads `<family> isn't installed, so ligatures can't show` in place of its usual text. Solid token surfaces preserve predictable contrast; no zero-cost vibrancy claim is made. No provider names or logos are added to the app menus/chrome (D51).
