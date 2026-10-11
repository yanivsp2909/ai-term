import { expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
it('selection calls pbcopy through execFile with argv array and plain text on stdin', async () => {
  const stdin = new PassThrough(), child = new EventEmitter();
  let copied = ''; stdin.on('data', data => { copied += data.toString(); });
  const execute = vi.fn(() => { queueMicrotask(() => child.emit('close', 0)); return Object.assign(child, { stdin }); });
  const { copyText } = await import('../src/client/tui/clipboard.js');
  await copyText('hello\nworld', execute);
  expect(execute).toHaveBeenCalledWith('/usr/bin/pbcopy', [], { timeout: 2000 }, expect.any(Function));
  expect(copied).toBe('hello\nworld');
});
it('preview scrollback stays anchored, counts new lines and End follows live; selection clips to cells', async () => {
  const { Preview } = await import('../src/client/tui/preview.js');
  const preview = new Preview(20, 4, () => {});
  try {
    await preview.write(Array.from({ length: 15 }, (_, i) => `line ${i}`).join('\r\n'));
    preview.scroll(-4); expect(preview.linesBack).toBe(4);
    const before = preview.top; await preview.write('\r\nnew line'); expect(preview.top).toBe(before); expect(preview.newLines).toBe(1);
    preview.select({ x: 0, y: 0 }, { x: 6, y: 1 });
    expect(preview.selectedText().split('\n')).toHaveLength(2);
    preview.follow(); expect(preview.linesBack).toBe(0); expect(preview.newLines).toBe(0);
  } finally { preview.dispose(); }
});
it('diff frames are synchronized, unchanged grids produce no bytes and wide-to-narrow cells clear', async () => {
  const { Grid, diffFrame } = await import('../src/client/tui/grid.js');
  const { createTheme } = await import('../src/client/tui/theme.js'); const theme = createTheme('graphite');
  const first = new Grid(4, 1, theme); first.text(0, 0, '界');
  const second = new Grid(4, 1, theme); second.text(0, 0, 'x');
  expect(diffFrame(first.cells, null, theme)).toContain('\x1b[?2026h');
  expect(diffFrame(first.cells, first.cells, theme)).toBe('');
  expect(diffFrame(second.cells, first.cells, theme)).toContain('x ');
});
it('auto accepts split OSC11 replies, retains SGR49 ground and uses slate on timeout', async () => {
  const { BackgroundReplies, createTheme, styleEscape } = await import('../src/client/tui/theme.js');
  const reply = vi.fn(), parser = new BackgroundReplies(reply);
  expect(parser.push(Buffer.from('\x1b]11;rgb:1212/3434/'))).toHaveLength(0);
  expect(parser.push(Buffer.from('5656\x1b\\hello')).toString()).toBe('hello');
  expect(reply).toHaveBeenCalledWith('#123456');
  const theme = createTheme('auto'); expect(theme.colors.surface).toBe('#232935');
  expect(styleEscape({ char: ' ', fg: theme.colors.ink, bg: theme.colors.bg, bold: false, width: 1 }, theme)).toContain(';49m');
  expect(createTheme('auto', '#ffffff').colors.ink).toBe('#1b1d21');
});
it('OSC11 filtering preserves unrelated Alt+] typing and recovers malformed replies', async () => {
  const { BackgroundReplies } = await import('../src/client/tui/theme.js'); const parser = new BackgroundReplies(() => {});
  expect(parser.push(Buffer.from('\x1b]hello\rworld')).toString()).toBe('\x1b]hello\rworld');
  parser.push(Buffer.from('\x1b]11;rgb:ab!')); expect(parser.push(Buffer.from('typing')).toString()).toBe('typing');
});
it('wrap-only output past 5000 lines preserves the anchor and counts newly scrolled lines', async () => {
  const { Preview } = await import('../src/client/tui/preview.js'); const preview = new Preview(4, 3, () => {});
  try {
    await preview.write('x'.repeat(4 * 5010)); preview.scroll(-10);
    const before = preview.top;
    await preview.write('y'.repeat(20)); expect(preview.top).toBe(before - 5); expect(preview.newLines).toBe(5);
  } finally { preview.dispose(); }
});
it('source execution loads design palettes without a Vite loader', async () => {
  const { execFile } = await import('node:child_process');
  const result = await new Promise<string>((resolve, reject) => execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "await import('./src/client/tui/theme.ts')"], { cwd: process.cwd(), env: { PATH: '/usr/bin:/bin' } }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  expect(result).toBe('');
});
it('a single large scroll chunk counts every new line, while ED3 clears without counting new output', async () => {
  const { Preview } = await import('../src/client/tui/preview.js'); const preview = new Preview(4, 3, () => {});
  try {
    await preview.write('x'.repeat(4 * 5010)); preview.scroll(-10);
    await preview.write('y'.repeat(4 * 6000)); expect(preview.newLines).toBe(6000);
    preview.follow(); preview.scroll(-2); await preview.write('\x1b[3J'); expect(preview.newLines).toBe(0);
  } finally { preview.dispose(); }
});
it('multiline selection copies only displayed columns from a wider remote terminal', async () => {
  const { Preview } = await import('../src/client/tui/preview.js'); const preview = new Preview(20, 4, () => {});
  try {
    await preview.write('12345HIDDEN\r\nabcdeHIDDEN\r\nfghijHIDDEN');
    preview.select({ x: 0, y: 0 }, { x: 4, y: 2 });
    expect(preview.selectedText(5)).toBe('12345\nabcde\nfghij');
  } finally { preview.dispose(); }
});
