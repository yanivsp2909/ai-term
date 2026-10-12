import { isFirstMessage, MAX_FIRST_MESSAGE_BYTES } from '../../shared/validate.js';
import { graphemes, safeText } from './grid.js';

type Fragment = string | { text: string; lines: number };
export const FIRST_MESSAGE_TOO_LONG = 'too long for a first message (16 KB): start the agent, then paste inside';

// Token metadata stays with the draft through confirmation/pickers; only expanded text goes to the daemon.
export class MessageField {
  private fragments: Fragment[] = [];
  get text(): string { return this.fragments.map(f => typeof f === 'string' ? f : f.text).join(''); }
  set text(text: string) { this.fragments = text ? [text] : []; }
  get hasPastes(): boolean { return this.fragments.some(f => typeof f !== 'string'); }
  copy(): MessageField { const field = new MessageField(); field.restore(this); return field; }
  restore(field: MessageField): void { this.fragments = field.fragments.map(f => typeof f === 'string' ? f : { ...f }); }
  display(firstLine = false): string {
    return this.fragments.map(f => typeof f === 'string' ? f : `[pasted · ${f.lines} lines]${firstLine ? ' ' + safeText(f.text.split(/\r\n|\r|\n/, 1)[0] ?? '') : ''}`).join('');
  }
  private insert(text: string, token: boolean): string | undefined {
    if (Buffer.byteLength(this.text) + Buffer.byteLength(text) > MAX_FIRST_MESSAGE_BYTES) return FIRST_MESSAGE_TOO_LONG;
    if (!isFirstMessage(text)) return 'First message cannot contain NUL';
    if (!text) return;
    if (token) this.fragments.push({ text, lines: text.split(/\r\n|\r|\n/).length });
    else {
      const last = this.fragments.at(-1);
      if (typeof last === 'string') this.fragments[this.fragments.length - 1] = last + text;
      else this.fragments.push(text);
    }
  }
  paste(text: string): string | undefined {
    const token = /[\r\n]/.test(text) || [...text].length > 200;
    return this.insert(token ? text : safeText(text.replace(/\t/g, ' ')), token);
  }
  type(text: string): string | undefined { return this.insert(safeText(text), false); }
  backspace(): void {
    const last = this.fragments.at(-1);
    if (typeof last !== 'string') { this.fragments.pop(); return; }
    const remaining = graphemes(last).slice(0, -1).join('');
    if (remaining) this.fragments[this.fragments.length - 1] = remaining;
    else this.fragments.pop();
  }
}
