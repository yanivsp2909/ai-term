import headless from '@xterm/headless';
import type { IBufferCell } from '@xterm/headless';

const CM_MASK = 0x3000000, CM_P16 = 0x1000000, CM_P256 = 0x2000000, CM_RGB = 0x3000000;
const WIDE_TAIL = '\u0000tail';

function color(value: number, fg: boolean): string {
  if (value < 0) return ''; // xterm reports a default color as -1
  const mode = value & CM_MASK, n = value & 0xffffff;
  if (mode === CM_P16) return n < 8 ? `;${(fg ? 30 : 40) + n}` : `;${(fg ? 90 : 100) + n - 8}`;
  if (mode === CM_P256) return `;${fg ? 38 : 48};5;${n}`;
  if (mode === CM_RGB) return `;${fg ? 38 : 48};2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
  return '';
}
function attributes(cell: IBufferCell): number {
  return (cell.isBold() ? 1 : 0) | (cell.isDim() ? 2 : 0) | (cell.isItalic() ? 4 : 0) | (cell.isUnderline() ? 8 : 0) | (cell.isBlink() ? 16 : 0)
    | (cell.isInverse() ? 32 : 0) | (cell.isInvisible() ? 64 : 0) | (cell.isStrikethrough() ? 128 : 0) | (cell.isOverline() ? 256 : 0);
}
const SGR_CODES: [number, string][] = [[1, ';1'], [2, ';2'], [4, ';3'], [8, ';4'], [16, ';5'], [32, ';7'], [64, ';8'], [128, ';9'], [256, ';53']];
const styleCache = new Map<string, string>();
function style(fg: number, bg: number, attr: number): string {
  const key = `${fg}/${bg}/${attr}`;
  let value = styleCache.get(key);
  if (value === undefined) {
    // Always start from SGR 0, so no attribute from a previous run can leak into this one.
    value = '\x1b[0' + SGR_CODES.filter(([bit]) => attr & bit).map(([, code]) => code).join('') + color(fg, true) + color(bg, false) + 'm';
    if (styleCache.size > 4096) styleCache.clear();
    styleCache.set(key, value);
  }
  return value;
}

export class BodyRenderer {
  private chars: string[] = [];
  private fg = new Int32Array(0);
  private bg = new Int32Array(0);
  private attr = new Int32Array(0);
  private width = new Uint8Array(0);
  private valid = false;
  private cursor = '';
  private readonly scratch: IBufferCell;
  cursorVisible = true;
  constructor(private readonly term: headless.Terminal, private readonly top: number) {
    this.scratch = term.buffer.active.getNullCell();
    this.invalidate();
  }
  invalidate(): void {
    const size = this.term.cols * this.term.rows;
    this.chars = new Array<string>(size).fill('');
    this.fg = new Int32Array(size); this.bg = new Int32Array(size); this.attr = new Int32Array(size); this.width = new Uint8Array(size);
    this.valid = false; this.cursor = '';
  }
  // Returns the escape string for every changed cell plus the cursor, or '' when nothing changed.
  frame(forceCursor=false): string {
    const buffer = this.term.buffer.active, cols = this.term.cols, rows = this.term.rows;
    let out = '', lastStyle = '';
    for (let y = 0; y < rows; y++) {
      const line = buffer.getLine(buffer.viewportY + y);
      let positioned = false;
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x, cell = line?.getCell(x, this.scratch);
        const w = cell ? cell.getWidth() : 1;
        if (w === 0) { positioned = false; continue; }
        const ch = cell?.getChars() || ' ';
        const fg = cell ? cell.getFgColorMode() | cell.getFgColor() : -1, bg = cell ? cell.getBgColorMode() | cell.getBgColor() : -1, at = cell ? attributes(cell) : 0;
        if (this.valid && this.chars[i] === ch && this.fg[i] === fg && this.bg[i] === bg && this.attr[i] === at && this.width[i] === w) {
          positioned = false; if (w === 2) x++; continue;
        }
        this.chars[i] = ch; this.fg[i] = fg; this.bg[i] = bg; this.attr[i] = at; this.width[i] = w;
        if (!positioned) out += `\x1b[${y + 1 + this.top};${x + 1}H`;
        const s = style(fg, bg, at); if (s !== lastStyle) { out += s; lastStyle = s; }
        out += ch;
        // After anything but plain ASCII, address the next cell absolutely. If the real terminal
        // disagrees with the mirror about a character's width, the damage stays inside that cell.
        positioned = w === 1 && ch.length === 1 && ch.charCodeAt(0) < 0x7f;
        if (w === 2) { x++; if (x < cols) { this.chars[i + 1] = WIDE_TAIL; this.width[i + 1] = 0; } }
      }
    }
    this.valid = true;
    const cursor = `\x1b[${buffer.cursorY + 1 + this.top};${Math.min(buffer.cursorX, cols - 1) + 1}H${this.cursorVisible ? '\x1b[?25h' : ''}`;
    if (!out && cursor === this.cursor && !forceCursor) return '';
    this.cursor = cursor;
    // Hide the cursor while painting: terminals without synchronized output (Terminal.app) would
    // otherwise show it jumping across the changed cells.
    return '\x1b[?25l' + out + '\x1b[0m' + cursor;
  }
}
