// Pane geometry for splits (design.md, Inside a session v0.3). Rows exclude the bottom hint row; each pane's first row
// is its header, so an agent gets h − 1 rows. Side-by-side panes are separated by a one-column divider.
export const MIN_PANE_COLS = 40, MIN_PANE_ROWS = 10, MAX_PANES = 4;
export interface Rect { x: number; y: number; w: number; h: number }
export interface SplitLayout { panes: Rect[]; dividers: Rect[] }
// Sizes that add up to `total`; the leftmost parts take the remainder.
function share(total: number, parts: number): number[] {
  return Array.from({ length: parts }, (_, i) => Math.floor(total / parts) + (i < total % parts ? 1 : 0));
}
function columns(cols: number, count: number): { x: number; w: number }[] {
  let x = 0;
  return share(cols - (count - 1), count).map(w => { const column = { x, w }; x += w + 1; return column; });
}
// 2 and 3 panes side by side, 4 as 2×2; null when any pane would be smaller than the minimum.
export function splitLayout(cols: number, rows: number, count: number): SplitLayout | null {
  if (count < 2 || count > MAX_PANES) return null;
  const height = rows - 1, across = columns(cols, count === 4 ? 2 : count), heights = count === 4 ? share(height, 2) : [height];
  if (across.some(c => c.w < MIN_PANE_COLS) || heights.some(h => h < MIN_PANE_ROWS)) return null;
  const panes: Rect[] = [];
  let y = 0;
  for (const h of heights) { for (const c of across) panes.push({ x: c.x, y, w: c.w, h }); y += h; }
  return { panes, dividers: across.slice(0, -1).map(c => ({ x: c.x + c.w, y: 0, w: 1, h: height })) };
}
// How many of `wanted` agents get a pane: the most that fit, or 1 (a normal attach) when not even two do.
export function fitPanes(cols: number, rows: number, wanted: number): number {
  for (let count = Math.min(wanted, MAX_PANES); count >= 2; count--) if (splitLayout(cols, rows, count)) return count;
  return 1;
}
// The pane under a 0-based cell, with coordinates relative to its body; y is -1 on the header row.
export function paneAt(layout: SplitLayout, x: number, y: number): { index: number; x: number; y: number } | null {
  const index = layout.panes.findIndex(p => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h);
  const pane = layout.panes[index];
  return pane ? { index, x: x - pane.x, y: y - pane.y - 1 } : null;
}
