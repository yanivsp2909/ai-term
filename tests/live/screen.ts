import * as pty from 'node-pty';
import headless from '@xterm/headless';

// The live suite's eyes and hands: a real PTY running a real program, and a headless xterm fed with everything it
// prints, so a check reads the screen a person would see (the rows of the viewport) rather than the raw bytes.
export class LiveFailure extends Error { constructor(message: string, readonly screen = '') { super(message); } }
export const KEY = { enter: '\r', esc: '\x1b', tab: '\t', backspace: '\x7f', ctrlC: '\x03', ctrlE: '\x05', ctrlK: '\x0b', ctrlU: '\x15', ctrlBackslash: '\x1c', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' } as const;
const POLL_MS = 50;
export const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

export class Screen {
  private readonly term: headless.Terminal;
  private readonly child: pty.IPty;
  private output = '';
  private done = false;
  private readonly taps = new Set<(data: string) => void>();
  readonly exited: Promise<number>;
  constructor(file: string, args: readonly string[], options: { env: Record<string, string>; cwd: string; cols?: number; rows?: number }) {
    const cols = options.cols ?? 120, rows = options.rows ?? 40;
    this.term = new headless.Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
    this.child = pty.spawn(file, [...args], { env: options.env, cwd: options.cwd, cols, rows, name: 'xterm-256color' });
    this.exited = new Promise(resolve => this.child.onExit(event => { this.done = true; resolve(event.exitCode); }));
    // The TUI asks the terminal things (cursor position, device attributes): the headless xterm answers like a real one.
    this.term.onData(data => { if (!this.done) this.child.write(data); });
    this.child.onData(data => { for (const tap of this.taps) tap(data); this.output += data; if (this.output.length > 4 * 1024 * 1024) this.output = this.output.slice(-2 * 1024 * 1024); this.term.write(data); });
  }
  get finished(): boolean { return this.done; }
  get pid(): number { return this.child.pid; }
  // The visible rows, as text (trailing spaces trimmed); written data is applied first.
  async text(): Promise<string> {
    await new Promise<void>(resolve => this.term.write('', resolve));
    const buffer = this.term.buffer.active;
    return Array.from({ length: this.term.rows }, (_, y) => (buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '').trimEnd()).join('\n');
  }
  // The underlined runs of each visible row (a split marks its focused pane's header this way, not by color alone).
  async underlined(): Promise<string[]> {
    await new Promise<void>(resolve => this.term.write('', resolve));
    const buffer = this.term.buffer.active, rows: string[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      const line = buffer.getLine(buffer.viewportY + y); if (!line) continue;
      let text = '';
      for (let x = 0; x < this.term.cols; x++) { const cell = line.getCell(x); if (cell?.isUnderline()) text += cell.getChars() || ' '; }
      if (text.trim().length >= 3) rows.push(text.trim());
    }
    return rows;
  }
  raw(): string { return this.output; }
  // Everything the program prints from now on also goes to this listener (tier 2 hands your terminal over this way).
  tap(listener: (data: string) => void): () => void { this.taps.add(listener); return () => { this.taps.delete(listener); }; }
  write(data: string): void { if (this.done) throw new LiveFailure('the program already exited'); this.child.write(data); }
  // A line typed into a prompt: the text, then Enter on its own, the way a person's Enter arrives after their typing.
  async type(line: string, enter = true): Promise<void> { this.write(line); if (enter) { await sleep(60); this.write(KEY.enter); } }
  // Bracketed paste, as a terminal sends a pasted block.
  paste(text: string): void { this.write(`\x1b[200~${text}\x1b[201~`); }
  resize(cols: number, rows: number): void { this.child.resize(cols, rows); this.term.resize(cols, rows); }
  async waitFor(what: string | RegExp, timeoutMs = 15_000, label?: string): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const text = await this.text();
      if (typeof what === 'string' ? text.includes(what) : what.test(text)) return text;
      if (Date.now() > deadline) throw new LiveFailure(`nothing on screen showed ${label ?? JSON.stringify(String(what))} within ${Math.round(timeoutMs / 1000)} s`, text);
      await sleep(POLL_MS);
    }
  }
  async waitGone(what: string | RegExp, timeoutMs = 15_000, label?: string): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const text = await this.text();
      if (!(typeof what === 'string' ? text.includes(what) : what.test(text))) return text;
      if (Date.now() > deadline) throw new LiveFailure(`${label ?? JSON.stringify(String(what))} was still on screen after ${Math.round(timeoutMs / 1000)} s`, text);
      await sleep(POLL_MS);
    }
  }
  // Stops the program if it's still running and waits for it.
  async close(): Promise<void> { if (!this.done) this.child.kill(); await Promise.race([this.exited, sleep(3000)]); this.term.dispose(); }
}
