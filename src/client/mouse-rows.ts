export type Encoding = 'default' | 'utf8' | 'sgr' | 'urxvt';
export interface MouseState { tracking: boolean; encoding: Encoding }

// eslint-disable-next-line no-control-regex -- Mouse reports are terminal control sequences.
const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
// eslint-disable-next-line no-control-regex -- Mouse reports are terminal control sequences.
const URXVT = /\x1b\[(\d+);(\d+);(\d+)M/g;
const PASTE_START = '\x1b[200~', PASTE_END = '\x1b[201~';

// Button codes: low 2 bits 3 = release (legacy encodings), +32 = motion, 64/65 = wheel.
// A press dropped on the bar also drops its release, so the agent never sees half a click.
function shifter(): (button: number, row: number, release: boolean) => number | null {
  let pressDropped = false;
  return (button, row, release) => {
    const isWheel = (button & 64) !== 0, isMotion = (button & 32) !== 0;
    if (release && pressDropped) { pressDropped = false; return null; }
    if (row > 1) return row - 1;
    if (release || isMotion) return isWheel ? null : 1;
    if (!isWheel) pressDropped = true;
    return null;
  };
}

export class MouseRewriter {
  private carry: Buffer = Buffer.alloc(0);
  private paste = false;
  private readonly shift = shifter();
  dropped = 0;
  constructor(private readonly state: () => MouseState) {}
  push(chunk: Buffer): Buffer {
    const { tracking, encoding } = this.state();
    const data = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    this.carry = Buffer.alloc(0);
    if (!tracking) return data;
    // Bracketed paste content is text, never a mouse report.
    const text = data.toString('latin1');
    if (this.paste || text.includes(PASTE_START)) return this.passPaste(data, text);
    if (encoding === 'sgr') return Buffer.from(text.replace(SGR, (_all, b: string, x: string, y: string, final: string) => {
      const row = this.shift(Number(b), Number(y), final === 'm');
      if (row === null) { this.dropped++; return ''; }
      return `\x1b[<${b};${x};${row}${final}`;
    }), 'latin1');
    if (encoding === 'urxvt') return Buffer.from(text.replace(URXVT, (_all, b: string, x: string, y: string) => {
      const button = Number(b) - 32, row = this.shift(button, Number(y), (button & 3) === 3);
      if (row === null) { this.dropped++; return ''; }
      return `\x1b[${b};${x};${row}M`;
    }), 'latin1');
    return this.legacy(data, encoding === 'utf8');
  }
  private passPaste(data: Buffer, text: string): Buffer {
    const start = text.indexOf(PASTE_START), end = text.indexOf(PASTE_END);
    if (end >= 0 && (start < 0 || end > start)) this.paste = false;
    else this.paste = true;
    return data;
  }
  // X10/normal (`CSI M b x y`, each value + 32 in one byte) and UTF-8 1005 (values as UTF-8 code points).
  private legacy(data: Buffer, utf8: boolean): Buffer {
    const out: number[] = [];
    for (let i = 0; i < data.length;) {
      if (data[i] !== 0x1b || data[i + 1] !== 0x5b || data[i + 2] !== 0x4d) { out.push(data[i] ?? 0); i++; continue; }
      const values: number[] = []; let j = i + 3;
      while (values.length < 3 && j < data.length) {
        const first = data[j] ?? 0;
        if (utf8 && first >= 0xc0) { values.push(((first & 0x1f) << 6) | ((data[j + 1] ?? 0) & 0x3f)); j += 2; }
        else { values.push(first); j++; }
      }
      if (values.length < 3 || j > data.length) { this.carry = data.subarray(i); break; }
      const [b = 32, x = 32, y = 32] = values, button = b - 32, row = this.shift(button, y - 32, (button & 3) === 3);
      if (row === null) { this.dropped++; i = j; continue; }
      const encode = (v: number): number[] => utf8 && v >= 128 ? [0xc0 | (v >> 6), 0x80 | (v & 0x3f)] : [v];
      out.push(0x1b, 0x5b, 0x4d, ...encode(b), ...encode(x), ...encode(row + 32));
      i = j;
    }
    return Buffer.from(out);
  }
}
