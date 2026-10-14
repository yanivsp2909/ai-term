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
const fits = (across: { w: number }[], heights: number[]) => across.every(c => c.w >= MIN_PANE_COLS) && heights.every(h => h >= MIN_PANE_ROWS);
// 2 and 3 panes side by side, 4 as 2×2; null when any pane would be smaller than the minimum. Three panes too wide
// to sit side by side take two on top and one full width below, so closing one of four never hides the rest.
export function splitLayout(cols: number, rows: number, count: number): SplitLayout | null {
  if (count < 2 || count > MAX_PANES) return null;
  const height = rows - 1;
  if (count < 4) {
    const across = columns(cols, count);
    if (fits(across, [height])) return { panes: across.map(c => ({ x: c.x, y: 0, w: c.w, h: height })), dividers: across.slice(0, -1).map(c => ({ x: c.x + c.w, y: 0, w: 1, h: height })) };
    if (count === 2) return null;
  }
  const across = columns(cols, 2), [top = 0, bottom = 0] = share(height, 2);
  if (!fits(across, [top, bottom])) return null;
  const panes: Rect[] = across.map(c => ({ x: c.x, y: 0, w: c.w, h: top }));
  if (count === 3) panes.push({ x: 0, y: top, w: cols, h: bottom }); else panes.push(...across.map(c => ({ x: c.x, y: top, w: c.w, h: bottom })));
  return { panes, dividers: across.slice(0, -1).map(c => ({ x: c.x + c.w, y: 0, w: 1, h: count === 3 ? top : height })) };
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
