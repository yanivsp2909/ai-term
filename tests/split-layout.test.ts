import { expect, it } from 'vitest';
import { MIN_PANE_COLS, MIN_PANE_ROWS, fitPanes, splitLayout, paneAt } from '../src/client/split-layout.js';

it('2 and 3 panes sit side by side with one-column dividers above a bottom row', () => {
 expect(splitLayout(130, 45, 2)).toEqual({ panes: [{ x:0, y:0, w:65, h:44 }, { x:66, y:0, w:64, h:44 }], dividers: [{ x:65, y:0, w:1, h:44 }] });
 expect(splitLayout(130, 45, 3)).toEqual({ panes: [{ x:0, y:0, w:43, h:44 }, { x:44, y:0, w:43, h:44 }, { x:88, y:0, w:42, h:44 }], dividers: [{ x:43, y:0, w:1, h:44 }, { x:87, y:0, w:1, h:44 }] });
});
it('4 panes are a 2×2 grid; the lower headers separate the rows', () => {
 expect(splitLayout(130, 45, 4)).toEqual({ panes: [{ x:0, y:0, w:65, h:22 }, { x:66, y:0, w:64, h:22 }, { x:0, y:22, w:65, h:22 }, { x:66, y:22, w:64, h:22 }], dividers: [{ x:65, y:0, w:1, h:44 }] });
});
it('every pane is at least 40 columns and 10 rows, header included', () => {
 expect(MIN_PANE_COLS).toBe(40); expect(MIN_PANE_ROWS).toBe(10);
 expect(splitLayout(81, 11, 2)?.panes.map(p => [p.w, p.h])).toEqual([[40, 10], [40, 10]]);
 expect(splitLayout(80, 11, 2)).toBeNull(); expect(splitLayout(81, 10, 2)).toBeNull();
 expect(splitLayout(122, 11, 3)?.panes.map(p => p.w)).toEqual([40, 40, 40]); expect(splitLayout(121, 11, 3)).toBeNull();
 expect(splitLayout(81, 21, 4)?.panes.map(p => [p.w, p.h])).toEqual([[40, 10], [40, 10], [40, 10], [40, 10]]); expect(splitLayout(81, 20, 4)).toBeNull();
 for (const count of [2, 3, 4]) for (const [cols, rows] of [[81, 21], [122, 11], [200, 60], [130, 45]] as const) for (const pane of splitLayout(cols, rows, count)?.panes ?? []) {
  expect(pane.w).toBeGreaterThanOrEqual(MIN_PANE_COLS); expect(pane.h).toBeGreaterThanOrEqual(MIN_PANE_ROWS); expect(pane.x + pane.w).toBeLessThanOrEqual(cols); expect(pane.y + pane.h).toBeLessThanOrEqual(rows - 1);
 }
});
it('a too-small terminal opens as many panes as fit, never more than 4', () => {
 expect(fitPanes(130, 45, 4)).toBe(4); expect(fitPanes(130, 45, 5)).toBe(4);
 expect(fitPanes(130, 15, 4)).toBe(3); expect(fitPanes(100, 15, 4)).toBe(2); expect(fitPanes(100, 30, 3)).toBe(2);
 expect(fitPanes(100, 30, 4)).toBe(4); expect(fitPanes(79, 30, 4)).toBe(1); expect(fitPanes(130, 10, 2)).toBe(1);
});
it('finds the pane under a cell: body cells are pane-relative, the header is row -1, dividers and the bottom row are nobody', () => {
 const layout = splitLayout(130, 45, 4); if (!layout) throw new Error('layout');
 expect(paneAt(layout, 0, 0)).toEqual({ index:0, x:0, y:-1 });
 expect(paneAt(layout, 70, 5)).toEqual({ index:1, x:4, y:4 });
 expect(paneAt(layout, 3, 23)).toEqual({ index:2, x:3, y:0 });
 expect(paneAt(layout, 65, 5)).toBeNull(); expect(paneAt(layout, 10, 44)).toBeNull();
});
