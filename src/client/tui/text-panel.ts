import type { Frame } from './grid.js';
import type { Theme } from './theme.js';
import { wrapHelpLines } from './help.js';
import { overlay, type Line } from './worktree-question.js';

// A read-only surface popup of lines, like Help (/doctor, /usage): ↑↓ scroll, PgUp/PgDn page, Esc closes. Until its
// lines arrive it shows one static `· checking` line; nothing animates.
export class TextPanel {
  private offset = 0;
  private page = 1;
  private lines: Line[] | null = null;
  constructor(private readonly title: string, private readonly changed: () => void, private readonly close: () => void, private readonly waiting = '· checking') {}
  set(lines: Line[]): void { this.lines = lines; this.changed(); }
  resetScroll(): void { this.offset = 0; }
  key(key: string): void {
    if (key === 'escape') { this.close(); return; }
    const delta = key === 'up' ? -1 : key === 'down' ? 1 : key === 'page-up' ? -this.page : key === 'page-down' ? this.page : 0;
    if (!delta) return;
    this.offset = Math.max(0, this.offset + delta); this.changed();
  }
  draw(frame: Frame, theme: Theme): Frame {
    const grid = overlay(frame, theme), w = Math.min(grid.cols, 110), h = Math.max(8, grid.rows - 4), x = Math.floor((grid.cols - w) / 2), y = 1, width = w - 6, surface = theme.colors.surface;
    const rows = (this.lines ?? [{ text: this.waiting, tone: 'ink-3' as const }]).flatMap(line => wrapHelpLines([line.text], width).map(text => ({ text, tone: line.tone })));
    this.page = Math.max(1, h - 4);
    this.offset = Math.min(this.offset, Math.max(0, rows.length - this.page));
    grid.box(x, y, w, h, this.title, surface);
    rows.slice(this.offset, this.offset + this.page).forEach((row, i) => grid.text(x + 3, y + 1 + i, row.text, theme.colors[row.tone], surface, false, width));
    grid.text(x + 3, y + h - 2, rows.length > this.page ? '↑↓ scroll · PgUp/PgDn page · Esc closes' : 'Esc closes', theme.colors['ink-3'], surface, false, width);
    return grid.cells;
  }
}
