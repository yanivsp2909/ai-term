import { encodeAppControl, type AppCommand } from '../../src/shared/app-control.js';

// S24 (v0.5 gate): node-pty starts the outer PTY with echo on, and the ai client goes back to cooked mode for moments
// while attaching or leaving an agent. A control written then is echoed back as output, token included. So main writes
// controls only once the client has switched to its own screen (alternate screen on), and drops any control that comes
// back as output, raw or in the echo's caret form, however the output is split into chunks and whenever it is flushed.
const READY = '\x1b[?1049h';
const FORMS = ['\x1b]777;ai-term;', '^[]777;ai-term;'] as const;
const ENDS = ['\x1b\\', '\x07', '^[\\', '^G'] as const;
const LONGEST_FORM = Math.max(...FORMS.map(form => form.length));
// After a prefix: 64 hex, ';', a command of at most 16 characters and an end of at most 3. Without an end, this many
// characters after the prefix are dropped and output shows again, so stray text can't swallow the screen.
const MAX_BODY = 128;
export class ControlGate {
  private ready = false;
  private tail = '';
  // Output held back because it may be the start of a control (or, while dropping one, of its end), and how many of its
  // leading characters were already shown by flush(): those still count for matching but are never shown twice.
  private carry = '';
  private carryShown = 0;
  // Characters of the current control still to drop; 0 outside one.
  private dropping = 0;
  constructor(private readonly token: string) {}
  command(command: AppCommand): string | null { return this.ready ? encodeAppControl(this.token, command) : null; }
  get holding(): boolean { return this.carry.length > this.carryShown; }
  output(chunk: string): string {
    if (!this.ready) { this.ready = (this.tail + chunk).includes(READY); this.tail = chunk.slice(-(READY.length - 1)); }
    const data = this.carry + chunk, skip = this.carryShown;
    this.carry = ''; this.carryShown = 0;
    let shown = '', at = 0;
    const show = (from: number, to: number): void => { const start = Math.max(from, skip); if (to > start) shown += data.slice(start, to); };
    while (at < data.length) {
      if (this.dropping) {
        const end = firstOf(data, ENDS, at);
        if (end && end.index - at < this.dropping) { at = end.index + end.length; this.dropping = 0; continue; }
        if (data.length - at <= this.dropping) {
          // The chunk ends inside the control: keep a possible first part of its end for the next chunk.
          const keep = data.endsWith('^[') ? 2 : data.endsWith('^') || data.endsWith('\x1b') ? 1 : 0;
          this.dropping -= data.length - at - keep;
          this.carry = data.slice(data.length - keep); this.carryShown = keep;
          return shown;
        }
        at += this.dropping; this.dropping = 0; continue;
      }
      const start = firstOf(data, FORMS, at);
      if (start) { show(at, start.index); at = start.index + start.length; this.dropping = MAX_BODY; continue; }
      const partial = prefixSuffix(data, at);
      show(at, data.length - partial);
      this.carry = data.slice(data.length - partial); this.carryShown = Math.max(0, Math.min(partial, skip - (data.length - partial)));
      return shown;
    }
    return shown;
  }
  // No more output came for a moment: a held start that wasn't completed was ordinary text, so it is shown (but still kept
  // for matching, in case the rest of a control follows later). Inside a control nothing is shown.
  flush(): string {
    if (this.dropping) return '';
    const shown = this.carry.slice(this.carryShown);
    this.carryShown = this.carry.length;
    return shown;
  }
}
function firstOf(data: string, marks: readonly string[], from: number): { index: number; length: number } | null {
  let best: { index: number; length: number } | null = null;
  for (const mark of marks) { const index = data.indexOf(mark, from); if (index >= 0 && (!best || index < best.index)) best = { index, length: mark.length }; }
  return best;
}
// The longest end of data (from `from`) that could still grow into a control prefix.
function prefixSuffix(data: string, from: number): number {
  for (let length = Math.min(data.length - from, LONGEST_FORM - 1); length > 0; length--) {
    const end = data.slice(-length);
    if (FORMS.some(form => form.startsWith(end))) return length;
  }
  return 0;
}
