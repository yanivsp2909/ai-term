import { StringDecoder } from 'node:string_decoder';
import { graphemes } from './grid.js';
import { MAX_FIRST_MESSAGE_BYTES } from '../../shared/validate.js';
import { MessageField } from './message-field.js';
export type Action = { kind: 'draw' | 'preview' | 'up' | 'down' | 'page-up' | 'page-down' | 'end' | 'attach' | 'quit' | 'stop' | 'rename' | 'remove' | 'copy' | 'mark' | 'split' | 'diff' } | { kind: 'note'; text: string } | { kind: 'submit'; text: string; message: MessageField };
export class CommandField extends MessageField {
  private lastInterrupt = -Infinity;
  key(key: string, now = Date.now()): Action {
    if (key === 'ctrl-c') {
      if (now - this.lastInterrupt <= 1000) return { kind: 'quit' };
      this.lastInterrupt = now; return { kind: 'note', text: 'Ctrl+C again to quit' };
    }
    // Esc first drops a selection, then clears the field.
    if (key === 'escape') { if (this.selection) this.clearSelection(); else this.text = ''; return { kind: 'draw' }; }
    const edit: Record<string, () => void> = { backspace: () => this.backspace(), delete: () => this.deleteForward(), 'alt-backspace': () => this.deleteWord(), 'ctrl-u': () => this.clear(),
      left: () => this.move(-1, false), right: () => this.move(1, false), 'shift-left': () => this.move(-1, true), 'shift-right': () => this.move(1, true),
      'alt-left': () => this.moveWord(-1), 'alt-right': () => this.moveWord(1), home: () => this.moveToEnd(false), 'ctrl-a': () => this.moveToEnd(false), 'ctrl-e': () => this.moveToEnd(true) };
    const editKey = Object.hasOwn(edit, key) ? edit[key] : undefined; if (editKey) { editKey(); return { kind: 'draw' }; }
    // End moves the cursor while there is text; with an empty field it keeps following the preview live, like the letter shortcuts.
    if (key === 'end' && this.text) { this.moveToEnd(true); return { kind: 'draw' }; }
    if (key === 'enter') { const text = this.text, message = this.copy(); this.text = ''; return text ? { kind: 'submit', text, message } : { kind: 'attach' }; }
    if (['page-up', 'page-down', 'end'].includes(key)) return { kind: key as 'page-up' | 'page-down' | 'end' };
    if (!this.text) {
      const shortcut: Record<string, Action['kind']> = { c:'copy', p: 'preview', s: 'stop', r: 'rename', x: 'remove', ' ': 'mark', v: 'split', d: 'diff', up: 'up', down: 'down' };
      const action = shortcut[key]; if (action) return { kind: action } as Action;
    }
    if (graphemes(key).length === 1 && !/[\p{C}]/u.test(key)) { const error = this.type(key); if (error) return { kind: 'note', text: error }; }
    return { kind: 'draw' };
  }
}
export type InputEvent = { kind: 'key'; key: string } | { kind: 'paste'; text: string; tooLong?: true } | { kind: 'mouse'; button: number; x: number; y: number; release: boolean };
export class InputParser {
  private decoder = new StringDecoder('utf8');
  private sequence = '';
  private pasteText: string | null = null;
  private pasteBytes = 0;
  private pasteTooLong = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly emit: (event: InputEvent) => void) {}
  push(chunk: Buffer): void {
    for (const char of this.decoder.write(chunk)) {
      if (this.timer) clearTimeout(this.timer);
      if (this.pasteText !== null) {
        // Only the bracketed-paste end marker is interpreted. Everything else is literal message data.
        const end = '\x1b[201~';
        this.sequence += char;
        while (this.sequence && !end.startsWith(this.sequence)) {
          const literal = [...this.sequence][0] ?? ''; this.sequence = this.sequence.slice(literal.length);
          this.pasteBytes += Buffer.byteLength(literal);
          if (this.pasteBytes > MAX_FIRST_MESSAGE_BYTES) { this.pasteTooLong = true; this.pasteText = ''; }
          else if (!this.pasteTooLong) this.pasteText += literal;
        }
        if (this.sequence === end) {
          const event: InputEvent = { kind: 'paste', text: this.pasteText, ...(this.pasteTooLong ? { tooLong: true } : {}) };
          this.sequence = ''; this.pasteText = null; this.pasteBytes = 0; this.pasteTooLong = false; this.emit(event);
        }
        continue;
      }
      if (this.sequence) {
        this.sequence += char;
        if (this.sequence === '\x1b[' || this.sequence === '\x1bO') continue;
        if (this.sequence.startsWith('\x1b[') && !/[@-~]/.test(char) && this.sequence.length <= 64) continue;
        const sequence = this.sequence; this.sequence = '';
        if (sequence === '\x1b[200~') { this.pasteText = ''; continue; }
        // eslint-disable-next-line no-control-regex -- SGR mouse coordinates arrive in CSI.
        const mouse = sequence.match(/^\x1b\[<(\d{1,3});(\d{1,4});(\d{1,4})([Mm])$/);
        if (mouse) { this.emit({ kind: 'mouse', button: Number(mouse[1]), x: Number(mouse[2]) - 1, y: Number(mouse[3]) - 1, release: mouse[4] === 'm' }); continue; }
        const key = ({ '\x1b[A': 'up', '\x1b[B': 'down', '\x1bOA': 'up', '\x1bOB': 'down', '\x1b[C': 'right', '\x1b[D': 'left', '\x1bOC': 'right', '\x1bOD': 'left', '\x1b[5~': 'page-up', '\x1b[6~': 'page-down', '\x1b[F': 'end', '\x1bOF': 'end', '\x1b[4~': 'end', '\x1b[3~': 'delete', '\x1b[1;2C': 'shift-right', '\x1b[1;2D': 'shift-left', '\x1b\x7f': 'alt-backspace', '\x1b\b': 'alt-backspace', '\x1b[1;3D': 'alt-left', '\x1b[1;3C': 'alt-right', '\x1bb': 'alt-left', '\x1bf': 'alt-right', '\x1b[H': 'home', '\x1bOH': 'home', '\x1b[1~': 'home' } as Record<string, string>)[sequence];
        if (key) this.emit({ kind: 'key', key });
        continue;
      }
      if (char === '\x1b') { this.sequence = char; continue; }
      // Ctrl+W is the readline word delete; some macOS terminal presets send it for Option+Backspace instead of ESC DEL.
      const key = char === '\x03' ? 'ctrl-c' : char === '\x15' ? 'ctrl-u' : char === '\x01' ? 'ctrl-a' : char === '\x05' ? 'ctrl-e' : char === '\x17' ? 'alt-backspace' : char === '\t' ? 'tab' : char === '\r' || char === '\n' ? 'enter' : char === '\x7f' || char === '\b' ? 'backspace' : char;
      if (!/[\p{C}]/u.test(key)) this.emit({ kind: 'key', key });
    }
    if (this.pasteText === null && this.sequence === '\x1b') this.timer = setTimeout(() => { this.sequence = ''; this.emit({ kind: 'key', key: 'escape' }); }, 30);
  }
  dispose(): void { if (this.timer) clearTimeout(this.timer); this.sequence = ''; this.pasteText = null; this.pasteBytes = 0; this.pasteTooLong = false; }
}
