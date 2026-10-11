import { theme, colorOf } from './theme.js';
export function layout(cols, rows) {
  const left = Math.min(36, Math.max(18, Math.floor(cols * 0.32)));
  const right = Math.max(8, cols - left - 3);
  const previewHeight = Math.max(5, rows - 14);
  return { left, right, previewHeight, previewCols: Math.max(1, right - 4), previewRows: Math.max(1, previewHeight - 4) };
}
export function makeScreen(cols, rows, terminal, input) {
  const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ char: ' ', fg: theme.ink, bg: theme.bg, bold: false, width: 1 })));
  const put = (x, y, char, fg = theme.ink, bg = theme.bg, bold = false, width = 1) => {
    if (grid[y]?.[x]) grid[y][x] = { char, fg, bg, bold, width };
  };
  const text = (x, y, str, fg = theme.ink, bg = theme.bg, bold = false, limit = cols - x) => {
    let remaining = Math.max(0, limit);
    // Command input is Unicode: combining marks share a cell, CJK occupies two.
    for (const char of str) {
      if (/\p{Mark}/u.test(char) && x > 0) { const prev = grid[y]?.[x - 1]; if (prev) prev.char += char; continue; }
      const width = /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60]/u.test(char) ? 2 : 1;
      if (remaining < width) break;
      put(x, y, char, fg, bg, bold, width);
      if (width === 2) put(x + 1, y, '', fg, bg, bold, 0);
      x += width; remaining -= width;
    }
  };
  const box = (x, y, w, h, title, bg = theme.bg) => {
    for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) put(c, r, ' ', theme.ink, bg);
    text(x, y, `╭${'─'.repeat(Math.max(0, w - 2))}╮`, theme.line, bg);
    text(x, y + h - 1, `╰${'─'.repeat(Math.max(0, w - 2))}╯`, theme.line, bg);
    for (let r = y + 1; r < y + h - 1; r++) { put(x, r, '│', theme.line, bg); put(x + w - 1, r, '│', theme.line, bg); }
    text(x + 2, y, ` ${title} `, theme['ink-2'], bg, true, w - 4);
  };
  if (cols < 65 || rows < 24) { text(1, 1, 'AI Term · resize to at least 65×24'); text(1, 3, `› ${input}█`, theme.accent); return grid; }
  const { left, right, previewHeight } = layout(cols, rows);
  const x = left + 2;
  text(1, 0, 'AI Term_', theme.accent, theme.bg, true);
  const counts = '● 1 waiting  ◐ 2 running  ✓ 1 to review  ✗ 1 failed';
  let countX = Math.max(13, cols - counts.length - 1);
  for (const [label, color] of [['● 1 waiting', theme['status-waiting']], ['◐ 2 running', theme.accent], ['✓ 1 to review', theme['ink-2']], ['✗ 1 failed', theme['status-error']]]) {
    text(countX, 0, label, color); countX += label.length + 2;
  }
  box(0, 1, left, rows - 6, 'Agents 5');
  const cards = [
    ['CL', 'fix-login', 'opus-5.5 · claude code', 'asks: npm test -- auth', '● 4m', theme['status-waiting']],
    ['KI', 'store-refactor', 'kimi-k3 · ai term', 'editing src/store/cart.ts', '◐ 12m', theme.accent],
    ['GP', 'flaky-tests', 'gpt-6.1-sol · codex', "! don't ask · npm test", '◐ 38m', theme.accent],
    ['GR', 'readme-pass', 'grok-4.6 · ai term', '+40 −22 · ready to review', '✓ 1h', theme['ink-2']],
    ['DS', 'test-helper', 'deepseek-v3 · ai term', 'exit 1 · generated failure', '✗ 2h', theme['status-error']],
  ];
  cards.forEach(([badge, name, model, activity, status, color], i) => {
    const y = 2 + i * 4;
    if (y + 2 >= rows - 6) return;
    const bg = i === 0 ? theme['surface-2'] : theme.bg;
    for (let r = y; r < y + 3; r++) for (let c = 1; c < left - 1; c++) put(c, r, ' ', theme.ink, bg);
    if (i === 0) for (let r = y; r < y + 3; r++) put(1, r, '▎', theme.accent, bg);
    for (let r = y; r < y + 2; r++) text(2, r, ` ${r === y ? badge : '  '} `, theme.ink, theme['surface-2'], true, 4);
    text(7, y, name, theme.ink, bg, i === 0, left - 15);
    text(left - 7, y, status, color, bg, false, 6);
    text(7, y + 1, model, theme['ink-2'], bg, false, left - 8);
    text(7, y + 2, activity, color, bg, false, left - 8);
  });
  box(x, 1, right, previewHeight, 'fix-login · ◉ live', theme.surface);
  text(x + 2, 2, 'claude code · opus-5.5', theme['ink-2'], theme.surface, false, right - 4);
  for (let r = 0; r < terminal.rows; r++) {
    const line = terminal.buffer.active.getLine(terminal.buffer.active.viewportY + r);
    for (let c = 0; c < terminal.cols; c++) {
      const cell = line?.getCell(c);
      if (!cell) continue;
      let fg = colorOf(cell, true), bg = colorOf(cell, false);
      if (cell.isInverse()) [fg, bg] = [bg, fg];
      put(x + 2 + c, 3 + r, cell.getChars() || ' ', fg, bg, Boolean(cell.isBold()), cell.getWidth());
    }
  }
  const bottom = 1 + previewHeight + 1;
  const usageWidth = Math.floor((right - 2) / 2);
  box(x, bottom, usageWidth, 7, 'Usage');
  box(x + usageWidth + 2, bottom, right - usageWidth - 2, 7, 'This Mac');
  ['       today  week   month', 'spend  $2.76 $11.02 $41.80', 'tokens 1.9M   7.9M  31.0M', 'budget none   none  b add'].forEach((s, i) => text(x + 2, bottom + 1 + i, s, theme['ink-2'], theme.bg, i === 1, usageWidth - 4));
  ['CPU 31% ▂▃▅▇▆▄▃▅▆▄', 'RAM 14.2/32 GB', 'NET ↓ 1.4 MB/s ↑ 0.2 MB/s'].forEach((s, i) => text(x + usageWidth + 4, bottom + 1 + i, s, theme['ink-2'], theme.bg, false, right - usageWidth - 6));
  box(0, rows - 4, cols, 3, '', theme.surface);
  text(2, rows - 3, '›', theme.accent, theme.surface);
  text(4, rows - 3, input ? `${input.slice(-(cols - 7))}█` : 'What do you want to build?█', input ? theme.ink : theme['ink-3'], theme.surface, false, cols - 6);
  text(1, rows - 1, 'opus-5.5 · claude code  ask    ↑↓ agents  ⏎ open  p preview  / commands', theme['ink-3']);
  return grid;
}
export function runs(row) {
  const result = [];
  for (const cell of row) {
    if (cell.width === 0) continue;
    const last = result.at(-1);
    if (last && last.fg === cell.fg && last.bg === cell.bg && last.bold === cell.bold) last.text += cell.char;
    else result.push({ ...cell, text: cell.char });
  }
  return result;
}
