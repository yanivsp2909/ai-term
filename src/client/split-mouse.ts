import type { Encoding } from './mouse-rows.js';
// A split keeps the real terminal in any-motion SGR mode so a click can focus any pane. Each event is re-encoded for
// the pane under the pointer in that agent's own tracking level and encoding, the way a real terminal would send it.
export type Tracking = 'none' | 'x10' | 'vt200' | 'drag' | 'any';
export interface PaneMouse { tracking: Tracking; encoding: Encoding }
export interface MouseEvent { button: number; x: number; y: number; release: boolean }
const MOTION = 32, WHEEL = 64, MODIFIERS = 4 | 8 | 16;
function wanted(event: MouseEvent, tracking: Tracking): boolean {
  const motion = (event.button & MOTION) !== 0, wheel = (event.button & WHEEL) !== 0;
  if (tracking === 'none') return false;
  if (tracking === 'x10') return !event.release && !motion;
  if (tracking === 'vt200') return !motion;
  if (tracking === 'drag') return !motion || wheel || (event.button & 3) !== 3;
  return true;
}
// Pane-relative 0-based cell in, the bytes the agent would read out; null when the agent didn't ask for this event or
// its encoding can't address the cell.
export function encodeMouse(event: MouseEvent, state: PaneMouse): Buffer | null {
  if (!wanted(event, state.tracking)) return null;
  const button = state.tracking === 'x10' ? event.button & ~MODIFIERS : event.button, x = event.x + 1, y = event.y + 1;
  if (state.encoding === 'sgr') return Buffer.from(`\x1b[<${button};${x};${y}${event.release ? 'm' : 'M'}`, 'latin1');
  // The older encodings have no release flag of their own: a release is button 3.
  const code = event.release ? (button & ~3) | 3 : button;
  if (state.encoding === 'urxvt') return Buffer.from(`\x1b[${code + 32};${x};${y}M`, 'latin1');
  const values = [code + 32, x + 32, y + 32];
  if (state.encoding === 'utf8') return values.every(v => v < 2048) ? Buffer.from('\x1b[M' + String.fromCodePoint(...values), 'utf8') : null;
  return values.every(v => v < 256) ? Buffer.from([0x1b, 0x5b, 0x4d, ...values]) : null;
}
