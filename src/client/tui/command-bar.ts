import { graphemes, type Grid } from './grid.js';
import { mix, type Theme } from './theme.js';
import { textWidth } from '../../shared/unicode-width.js';
import type { FieldView } from './message-field.js';
// The command field's text starts here, after the border and the › prompt.
export const FIELD_X = 4;
const PLACEHOLDER = 'What do you want to build?';
// Text may use the field up to one cell before its border; the end-of-text cursor needs the cell after the text.
const room = (cols: number): number => cols - 7;
// The first unit on screen. It keeps the previous scroll while the caret stays visible, so a drag or arrow doesn't shift
// the text under the pointer; it scrolls back only while the rest of the text fits, and forward until the caret's cell fits.
export function fieldStart(field: FieldView, cols: number, previous = 0): number {
  const width = (i: number) => textWidth(field.units[i] ?? '');
  let start = Math.min(previous, field.caret), tail = 0, head = 0;
  for (let i = start; i < field.units.length; i++) tail += width(i);
  while (start > 0 && tail + width(start - 1) <= room(cols)) tail += width(--start);
  for (let i = start; i < field.caret; i++) head += width(i);
  while (start < field.caret && head > room(cols)) head -= width(start++);
  return start;
}
// The unit under column x of the field row; any column past the text is the end.
export function fieldIndexAt(field: FieldView, cols: number, x: number): number {
  let at = FIELD_X;
  for (let i = field.start ?? fieldStart(field, cols); i < field.units.length; i++) { const width = textWidth(field.units[i] ?? ''); if (x < at + width) return i; at += width; }
  return field.units.length;
}
export function drawField(grid: Grid, field: FieldView, cols: number, y: number, theme: Theme): void {
  const t = theme.colors, end = FIELD_X + cols - 6, selectedBg = mix(t.surface, t.accent, 0.38);
  if (!field.units.length) { grid.text(grid.text(FIELD_X, y, PLACEHOLDER, t['ink-3'], t.surface, false, cols - 6), y, '█', t.cursor, t.surface, false, 1); return; }
  let x = FIELD_X;
  for (let i = field.start ?? fieldStart(field, cols); i < field.units.length && x < end; i++) {
    const unit = field.units[i] ?? '', selected = field.selection !== null && i >= field.selection[0] && i < field.selection[1];
    const next = grid.text(x, y, unit, t.ink, selected ? selectedBg : t.surface, false, end - x);
    // A caret inside the text is a block over its first cell, drawn in reverse; a selection shows its place instead.
    if (i === field.caret && !field.selection) { const first = graphemes(unit)[0] ?? ' '; grid.text(x, y, first, t.surface, t.cursor, false, textWidth(first)); }
    x = next;
  }
  if (field.caret === field.units.length && !field.selection && x < end) grid.text(x, y, '█', t.cursor, t.surface, false, 1);
}
