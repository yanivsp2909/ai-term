// Keys typed into the agent's terminal. Bracketed pastes (`\e[200~` … `\e[201~`) arrive whole as one paste event, so a
// pasted or /send-ed "y" can never answer an approval. Cursor keys and other sequences are read and dropped.
export type KeyEvent =
  | { kind: 'text'; text: string } | { kind: 'paste'; text: string } | { kind: 'enter' } | { kind: 'newline' }
  | { kind: 'up'|'down'|'left'|'right'|'page-up'|'page-down' } | { kind: 'backspace' } | { kind: 'escape' } | { kind: 'ctrl-c' } | { kind: 'ctrl-d' } | { kind: 'ctrl-k' };
const PASTE_START = '\x1b[200~', PASTE_END = '\x1b[201~', MAX_PASTE_CHARS = 1024 * 1024;

export class KeyReader {
  private pending = '';
  private paste: string | null = null;
  push(data: string): KeyEvent[] {
    let input = this.pending + data;
    this.pending = '';
    const events: KeyEvent[] = [];
    let text = '';
    const flush = () => { if (text) { events.push({ kind: 'text', text }); text = ''; } };
    while (input.length) {
      if (this.paste !== null) {
        const end = input.indexOf(PASTE_END);
        if (end < 0) {
          // Keep a possible split end marker for the next chunk.
          const keep = [...Array(PASTE_END.length - 1).keys()].map(i => i + 1).reverse().find(n => PASTE_END.startsWith(input.slice(-n))) ?? 0;
          this.paste = (this.paste + input.slice(0, input.length - keep)).slice(0, MAX_PASTE_CHARS); this.pending = input.slice(input.length - keep); return events;
        }
        events.push({ kind: 'paste', text: (this.paste + input.slice(0, end)).slice(0, MAX_PASTE_CHARS) }); this.paste = null; input = input.slice(end + PASTE_END.length); continue;
      }
      const char = input[0] ?? '';
      if (char === '\x1b') {
        if (input.startsWith(PASTE_START)) { flush(); this.paste = ''; input = input.slice(PASTE_START.length); continue; }
        if (input.length === 1) { flush(); events.push({ kind: 'escape' }); input = ''; continue; }
        const next = input[1];
        if (next === '[' || next === 'O') {
          // CSI / SS3: parameters, then one final byte in @–~. A sequence cut at the end of the chunk waits for the rest.
          const match = input.slice(2).match(/^[0-?]*[ -/]*[@-~]/);
          if (!match) { if (/^[0-?]*[ -/]*$/.test(input.slice(2)) && input.length < 32) { flush(); this.pending = input; return events; } input = input.slice(2); continue; }
          const sequence = input.slice(0, 2 + match[0].length);
          flush();
          const cursor:Record<string,'up'|'down'|'left'|'right'|'page-up'|'page-down'>={'\x1b[A':'up','\x1b[B':'down','\x1b[C':'right','\x1b[D':'left','\x1bOA':'up','\x1bOB':'down','\x1bOC':'right','\x1bOD':'left','\x1b[5~':'page-up','\x1b[6~':'page-down'};
          if (cursor[sequence]) events.push({kind:cursor[sequence]});
          else if (sequence === '\x1b[13u') events.push({ kind: 'enter' });
          else if (sequence === '\x1b[27u') events.push({ kind: 'escape' });
          else if (sequence === '\x1b[99;5u') events.push({ kind: 'ctrl-c' });
          else if (sequence === '\x1b[107;5u') events.push({ kind: 'ctrl-k' });
          input = input.slice(sequence.length); continue;
        }
        // Alt+key or a bare Esc followed by typing: the Esc counts, the key is read next.
        flush(); events.push({ kind: 'escape' }); input = input.slice(1); continue;
      }
      input = input.slice(char.length);
      if (char === '\r') { flush(); events.push({ kind: 'enter' }); }
      else if (char === '\n') { flush(); events.push({ kind: 'newline' }); }
      else if (char === '\x7f' || char === '\b') { flush(); events.push({ kind: 'backspace' }); }
      else if (char === '\x03') { flush(); events.push({ kind: 'ctrl-c' }); }
      else if (char === '\x04') { flush(); events.push({ kind: 'ctrl-d' }); }
      else if (char === '\x0b') { flush(); events.push({ kind: 'ctrl-k' }); }
      else if (char === '\t' || char >= ' ' && char !== '\x7f' && !(char >= '\x80' && char <= '\x9f')) text += char;
    }
    flush();
    return events;
  }
}
