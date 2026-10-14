// Splits keyboard input from the real terminal into what belongs to the focused pane and what belongs to AI Term:
// the pane key (Ctrl+\), the home key (Ctrl+E) and mouse reports (the split always asks for SGR reports). Bytes are
// preserved in order; only Escape/CSI prefixes are held until they can be classified, as in HomeKeyFilter.
export type SplitInputEvent =
  | { kind: 'keys'; data: Buffer }
  | { kind: 'pane'; data: Buffer }
  | { kind: 'home' }
  | { kind: 'mouse'; button: number; x: number; y: number; release: boolean };
const CTRL_E = 0x05, CTRL_BACKSLASH = 0x1c, ESC = 0x1b;
// Kitty keyboard (`CSI 92;5u`, event type :1 press, :2 repeat, :3 release) and xterm modifyOtherKeys (`CSI 27;5;92~`).
// eslint-disable-next-line no-control-regex -- terminal key reports
const PANE = /^\x1b\[(?:92;5(?::([123]))?(?:;[0-9:]+)?u|27;5;92~)$/, HOME = /^\x1b\[(?:101;5(?::([123]))?(?:;[0-9:]+)?u|27;5;101~)$/;
// eslint-disable-next-line no-control-regex -- SGR mouse report
const MOUSE = /^\x1b\[<(\d{1,3});(\d{1,4});(\d{1,4})([Mm])$/;
export class SplitInput {
  private pending: number[] = [];
  private paste = false;
  push(chunk: Buffer): SplitInputEvent[] {
    const events: SplitInputEvent[] = [];
    let keys: number[] = [];
    const emit = (event: SplitInputEvent) => { if (keys.length) { events.push({ kind: 'keys', data: Buffer.from(keys) }); keys = []; } events.push(event); };
    for (const byte of chunk) {
      if (!this.pending.length) {
        if (byte === ESC) this.pending.push(byte);
        else if (!this.paste && byte === CTRL_E) emit({ kind: 'home' });
        else if (!this.paste && byte === CTRL_BACKSLASH) emit({ kind: 'pane', data: Buffer.from([byte]) });
        else keys.push(byte);
        continue;
      }
      if (byte === ESC) { keys.push(...this.pending); this.pending = [ESC]; continue; }
      this.pending.push(byte);
      if (this.pending.length === 2 && byte === 0x5b) continue;
      const complete = this.pending.length === 2 || byte >= 0x40 && byte <= 0x7e;
      if (!complete && this.pending.length <= 96) continue;
      const bytes = this.pending; this.pending = [];
      const event = this.classify(Buffer.from(bytes));
      if (event === 'swallow') continue;
      if (event) emit(event); else keys.push(...bytes);
    }
    if (keys.length) events.push({ kind: 'keys', data: Buffer.from(keys) });
    return events;
  }
  // A bare Escape has no terminator; the caller flushes it after the usual 30 ms ambiguity timeout.
  flush(): SplitInputEvent[] {
    if (this.pending.length !== 1) return [];
    this.pending = [];
    return [{ kind: 'keys', data: Buffer.from([ESC]) }];
  }
  private classify(bytes: Buffer): SplitInputEvent | 'swallow' | null {
    const sequence = bytes.toString('latin1');
    if (sequence === '\x1b[200~') { this.paste = true; return null; }
    if (sequence === '\x1b[201~') { this.paste = false; return null; }
    if (this.paste) return null;
    const mouse = sequence.match(MOUSE);
    if (mouse) return { kind: 'mouse', button: Number(mouse[1]), x: Number(mouse[2]) - 1, y: Number(mouse[3]) - 1, release: mouse[4] === 'm' };
    const pane = sequence.match(PANE);
    if (pane) return pane[1] === '3' ? 'swallow' : { kind: 'pane', data: bytes };
    const home = sequence.match(HOME);
    if (home) return home[1] === '3' ? 'swallow' : { kind: 'home' };
    return null;
  }
}
