import headless, { type IMarker } from '@xterm/headless';
import { cellColor, mix, type Theme } from './theme.js';
import { safeText, type Frame } from './grid.js';
import { useUnicode11 } from '../../shared/unicode-width.js';
export interface Point { x: number; y: number }
export class Preview {
  readonly terminal: headless.Terminal;
  private anchor: IMarker | null = null;
  private newCount = 0;
  private selection: { start: Point; end: Point } | null = null;
  private disposed = false;

  private queue: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private scrollCount = 0;
  private clearScrollback = false;
  // v0.9.3 performance pass: the last cells, reused until the screen, scroll, selection, size or theme changes (they were
  // rebuilt, a regex per cell, on every homepage draw up to 30 a second).
  private version = 0;
  private cached: { theme: Theme; cols: number; rows: number; version: number; frame: Frame } | null = null;
  private touch(): void { this.version++; this.changed(); }
  constructor(cols: number, rows: number, private readonly changed: () => void) {
    this.terminal = new headless.Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
    useUnicode11(this.terminal);
    let previousBase = 0;
    this.terminal.onScroll(base => {
      if (this.terminal.buffer.active.type === 'normal' && base >= previousBase) this.scrollCount++;
      previousBase = base;
    });
    this.terminal.parser.registerCsiHandler({ final: 'J' }, params => { if (params[0] === 3) this.clearScrollback = true; return false; });

  }
  get top(): number { return this.anchor ? Math.max(0, this.anchor.line) : this.terminal.buffer.active.baseY; }
  get linesBack(): number { return this.anchor === null ? 0 : Math.max(0, this.terminal.buffer.active.baseY - this.top); }
  get newLines(): number { return this.newCount; }
  write(data: Buffer | string): Promise<void> {
    if (this.queuedBytes + Buffer.byteLength(data) > 8 * 1024 * 1024) return Promise.reject(new Error('Preview queue exceeded; reopen the homepage'));
    this.queuedBytes += Buffer.byteLength(data);
    const task = this.queue.then(async () => {
      if (this.disposed) return;
      const buffer = this.terminal.buffer.active, oldScroll = this.scrollCount;
      // Markers keep the viewport anchored; onScroll counts even after those markers trim.
      this.clearScrollback = false;
      await new Promise<void>(resolve => this.terminal.write(data, resolve));
      if (this.disposed) return;
      if (this.terminal.buffer.active !== buffer || this.clearScrollback) this.follow();
      if (this.anchor !== null) this.newCount += this.scrollCount - oldScroll;
      this.selection = null;
      this.touch();
    }).finally(() => { this.queuedBytes -= Buffer.byteLength(data); });
    this.queue = task; return task;
  }
  scroll(lines: number): void {
    const base = this.terminal.buffer.active.baseY;
    const top = Math.max(0, Math.min(base, this.top + lines));
    this.anchor?.dispose();
    this.anchor = top === base ? null : this.terminal.registerMarker(top - base - this.terminal.buffer.active.cursorY) ?? null;
    if (top === base) this.newCount = 0;
    this.selection = null; this.touch();
  }
  // /find: bring a hit into view, a third of the way down. `fromEnd` counts rows up from the buffer's last row when the
  // daemon searched (this buffer holds a different amount of scrollback, but its bottom is the same); an agent that
  // printed since moved the line up, so the row nearest that guess holding the matched text wins.
  scrollTo(fromEnd: number, text = ''): void {
    const buffer = this.terminal.buffer.active, guess = Math.max(0, buffer.length - 1 - fromEnd), needle = text.toLowerCase();
    // A row and the next one, so a match across a soft wrap is still found.
    const holds = (row: number) => ((buffer.getLine(row)?.translateToString(true) ?? '') + (buffer.getLine(row + 1)?.isWrapped ? buffer.getLine(row + 1)?.translateToString(true) ?? '' : '')).toLowerCase().includes(needle);
    let row = guess;
    if (needle) for (let distance = 0; distance < buffer.length; distance++) {
      if (guess - distance >= 0 && holds(guess - distance)) { row = guess - distance; break; }
      if (guess + distance < buffer.length && holds(guess + distance)) { row = guess + distance; break; }
    }
    this.scroll(Math.max(0, row - Math.floor(this.terminal.rows / 3)) - this.top);
  }
  follow(): void { this.anchor?.dispose(); this.anchor = null; this.newCount = 0; this.selection = null; this.touch(); }
  select(start: Point, end: Point): void { this.selection = { start: { ...start, y: start.y + this.top }, end: { ...end, y: end.y + this.top } }; this.touch(); }
  clearSelection(): void { this.selection = null; this.touch(); }
  private bounds(): { start: Point; end: Point } | null {
    if (!this.selection) return null;
    const { start, end } = this.selection;
    return start.y * this.terminal.cols + start.x <= end.y * this.terminal.cols + end.x ? { start, end } : { start: end, end: start };
  }
  selectedText(visibleCols = this.terminal.cols): string {
    const bounds = this.bounds(); if (!bounds) return '';
    const lines: string[] = [];
    for (let y = bounds.start.y; y <= bounds.end.y; y++) {
      const first = y === bounds.start.y ? bounds.start.x : 0, last = y === bounds.end.y ? Math.min(visibleCols, bounds.end.x + 1) : Math.min(visibleCols, this.terminal.cols);
      lines.push(safeText(this.terminal.buffer.active.getLine(y)?.translateToString(true, first, last) ?? ''));
    }
    return lines.join('\n');
  }
  cells(theme: Theme, cols: number, rows: number): Frame {
    const cached = this.cached;
    if (cached && cached.theme === theme && cached.cols === cols && cached.rows === rows && cached.version === this.version) return cached.frame;
    const frame = this.build(theme, cols, rows);
    this.cached = { theme, cols, rows, version: this.version, frame };
    return frame;
  }
  private build(theme: Theme, cols: number, rows: number): Frame {
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
  resize(cols: number, rows: number): void { this.terminal.resize(cols, rows); this.version++; this.follow(); }
  dispose(): void { this.disposed = true; this.terminal.dispose(); }
}
