import { StringDecoder } from 'node:string_decoder';
import { graphemes, safeText } from './grid.js';
export type Action = { kind: 'draw' | 'preview' | 'up' | 'down' | 'page-up' | 'page-down' | 'end' | 'attach' | 'quit' | 'stop' | 'rename' | 'remove' } | { kind: 'note' | 'submit'; text: string };
export class CommandField {
  text = '';
  private lastInterrupt = -Infinity;
  paste(text: string): void { this.text = (this.text + safeText(text)).slice(0, 4096); }
  key(key: string, now = Date.now()): Action {
    if (key === 'ctrl-c') {
      if (now - this.lastInterrupt <= 1000) return { kind: 'quit' };
      this.lastInterrupt = now; return { kind: 'note', text: 'Ctrl+C again to quit' };
    }
    if (key === 'escape') { this.text = ''; return { kind: 'draw' }; }
    if (key === 'backspace') { this.text = graphemes(this.text).slice(0, -1).join(''); return { kind: 'draw' }; }
    if (key === 'enter') { const text = this.text; this.text = ''; return text ? { kind: 'submit', text } : { kind: 'attach' }; }
    if (['page-up', 'page-down', 'end'].includes(key)) return { kind: key as 'page-up' | 'page-down' | 'end' };
    if (!this.text) {
      const shortcut: Record<string, Action['kind']> = { p: 'preview', s: 'stop', r: 'rename', x: 'remove', up: 'up', down: 'down' };
      const action = shortcut[key]; if (action) return { kind: action } as Action;
    }
    if (graphemes(key).length === 1 && !/[\p{C}]/u.test(key)) this.paste(key);
    return { kind: 'draw' };
  }
}
export type InputEvent = { kind: 'key'; key: string } | { kind: 'paste'; text: string } | { kind: 'mouse'; button: number; x: number; y: number; release: boolean };
export class InputParser {
  private decoder = new StringDecoder('utf8');
  private sequence = '';
  private pasteText: string | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly emit: (event: InputEvent) => void) {}
  push(chunk: Buffer): void {
    for (const char of this.decoder.write(chunk)) {
      if (this.timer) clearTimeout(this.timer);
      if (this.sequence) {
        this.sequence += char;
        if (this.sequence === '\x1b[' || this.sequence === '\x1bO') continue;
        if (this.sequence.startsWith('\x1b[') && !/[@-~]/.test(char) && this.sequence.length <= 64) continue;
        const sequence = this.sequence; this.sequence = '';
        if (sequence === '\x1b[200~') { this.pasteText = ''; continue; }
        if (sequence === '\x1b[201~') { if (this.pasteText !== null) this.emit({ kind: 'paste', text: this.pasteText.replace(/[\r\n\t]/g, ' ') }); this.pasteText = null; continue; }
        if (this.pasteText !== null) continue;
        // eslint-disable-next-line no-control-regex -- SGR mouse coordinates arrive in CSI.
        const mouse = sequence.match(/^\x1b\[<(\d{1,3});(\d{1,4});(\d{1,4})([Mm])$/);
        if (mouse) { this.emit({ kind: 'mouse', button: Number(mouse[1]), x: Number(mouse[2]) - 1, y: Number(mouse[3]) - 1, release: mouse[4] === 'm' }); continue; }
        const key = ({ '\x1b[A': 'up', '\x1b[B': 'down', '\x1bOA': 'up', '\x1bOB': 'down', '\x1b[C': 'right', '\x1b[D': 'left', '\x1bOC': 'right', '\x1bOD': 'left', '\x1b[5~': 'page-up', '\x1b[6~': 'page-down', '\x1b[F': 'end', '\x1bOF': 'end', '\x1b[4~': 'end' } as Record<string, string>)[sequence];
        if (key) this.emit({ kind: 'key', key });
        continue;
      }
      if (char === '\x1b') { this.sequence = char; continue; }
      if (this.pasteText !== null) { this.pasteText = (this.pasteText + char).slice(0, 4096); continue; }
      const key = char === '\x03' ? 'ctrl-c' : char === '\t' ? 'tab' : char === '\r' || char === '\n' ? 'enter' : char === '\x7f' || char === '\b' ? 'backspace' : char;
      if (!/[\p{C}]/u.test(key)) this.emit({ kind: 'key', key });
    }
    if (this.sequence === '\x1b') this.timer = setTimeout(() => { this.sequence = ''; this.emit({ kind: 'key', key: 'escape' }); }, 30);
  }
  dispose(): void { if (this.timer) clearTimeout(this.timer); this.sequence = ''; this.pasteText = null; }
}
