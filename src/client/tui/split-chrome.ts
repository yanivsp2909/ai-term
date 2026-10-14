import type { SessionInfo } from '../../shared/protocol.js';
import { textWidth } from '../../shared/unicode-width.js';
import type { PaneState } from '../split-pane.js';
import type { SplitLayout } from '../split-layout.js';
import { marks } from './agent-card.js';
import { Grid, type Frame } from './grid.js';
import type { ColorName, Theme } from './theme.js';

export interface ChromePane { info: SessionInfo; state: PaneState; focused: boolean }
export const SPLIT_NOTE = 'each pane is its own agent in its own worktree';
export const SPLIT_KEYS = '^\\ next pane · ^\\ ^\\ sends ^\\ · ^E home';
interface Piece { text: string; color: ColorName; bold?: boolean }
// A pane header: glyph + status word, name, model and branch (design.md, Inside a session v0.3). An exited pane says how
// it ended and that Ctrl+\ closes it. The model and branch go first when the pane is narrow; glyph and word never do.
export function headerPieces(pane: ChromePane): { left: Piece[]; right: string } {
  const { info, state } = pane;
  if (state === 'elsewhere') return { left: [{ text: '■ attached elsewhere', color: 'ink-3' }, { text: info.title, color: 'ink', bold: true }], right: '^\\ closes' };
  const [glyph, color, word] = marks[info.status], ended = state === 'exited';
  const status = ended && info.exitCode !== null ? `${glyph} ${word} · exit ${info.exitCode}` : `${glyph} ${word}`;
  const model = info.engine === 'shell' ? 'shell' : info.model ?? 'CLI default';
  return { left: [{ text: status, color, bold: info.status === 'waiting' }, { text: info.title, color: 'ink', bold: true }, { text: info.branch ? `${model} · ${info.branch}` : model, color: 'ink-2' }], right: ended ? '^\\ closes' : '' };
}
function drawHeader(grid: Grid, x: number, y: number, w: number, pane: ChromePane, theme: Theme): void {
  const bg = pane.focused ? theme.colors['surface-2'] : theme.colors.surface, { left, right } = headerPieces(pane);
  grid.fill(x, y, w, 1, bg);
  const rightW = right ? textWidth(right) + 2 : 0;
  let pieces = left;
  const width = (list: Piece[]) => list.reduce((n, p) => n + textWidth(p.text) + 2, 0) + 1;
  while (pieces.length > 1 && width(pieces) + rightW > w) pieces = pieces.slice(0, -1);
  let cursor = x + 1;
  for (const piece of pieces) cursor = grid.text(cursor, y, piece.text, theme.colors[piece.color], bg, piece.bold ?? false, x + w - rightW - cursor) + 2;
  if (right && textWidth(right) + 2 <= w) grid.text(x + w - textWidth(right) - 1, y, right, theme.colors['ink-3'], bg);
  // The focused header is surface-2 with an accent underline across the pane, a cue that isn't color alone.
  if (pane.focused) for (let c = x; c < x + w; c++) { const cell = grid.cells[y]?.[c]; if (cell) grid.put(c, y, { ...cell, underline: true, underlineColor: theme.colors.accent }); }
}
// Everything a split draws itself: headers, dividers and the bottom row. Pane bodies are drawn from their mirrors.
export function splitChrome(cols: number, rows: number, layout: SplitLayout, panes: readonly ChromePane[], dropped: number, theme: Theme): Frame {
  const grid = new Grid(cols, rows, theme), t = theme.colors;
  layout.panes.forEach((rect, i) => { const pane = panes[i]; if (pane) drawHeader(grid, rect.x, rect.y, rect.w, pane, theme); });
  for (const divider of layout.dividers) for (let y = divider.y; y < divider.y + divider.h; y++) grid.text(divider.x, y, '│', t.line, t.bg);
  const extra = dropped ? `${dropped} ${dropped === 1 ? 'agent' : 'agents'} didn't fit` : '', keysX = cols - textWidth(SPLIT_KEYS) - 1;
  let x = 1;
  if (extra) x = grid.text(x, rows - 1, extra, t['status-waiting'], t.bg, false, Math.max(0, keysX - 2 - x)) + 3;
  if (keysX - x - 2 >= textWidth(SPLIT_NOTE)) grid.text(x, rows - 1, SPLIT_NOTE, t['ink-3'], t.bg);
  if (keysX >= 1) grid.text(keysX, rows - 1, SPLIT_KEYS, t['ink-3'], t.bg);
  return grid.cells;
}
// When the window is too small for the panes it has, the split shows only this until it grows again.
export function tooSmall(cols: number, rows: number, theme: Theme): Frame {
  const grid = new Grid(cols, rows, theme), label = 'make the window bigger · ^E home';
  grid.text(Math.max(0, Math.floor((cols - textWidth(label)) / 2)), Math.floor(rows / 2), label, theme.colors['ink-3']);
  return grid.cells;
}
