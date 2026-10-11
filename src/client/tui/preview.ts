import headless from '@xterm/headless';
import { cellColor, mix, type Theme } from './theme.js';
import { safeText, type Frame } from './grid.js';
export interface Point { x: number; y: number }
export class Preview {
  readonly terminal: headless.Terminal;
  private anchor: number | null = null;
  private newCount = 0;
  private selection: { start: Point; end: Point } | null = null;
  private disposed = false;
  private totalLines = 0;
  private queue: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  constructor(cols: number, rows: number, private readonly changed: () => void) {
    this.terminal = new headless.Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
    // Count scrolls even when the bounded buffer trims its oldest line.
    this.terminal.onLineFeed(() => { const b = this.terminal.buffer.active; if (b.cursorY === this.terminal.rows - 1) this.totalLines++; });
  }
  get top(): number { return this.anchor ?? this.terminal.buffer.active.baseY; }
  get linesBack(): number { return this.anchor === null ? 0 : this.terminal.buffer.active.baseY - this.anchor; }
  get newLines(): number { return this.newCount; }
  write(data: Buffer | string): Promise<void> {
    this.queuedBytes += Buffer.byteLength(data);
    if (this.queuedBytes > 8 * 1024 * 1024) return Promise.reject(new Error('Preview queue exceeded; reopen the homepage'));
    const task = this.queue.then(async () => {
      if (this.disposed) return;
      const oldBase = this.terminal.buffer.active.baseY, oldLines = this.totalLines;
      await new Promise<void>(resolve => this.terminal.write(data, resolve));
      if (this.disposed) return;
      if (this.anchor !== null) {
        const added = Math.max(0, this.totalLines - oldLines), growth = this.terminal.buffer.active.baseY - oldBase;
        this.anchor = Math.max(0, this.anchor - Math.max(0, added - growth)); this.newCount += added;
      }
      this.changed();
    }).finally(() => { this.queuedBytes -= Buffer.byteLength(data); });
    this.queue = task; return task;
  }
  scroll(lines: number): void {
    const base = this.terminal.buffer.active.baseY;
    this.anchor = Math.max(0, Math.min(base, this.top + lines));
    if (this.anchor === base) { this.anchor = null; this.newCount = 0; }
    this.selection = null; this.changed();
  }
  follow(): void { this.anchor = null; this.newCount = 0; this.selection = null; this.changed(); }
  select(start: Point, end: Point): void { this.selection = { start: { ...start, y: start.y + this.top }, end: { ...end, y: end.y + this.top } }; this.changed(); }
  clearSelection(): void { this.selection = null; this.changed(); }
  private bounds(): { start: Point; end: Point } | null {
    if (!this.selection) return null;
    const { start, end } = this.selection;
    return start.y * this.terminal.cols + start.x <= end.y * this.terminal.cols + end.x ? { start, end } : { start: end, end: start };
  }
  selectedText(): string {
    const bounds = this.bounds(); if (!bounds) return '';
    const lines: string[] = [];
    for (let y = bounds.start.y; y <= bounds.end.y; y++) {
      const first = y === bounds.start.y ? bounds.start.x : 0, last = y === bounds.end.y ? bounds.end.x + 1 : this.terminal.cols;
      lines.push(safeText(this.terminal.buffer.active.getLine(y)?.translateToString(true, first, last) ?? ''));
    }
    return lines.join('\n');
  }
  cells(theme: Theme, cols: number, rows: number): Frame {
    const bounds = this.bounds();
    return Array.from({ length: rows }, (_, y) => {
      const absoluteY = this.top + y, line = this.terminal.buffer.active.getLine(absoluteY);
      return Array.from({ length: cols }, (_, x) => {
        const cell = line?.getCell(x); let fg = theme.colors.ink, bg = theme.colors.surface;
        if (cell) { fg = cellColor(cell, true, theme); bg = cellColor(cell, false, theme); if (cell.isInverse()) [fg, bg] = [bg, fg]; }
        const selected = bounds && absoluteY >= bounds.start.y && absoluteY <= bounds.end.y && (absoluteY !== bounds.start.y || x >= bounds.start.x) && (absoluteY !== bounds.end.y || x <= bounds.end.x);
        if (selected) bg = mix(bg, theme.colors.accent, 0.38);
        return { char: safeText(cell?.getChars() || ' '), width: cell?.getWidth() ?? 1, fg, bg, bold: Boolean(cell?.isBold()), italic: Boolean(cell?.isItalic()), underline: Boolean(cell?.isUnderline()), dim: Boolean(cell?.isDim()) };
      });
    });
  }
  resize(cols: number, rows: number): void { this.terminal.resize(cols, rows); this.follow(); }
  dispose(): void { this.disposed = true; this.terminal.dispose(); }
}
