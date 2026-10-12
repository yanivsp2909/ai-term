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

**Palette setting** (`/settings` → theme), chosen by Yaniv on 2026-10-11 after trying each live in Terminal.app:
- **`graphite`** (default): the dark column above. Neutral charcoal.
- **`slate`:** blue-gray. bg `#1B2029`, surface `#232935`, surface-2 `#2D3443`, line `#46506A`, ink `#E6EAF0`, ink-2 `#AEB6C4`, ink-3 `#9AA4B5`, accent `#58D6C9`.
- **`ink`:** the original darkest. bg `#111317`, surface `#191C21`, surface-2 `#242830`, line `#3A3F48`, ink `#E6E8EB`, ink-2 `#A3A9B4`, ink-3 `#8E96A3`, accent `#4FD1C5`.
- **`auto`** ("match my terminal"):
  - The background is never painted (SGR 49), so it is exactly the terminal's own color.
  - At startup, the terminal is asked for its background (OSC 11, 200 ms timeout). Panels are derived from it: surface = 5% toward white, surface-2 = 11%, line = 24%. On a light background, mix toward black instead and use the light text tokens.
  - No reply: slate.
  - The rules are in `spikes/renderer/theme.js`.
- **`light`:** the light column.

Status colors and on-accent are the same across the dark palettes: waiting `#F5BC55`, error `#F47B7E`, done = ink-2.

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
  - Logo badge: 4 cols × 2 rows, surface-2 fill, two bold letters (CL Claude, GP GPT, KI Kimi, GR Grok, DS DeepSeek, GL GLM). Real logos come in the app (v0.5) and in terminals with image support.
  - Line 1: name (bold when selected), right-aligned status glyph + word + age (`4m`, `2h`, `3d`).
  - Line 2: `model · engine` (ink-2), right-aligned `ctx NN%` (ink-3; status-waiting from 85%). ctx appears only when the engine reports it (v0.2+).
  - Line 3, auth for Claude/Codex: `own login · sub`, `own login · API key`, `own login`, or `API key ····last4`. Their status word stays on line 1; a red `!` marks Don't ask, with its full word in the selected preview title. Debug shell cards keep their existing activity line. Later activity details follow:
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
  - `tokens` row: ink-2, compact (`1.9M`).
  - `budget` row: the limit per period or `none`, with `b add` (key cap + accent) at the end.
- **Scope:** API-key sessions only. Subscription sessions aren't counted.
- **`u`:** opens Usage details (by provider, by model, by agent; v0.1 can ship without it).

### This Mac panel (under the preview, right, 36 cols)
- **CPU:** `CPU 31%` (bold value), a 10-sample sparkline in accent (`▁▂▃▄▅▆▇█`), right `agents 19%`.
- **RAM:** `RAM 14.2/32 GB`, right `agents 2.3 GB`.
- **NET:** `NET ↓ 1.4 MB/s  ↑ 200.0 KB/s` (machine-wide). Each rate uses B/s, KB/s or MB/s with one decimal.
- Updated every 1 s, and only while the homepage is open (D46).

### Command bar
- **Field:** surface background with a line border. `›` in accent, your text, block cursor. Placeholder: `What do you want to build?` (ink-3).
- **Line under it:** left, the defaults for the next agent: `model · engine   folder   auth   permission   worktree` (worktree appears from v0.3). Auth uses the next agent's `own login · sub/API key` or `key ····last4`; folder is clipped before auth. Right, the key hints. Keys appear only here, not repeated in panels.
- **⏎ with text:** opens the **Start a new agent** box (below).
- **⏎ with an empty field:** goes inside the selected agent.
- **`/` at the start:** opens the filtered command menu. ↑↓ moves the selected-card highlight through commands, wrapping; typing resets to the first match. ⏎ picks the highlighted command; `/theme` inserts `/theme ` for its argument. Esc closes. Outside the menu ↑↓ selects agents.

### Start a new agent (box over the command bar)
- **Box:** surface fill, accent border, title `Start a new agent`. Rows: model (+ `/model`), folder (+ `/cd`), branch (`auto` from v0.3), mode (`ask` · ⇥ toggles to `don't ask`, shown in status-error with `!`), first message ("your text above is its first message").
- **Keys:** ⏎ starts, Esc returns to editing.
- **After starting:** the new agent is selected and the preview shows it starting.

### /model picker
- **Popup:** surface box, title `Select model`, provider tabs on its top row, then filter and models.
- **Tabs:** `ANTHROPIC · OPENAI · FOUNDRY · <resource>`; one Foundry tab per configured resource. Future keyed providers get their own tab. Opens on the current selected/default model's provider.
- **Keys:** ←→ switch provider (Tab also moves right); ↑↓ select a model inside that provider; ⏎ selects; Esc returns without changing the selection.
- **Filter:** typing searches model names across all providers, jumps to the first matching provider, and selects its first result. All provider tabs remain available. A custom valid ID in an Anthropic/OpenAI tab uses the CLI's own login; Foundry only lists tested ready deployments.
- **Each row:** `model · engine · auth`. CLI-managed auth is `own login · sub`, `own login · API key`, or `own login` when unknown. Saved key rows stay `key ····last4`.
- **Footer:** `own login → official CLI · API key → Claude Code / Codex` until v0.4.

### /cd
A path field with completion. It sets the folder for the next agent only. A folder that doesn't exist or isn't a directory is an inline error.

### /settings
- **Popup** with sections:
  - **KEYS** (OS keychain): label, endpoint, `key ····last4`, plus `+ add key` (paste, or import from .env).
  - **ENGINES:** Claude Code / Codex, each with `✓ installed` and `✓ logged in` (or `✗ not logged in` with `/login`).
  - **DEFAULTS:** model, folder, permissions (`ask` only; don't ask is per agent), theme, copy on select, budget.
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

## Inside a session

- **v0.1, full screen:** AI Term draws nothing; the agent owns every cell. **Ctrl+E** goes to the homepage and the agent keeps running.
- **v0.2, frame bar:** one row on top, surface background.
  - **Left:** status glyph + name (bold) + `engine · model` + `· branch`.
  - **Right:** `others ◐ 2  ✓ 1  ✗ 1` + `^E home`.
  - The agent gets one row less.
- **v0.3, splits:** panes side by side, each with a one-row header (glyph, name, model, branch); the focused pane's header is surface-2 with an accent underline. The bottom row shows `each pane is its own agent in its own worktree` and the pane keys.

## Keyboard (homepage)

| Keys | Action |
|---|---|
| ↑ ↓ | slash menu: highlighted command; otherwise select agent (preview follows) |
| ⏎ | empty field: go inside the selected agent · with text: start a new agent |
| p | hide / show preview (only when the command field is empty) |
| PgUp PgDn · End | scroll the preview · follow live |
| d / r / s | diff (v0.7) / rename / stop the selected agent (s asks first) |
| x | remove an exited or failed agent from the list |
| b / u | budget / usage details |
| / | command menu |
| Esc | close a popup; clear the field |
| Ctrl+C twice | quit `ai` (agents keep running) |

Letter keys act as shortcuts only while the command field is empty; otherwise they type.

## Motion

- Nothing animates.
- Redraws happen only on change, and the preview at most 30 times a second.
- No spinners: `◐` is static.
- The sparkline moves because the data moves, every 1 s (D46).
- If an effect costs redraw time, it goes.
