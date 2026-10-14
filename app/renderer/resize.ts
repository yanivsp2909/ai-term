import type { TerminalSize } from '../shared/api.js';
interface FittedTerminal extends TerminalSize { resize(cols: number, rows: number): void }
export function fitToWindow(fit: { fit(): void }, terminal: FittedTerminal, send: (size: TerminalSize) => void): void {
  fit.fit();
  send({ cols: Math.max(2, Math.min(500, terminal.cols)), rows: Math.max(2, Math.min(300, terminal.rows)) });
}
