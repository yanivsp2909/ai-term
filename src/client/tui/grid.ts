import type { Theme } from './theme.js';
import { styleEscape } from './theme.js';
export interface Cell { char: string; fg: string; bg: string; bold: boolean; width: number; italic?: boolean; underline?: boolean; dim?: boolean }
export type Frame = Cell[][];
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
export function graphemes(text: string): string[] { return Array.from(segmenter.segment(text), s => s.segment); }
export function cellWidth(text: string): number {
  if (/^\p{Mark}/u.test(text)) return 0;
  return /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}|\uFE0F/u.test(text) ? 2 : 1;
}
export function safeText(text: string): string { return text.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, ''); }
export class Grid {
  readonly cells: Frame;
  constructor(readonly cols: number, readonly rows: number, readonly theme: Theme) {
    const blank: Cell = { char: ' ', fg: theme.colors.ink, bg: theme.colors.bg, bold: false, width: 1 };
    this.cells = Array.from({ length: rows }, () => Array<Cell>(cols).fill(blank));
  }
  put(x: number, y: number, cell: Cell): void { const row = this.cells[y]; if (row && x >= 0 && x < this.cols) row[x] = cell; }
  fill(x: number, y: number, w: number, h: number, bg: string): void {
    const cell: Cell = { char: ' ', fg: this.theme.colors.ink, bg, bold: false, width: 1 };
    for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) this.put(c, r, cell);
  }
  text(x: number, y: number, value: string, fg = this.theme.colors.ink, bg = this.theme.colors.bg, bold = false, limit = this.cols - x, dim = false): number {
    const start = x;
    for (const char of graphemes(safeText(value))) {
      const width = cellWidth(char); if (!width || x + width > start + limit) break;
      this.put(x, y, { char, fg, bg, bold, width, dim });
      if (width === 2) this.put(x + 1, y, { char: '', fg, bg, bold, width: 0, dim });
      x += width;
    }
    return x;
  }
  box(x: number, y: number, w: number, h: number, title: string, bg = this.theme.colors.bg): void {
    if (w < 2 || h < 2) return;
    this.fill(x, y, w, h, bg);
    this.text(x, y, `╭${'─'.repeat(w - 2)}╮`, this.theme.colors.line, bg);
    this.text(x, y + h - 1, `╰${'─'.repeat(w - 2)}╯`, this.theme.colors.line, bg);
    for (let r = y + 1; r < y + h - 1; r++) { this.text(x, r, '│', this.theme.colors.line, bg); this.text(x + w - 1, r, '│', this.theme.colors.line, bg); }
    if (title) this.text(x + 2, y, ` ${title} `, this.theme.colors['ink-2'], bg, true, w - 4);
  }
}
export function plainText(frame: Frame): string { return frame.map(row => row.filter(cell => cell.width !== 0).map(cell => cell.char).join('').trimEnd()).join('\n'); }
export function diffFrame(next: Frame, previous: Frame | null, theme: Theme, truecolor = true): string {
  let output = previous ? '' : '\x1b[2J';
  for (let y = 0; y < next.length; y++) {
    let positioned = false, lastStyle = '';
    const row = next[y]; if (!row) continue;
    for (let x = 0; x < row.length; x++) {
      const cell = row[x], before = previous?.[y]?.[x];
      if (!cell || cell.width === 0) continue;
      if (before && cell.char === before.char && cell.fg === before.fg && cell.bg === before.bg && cell.bold === before.bold && cell.width === before.width && cell.italic === before.italic && cell.underline === before.underline && cell.dim === before.dim) { positioned = false; continue; }
      if (!positioned) output += `\x1b[${y + 1};${x + 1}H`;
      const style = styleEscape(cell, theme, truecolor); if (lastStyle !== style) { output += style; lastStyle = style; }
      output += safeText(cell.char); positioned = true;
      if (cell.width === 2) x++;
    }
  }
  return output ? `\x1b[?2026h${output}\x1b[0m\x1b[?2026l` : '';
}
