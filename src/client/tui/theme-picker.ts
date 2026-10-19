import type { Frame } from './grid.js';
import type { Theme } from './theme.js';
import { overlay } from './worktree-question.js';
import { BUILTIN_THEMES } from '../../shared/theme-tokens.js';
import type { ThemeName, ThemeVariantSetting } from '../../shared/protocol.js';
import type { ThemeList } from '../../shared/user-themes.js';

// v1.2.6 /theme: the themes in a small box at the top right, so the homepage behind stays in view; the homepage redraws
// in whichever one is highlighted (the homepage does that through preview()). ↑↓ picks a theme, ←→ its variant;
// ⏎ keeps the one shown, Esc goes back to the saved one. Static: nothing animates, each key is one redraw.
export interface ThemeChoice { name: ThemeName; variant: ThemeVariantSetting }
export interface ThemePickerActions { preview(choice: ThemeChoice): void; pick(choice: ThemeChoice): void; cancel(): void }
const VARIANTS: readonly ThemeVariantSetting[] = ['dark', 'light', 'system'];
const FOOTER = '↑↓ theme · ←→ dark, light or system · ⏎ picks · Esc goes back';
interface Row { name: ThemeName; label: string }
export class ThemePicker {
  private readonly rows: Row[];
  private index: number;
  private variant: ThemeVariantSetting;
  private readonly saved: ThemeName;
  constructor(private readonly list: ThemeList, current: ThemeChoice, private readonly actions: ThemePickerActions) {
    this.rows = [...BUILTIN_THEMES.map(t => ({ name: t.id, label: t.name })), ...list.themes.map(t => ({ name: t.name, label: `${t.label} · your file` })), { name: 'auto', label: 'Match my terminal' }];
    // light is the old name of graphite light.
    this.saved = current.name === 'light' ? 'graphite' : current.name;
    this.variant = current.name === 'light' ? 'light' : current.variant;
    this.index = Math.max(0, this.rows.findIndex(r => r.name === this.saved));
  }
  choice(): ThemeChoice { return { name: this.rows[this.index]?.name ?? 'graphite', variant: this.variant }; }
  key(key: string): void {
    if (key === 'escape') { this.actions.cancel(); return; }
    if (key === 'enter') { this.actions.pick(this.choice()); return; }
    if (key === 'up' || key === 'down') { this.index = (this.index + (key === 'up' ? -1 : 1) + this.rows.length) % this.rows.length; this.actions.preview(this.choice()); return; }
    if ((key === 'left' || key === 'right') && this.choice().name !== 'auto') {
      const next = VARIANTS.indexOf(this.variant) + (key === 'left' ? -1 : 1);
      const variant = VARIANTS[next];
      if (!variant) return;
      this.variant = variant; this.actions.preview(this.choice());
    }
  }
  draw(frame: Frame, theme: Theme): Frame {
    const grid = overlay(frame, theme), c = theme.colors, surface = c.surface;
    const w = Math.min(grid.cols - 2, 72), inner = w - 4, refused = this.list.refused, h = this.rows.length + refused.length + 6;
    const x = Math.max(0, grid.cols - w - 1), y = 1;
    grid.box(x, y, w, h, 'Theme', surface);
    grid.text(x + 2, y + 1, 'the homepage behind shows the highlighted one', c['ink-3'], surface, false, inner);
    this.rows.forEach((row, i) => {
      const selected = i === this.index, bg = selected ? c['surface-2'] : surface, line = y + 3 + i;
      if (selected) grid.fill(x + 1, line, w - 2, 1, bg);
      const name = `${selected ? '›' : ' '} ${row.label}${row.name === this.saved ? ' · in use' : ''}`;
      const end = grid.text(x + 2, line, name, selected ? c.ink : c['ink-2'], bg, selected, inner);
      if (!selected) return;
      const hint = row.name === 'auto' ? 'its own background, no variant' : VARIANTS.map(v => v === this.variant ? `[${v}]` : v).join(' · ');
      const start = Math.max(end + 2, x + w - 2 - [...hint].length);
      grid.text(start, line, hint, c.accent, bg, false, Math.max(0, x + w - 2 - start));
    });
    refused.forEach((r, i) => { grid.text(x + 2, y + 3 + this.rows.length + i, `✗ ${r.file} refused · ${r.reason}`, c['status-error'], surface, false, inner); });
    grid.text(x + 2, y + h - 2, FOOTER, c['ink-3'], surface, false, inner);
    return grid.cells;
  }
}
