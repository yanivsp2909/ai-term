import { encodeAppControl, type AppCommand } from '../../src/shared/app-control.js';

// S24 (v0.5 gate): node-pty starts the outer PTY with echo on, and the ai client goes back to cooked mode for moments
// while attaching or leaving an agent. A control written then is echoed back as output, token included. So main writes
// controls only once the client has switched to its own screen (alternate screen on), and drops any control that comes
// back as output, raw or in the echo's caret form, even when it arrives split across chunks.
const READY = '\x1b[?1049h';
const FORMS = ['\x1b]777;ai-term;', '^[]777;ai-term;'] as const;
const ENDS = ['\x1b\\', '\x07', '^[\\', '^G'];
// A control is the prefix, 64 hex, ';', a command of at most 16 characters and its end; anything longer is dropped whole.
const MAX_CONTROL = 128;
export class ControlGate {
  private ready = false;
  private tail = '';
  private held = '';
  constructor(private readonly token: string) {}
  command(command: AppCommand): string | null { return this.ready ? encodeAppControl(this.token, command) : null; }
  output(chunk: string): string {
    if (!this.ready) { this.ready = (this.tail + chunk).includes(READY); this.tail = chunk.slice(-(READY.length - 1)); }
    let data = this.held + chunk, shown = '';
    this.held = '';
    for (;;) {
      const at = Math.min(...FORMS.map(form => { const index = data.indexOf(form); return index < 0 ? Infinity : index; }));
      if (at === Infinity) break;
      shown += data.slice(0, at);
      data = data.slice(at);
      const end = Math.min(...ENDS.map(mark => { const index = data.indexOf(mark, FORMS[0].length); return index < 0 ? Infinity : index + mark.length; }));
      if (end === Infinity) {
        // Still arriving: hold it, unless it is already too long to be a control (then it is dropped).
        if (data.length <= MAX_CONTROL) this.held = data;
        return shown;
      }
      data = end <= MAX_CONTROL ? data.slice(end) : data.slice(FORMS[0].length);
    }
    // The chunk may end in the first bytes of a control: hold just those.
    const partial = longestPrefixSuffix(data);
    this.held = data.slice(data.length - partial);
    return shown + data.slice(0, data.length - partial);
  }
  // Called when no more output came for a moment: a held partial prefix was ordinary text; a held control is dropped.
  flush(): string {
    const held = this.held; this.held = '';
    return FORMS.some(form => held.startsWith(form)) ? '' : held;
  }
  get holding(): boolean { return this.held.length > 0; }
}
function longestPrefixSuffix(data: string): number {
  for (let length = Math.min(data.length, FORMS[0].length - 1); length > 0; length--) {
    const end = data.slice(-length);
    if (FORMS.some(form => form.startsWith(end))) return length;
  }
  return 0;
}
