import tokens from '../../../docs/design/tokens.json' with { type: 'json' };
import { readFileSync } from 'node:fs';
declare const __AI_TERM_DESIGN__: string | undefined;
// The build embeds the approved document; tsx reads the same source during development.
const design = typeof __AI_TERM_DESIGN__ === 'string' ? __AI_TERM_DESIGN__ : readFileSync(new URL('../../../docs/design.md', import.meta.url), 'utf8');
import type { ThemeName } from '../../shared/protocol.js';
import type { Cell } from './grid.js';
import type { IBufferCell } from '@xterm/headless';
export type ColorName = 'bg' | 'surface' | 'surface-2' | 'line' | 'ink' | 'ink-2' | 'ink-3' | 'accent' | 'on-accent' | 'status-running' | 'status-waiting' | 'status-error' | 'status-done' | 'status-idle' | 'cursor';
export type Colors = Record<ColorName, string>;
function completeColors(colors: Partial<Colors>): Colors {
  for (const key of ['bg', 'surface', 'surface-2', 'line', 'ink', 'ink-2', 'ink-3', 'accent', 'on-accent', 'status-running', 'status-waiting', 'status-error', 'status-done', 'status-idle', 'cursor'] as const) {
    if (typeof colors[key] !== 'string') throw new Error(`Missing color ${key}`);
  }
  return colors as Colors;
}
export interface Theme { name: ThemeName; colors: Colors; defaultBackground: boolean }
function tokenColors(mode: 'dark' | 'light'): Colors {
  const colors: Partial<Colors> = {};
  for (const token of tokens.color.tokens) if (typeof token.value === 'object') colors[token.name as ColorName] = token.value[mode];
  for (const token of tokens.color.tokens) if (typeof token.value === 'string') colors[token.name as ColorName] = colors[token.value.slice(1, -1) as ColorName];
  return completeColors(colors);
}
function documentedPalette(name: 'slate' | 'ink'): Partial<Colors> {
  const line = design.split('\n').find(line => line.startsWith(`- **\`${name}\``));
  if (!line) throw new Error(`Missing ${name} palette in design.md`);
  const result: Partial<Colors> = {};
  for (const match of line.matchAll(/([a-z]+(?:-[23])?) `(#\w{6})`/g)) if (match[1] && match[2]) result[match[1] as ColorName] = match[2].toLowerCase();
  if (Object.keys(result).length !== 8) throw new Error(`Incomplete ${name} palette in design.md`);
  return result;
}
const dark = tokenColors('dark'), light = tokenColors('light'), slate = documentedPalette('slate'), ink = documentedPalette('ink');
export function channels(color: string): number[] { const n = Number.parseInt(color.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
export function mix(color: string, target: string, amount: number): string {
  const end = channels(target);
  return '#' + channels(color).map((n, i) => Math.round(n + ((end[i] ?? n) - n) * amount).toString(16).padStart(2, '0')).join('');
}
function luminance(color: string): number { const [r, g, b] = channels(color).map(n => { const v = n / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return (r ?? 0) * 0.2126 + (g ?? 0) * 0.7152 + (b ?? 0) * 0.0722; }
export function createTheme(name: ThemeName, background?: string): Theme {
  let colors = { ...dark, ...(name === 'slate' || name === 'auto' ? slate : name === 'ink' ? ink : name === 'light' ? light : {}) };
  if (name === 'auto' && background) {
    const isLight = luminance(background) > 0.5, target = isLight ? '#000000' : '#ffffff';
    if (isLight) colors = { ...light };
    colors.bg = background; colors.surface = mix(background, target, 0.05); colors['surface-2'] = mix(background, target, 0.11); colors.line = mix(background, target, 0.24);
    if (!isLight) {
      const original = colors['ink-3'];
      for (let percent = 0; percent <= 100; percent++) {
        colors['ink-3'] = mix(original, target, percent / 100);
        if ((luminance(colors['ink-3']) + 0.05) / (luminance(colors['surface-2']) + 0.05) >= 4.5) break;
      }
    }
  }
  colors['status-running'] = colors.accent; colors['status-done'] = colors['ink-2']; colors['status-idle'] = colors['ink-3'];
  return { name, colors, defaultBackground: name === 'auto' };
}
const ansi = ['#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5', '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff'];
export function cellColor(cell: IBufferCell, foreground: boolean, theme: Theme): string {
  if (foreground ? cell.isFgDefault() : cell.isBgDefault()) return foreground ? theme.colors.ink : theme.colors.surface;
  const n = foreground ? cell.getFgColor() : cell.getBgColor();
  if (foreground ? cell.isFgRGB() : cell.isBgRGB()) return '#' + n.toString(16).padStart(6, '0');
  if (n < 16) return ansi[n] ?? theme.colors.ink;
  const levels = [0, 95, 135, 175, 215, 255];
  const rgb = n < 232 ? [levels[Math.floor((n - 16) / 36)], levels[Math.floor((n - 16) / 6) % 6], levels[(n - 16) % 6]] : Array<number>(3).fill(8 + (n - 232) * 10);
  return '#' + rgb.map(n => (n ?? 0).toString(16).padStart(2, '0')).join('');
}
function colorEscape(color: string, foreground: boolean, truecolor: boolean): string {
  const rgb = channels(color);
  if (truecolor) return `${foreground ? 38 : 48};2;${rgb.join(';')}`;
  let nearest = 0, distance = Infinity;
  for (let i = 16; i < 256; i++) {
    const levels = [0, 95, 135, 175, 215, 255];
    const candidate = i < 232 ? [levels[Math.floor((i - 16) / 36)], levels[Math.floor((i - 16) / 6) % 6], levels[(i - 16) % 6]] : [8 + (i - 232) * 10, 8 + (i - 232) * 10, 8 + (i - 232) * 10];
    const d = rgb.reduce((sum, n, j) => sum + (n - (candidate[j] ?? 0)) ** 2, 0);
    if (d < distance) { distance = d; nearest = i; }
  }
  return `${foreground ? 38 : 48};5;${nearest}`;
}
const styleCache = new Map<string, string>();
export function styleEscape(cell: Cell, theme: Theme, truecolor = true): string {
  const defaultBg = theme.defaultBackground && cell.bg === theme.colors.bg;
  const key = `${cell.fg}/${cell.bg}/${cell.bold}/${cell.italic}/${cell.underline}/${cell.dim}/${defaultBg}/${truecolor}`;
  let style = styleCache.get(key);
  if (!style) {
    style = `\x1b[0${cell.bold ? ';1' : ''}${cell.dim ? ';2' : ''}${cell.italic ? ';3' : ''}${cell.underline ? ';4' : ''};${colorEscape(cell.fg, true, truecolor)};${defaultBg ? '49' : colorEscape(cell.bg, false, truecolor)}m`;
    if (styleCache.size > 4096) styleCache.clear();
    styleCache.set(key, style);
  }
  return style;
}
export const BACKGROUND_QUERY = '\x1b]11;?\x1b\\';
function parseBackground(reply: string): string | null {
  // eslint-disable-next-line no-control-regex -- OSC11 is a terminal control reply.
  const match = reply.match(/^\x1b\]11;rgb:([a-f\d]{2}|[a-f\d]{4})\/([a-f\d]{2}|[a-f\d]{4})\/([a-f\d]{2}|[a-f\d]{4})(?:\x07|\x1b\\)$/i);
  return match ? '#' + match.slice(1).map(part => Math.round(Number.parseInt(part, 16) * 255 / (part.length === 4 ? 65535 : 255)).toString(16).padStart(2, '0')).join('') : null;
}
export class BackgroundReplies {
  private pending = '';
  constructor(private readonly reply: (background: string) => void) {}
  push(chunk: Buffer): Buffer {
    const output: number[] = [];
    for (const byte of chunk) {
      if (!this.pending) { if (byte === 27) this.pending = '\x1b'; else output.push(byte); continue; }
      this.pending += String.fromCharCode(byte);
      if (this.pending === '\x1b]') continue;
      if (this.pending.startsWith('\x1b]')) {
        const header = '\x1b]11;';
        if (byte === 7 || this.pending.endsWith('\x1b\\')) { const bg = parseBackground(this.pending); if (bg) this.reply(bg); this.pending = ''; }
        else if (!header.startsWith(this.pending) && !this.pending.startsWith(header)) { output.push(...Buffer.from(this.pending, 'latin1')); this.pending = ''; }
        // eslint-disable-next-line no-control-regex -- Permit only bounded OSC11 RGB candidates.
        else if (this.pending.length > 64 || this.pending.startsWith(header) && !/^\x1b\]11;[rgba-f\d:/\x1b]*$/i.test(this.pending)) this.pending = '';
      } else { output.push(...Buffer.from(this.pending, 'latin1')); this.pending = ''; }
    }
    return Buffer.from(output);
  }
  flush(): Buffer { const data = this.pending === '\x1b' ? Buffer.from(this.pending) : Buffer.alloc(0); this.pending = ''; return data; }
}
