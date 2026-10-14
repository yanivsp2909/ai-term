import { expect, it, vi } from 'vitest';
import { fitToWindow } from '../app/renderer/resize.js';
it('keeps xterm and the PTY on the same bounded grid after fit', () => {
  const terminal = { cols: 80, rows: 24, resize: vi.fn((cols: number, rows: number) => { terminal.cols = cols; terminal.rows = rows; }) };
  const fit = { fit: () => { terminal.cols = 501; terminal.rows = 301; } };
  const send = vi.fn(); fitToWindow(fit, terminal, send);
  expect(terminal.resize).toHaveBeenCalledWith(500, 300);
  expect({ cols: terminal.cols, rows: terminal.rows }).toEqual({ cols: 500, rows: 300 });
  expect(send).toHaveBeenCalledWith({ cols: 500, rows: 300 });
});
