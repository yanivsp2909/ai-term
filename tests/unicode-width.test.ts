import { expect, it } from 'vitest';
import headless from '@xterm/headless';
import unicode11 from '@xterm/addon-unicode11';
import { Mirror } from '../src/daemon/mirror.js';
import { Preview } from '../src/client/tui/preview.js';
import { Grid, diffFrame } from '../src/client/tui/grid.js';
import { createTheme } from '../src/client/tui/theme.js';
// The v0.2.1b spike's width demo (spikes/bar/patterns.js).
const DEMO = ['CJK: 漢字かなカナ한국어 | end', 'emoji: 🧪x 👍🏽x 👨‍👩‍👧x ❤️x 🇮🇱x ✓x é|é end'];
const COLS = 48, ROWS = DEMO.length, theme = createTheme('graphite');
const layout = (cells: { char: string; width: number }[][]): string[][] => cells.map(row => row.map(cell => cell.width === 0 ? 'tail' : `${cell.char}/${cell.width}`)); // a wide character's second cell is never drawn
const columns = (cells: { char: string }[][], y: number, char: string): number[] => (cells[y] ?? []).flatMap((cell, x) => cell.char === char ? [x] : []);
it('emoji and wide characters line up cell-exact through the daemon mirror, the preview and the grid', async () => {
  const mirror = new Mirror(COLS, ROWS, () => {}), preview = new Preview(COLS, ROWS, () => {});
  const outer = new headless.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  try {
    await mirror.write(DEMO.join('\r\n'));
    await preview.write(mirror.snapshot());
    const cells = preview.cells(theme, COLS, ROWS);
    // Unicode 11 widths: wide CJK and 🧪 take 2 cells; a skin tone and each family member are their own 2-cell emoji; ❤️, flag letters, ✓ and é take 1.
    expect(columns(cells, 0, '|')).toEqual([24]); expect(columns(cells, 0, 'd')).toEqual([28]);
    expect(columns(cells, 1, 'x')).toEqual([9, 15, 23, 26, 30, 33]); expect(columns(cells, 1, 'd')).toEqual([41]);
    expect(cells[1]?.[7]).toMatchObject({ char: '🧪', width: 2 }); expect(cells[1]?.[8]?.width).toBe(0);
    // Text the homepage draws itself counts the same cells as the mirrors.
    const drawn = new Grid(COLS, ROWS, theme); DEMO.forEach((line, y) => drawn.text(0, y, line));
    expect(layout(drawn.cells)).toEqual(layout(cells));
    // And a Unicode 11 terminal shown the grid's bytes puts every character where the preview has it.
    const frame = new Grid(COLS, ROWS, theme); cells.forEach((row, y) => row.forEach((cell, x) => frame.put(x, y, cell)));
    outer.loadAddon(new unicode11.Unicode11Addon()); outer.unicode.activeVersion = '11';
    await new Promise<void>(resolve => outer.write(diffFrame(frame.cells, null, theme), resolve));
    const shown = Array.from({ length: ROWS }, (_, y) => Array.from({ length: COLS }, (_, x) => { const cell = outer.buffer.active.getLine(y)?.getCell(x); return { char: cell?.getChars() || ' ', width: cell?.getWidth() ?? 1 }; }));
    expect(layout(shown)).toEqual(layout(cells));
  } finally { mirror.dispose(); preview.dispose(); outer.dispose(); }
});
