import { isBuiltinTheme, relativeLuminance, themeColors, type ThemeVariant } from '../../shared/theme-tokens.js';
export type { ColorName, Colors } from '../../shared/theme-tokens.js';
import type { Colors } from '../../shared/theme-tokens.js';
import type { ThemeName, ThemeVariantSetting } from '../../shared/protocol.js';
import type { UserTheme } from '../../shared/user-themes.js';
import type { Cell } from './grid.js';
import type { IBufferCell } from '@xterm/headless';
export interface Theme { name: ThemeName; colors: Colors; defaultBackground: boolean }
export function channels(color: string): number[] { const n = Number.parseInt(color.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
export function mix(color: string, target: string, amount: number): string {
  const end = channels(target);
  return '#' + channels(color).map((n, i) => Math.round(n + ((end[i] ?? n) - n) * amount).toString(16).padStart(2, '0')).join('');
}
// v1.2.6: system is dark or light by the terminal's own background (OSC 11; in the app that is the window, which follows
// macOS). No answer is dark, as every theme was before variants.
export function resolveVariant(variant: ThemeVariantSetting, background?: string): ThemeVariant {
  if (variant !== 'system') return variant;
  return background && relativeLuminance(background) > 0.5 ? 'light' : 'dark';
}
// A built-in or a theme file of your own (its colors passed in), in a variant; light is the old name of graphite light.
// A name with no colors (a file that went away) is graphite, so nothing is ever half-applied.
export function createTheme(name: ThemeName, background?: string, variant: ThemeVariantSetting = 'dark', user?: UserTheme): Theme {
  if (name === 'auto') return autoTheme(background);
  const resolved = name === 'light' ? 'light' : resolveVariant(variant, background);
  const colors = isBuiltinTheme(name) ? themeColors(name, resolved) : user && user.name === name ? { ...user[resolved] } : themeColors('graphite', name === 'light' ? 'light' : resolved);
  return { name, colors, defaultBackground: false };
}
// auto ("match my terminal"): the ground is never painted (SGR 49); panels are mixed from the terminal's background
// toward white (or black on a light one), and dark ink-3 is raised until it holds 4.5:1 on surface-2 (design.md).
function autoTheme(background?: string): Theme {
  let colors = themeColors('slate', 'dark');
  if (background) {
    const isLight = relativeLuminance(background) > 0.5, target = isLight ? '#000000' : '#ffffff';
    if (isLight) colors = themeColors('graphite', 'light');
    colors.bg = background; colors.surface = mix(background, target, 0.05); colors['surface-2'] = mix(background, target, 0.11); colors.line = mix(background, target, 0.24);
    if (!isLight) {
      const original = colors['ink-3'];
      for (let percent = 0; percent <= 100; percent++) {
        colors['ink-3'] = mix(original, target, percent / 100);
        if ((relativeLuminance(colors['ink-3']) + 0.05) / (relativeLuminance(colors['surface-2']) + 0.05) >= 4.5) break;
      }
    }
  }
  colors['status-running'] = colors.accent; colors['status-done'] = colors['ink-2']; colors['status-idle'] = colors['ink-3'];
  return { name: 'auto', colors, defaultBackground: true };
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
  const key = `${cell.fg}/${cell.bg}/${cell.bold}/${cell.italic}/${cell.underline}/${cell.underlineColor}/${cell.dim}/${defaultBg}/${truecolor}`;
  let style = styleCache.get(key);
  if (!style) {
    style = `\x1b[0${cell.bold ? ';1' : ''}${cell.dim ? ';2' : ''}${cell.italic ? ';3' : ''}${cell.underline ? ';4' : ''};${colorEscape(cell.fg, true, truecolor)};${defaultBg ? '49' : colorEscape(cell.bg, false, truecolor)}m`;
    // Underline color in the colon form only: a terminal that doesn't know it skips the whole sequence (the underline
    // then takes the text color) instead of misreading `58;2;r;g;b` as dim plus colors.
    if (truecolor && cell.underline && cell.underlineColor) style += `\x1b[58:2::${channels(cell.underlineColor).join(':')}m`;
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
  private pasted = false;
  private pasteEnd = '';
  constructor(private readonly reply: (background: string) => void) {}
  push(chunk: Buffer): Buffer {
    const output: number[] = [];
    for (const byte of chunk) {
      // OSC11-looking bytes inside a bracketed paste are message content, never a terminal reply.
      if (this.pasted) {
        output.push(byte); this.pasteEnd = (this.pasteEnd + String.fromCharCode(byte)).slice(-6);
        if (this.pasteEnd === '\x1b[201~') { this.pasted = false; this.pasteEnd = ''; }
        continue;
      }
      if (!this.pending) { if (byte === 27) this.pending = '\x1b'; else output.push(byte); continue; }
      // A typed Escape can immediately precede a terminal reply. Keep the new
      // prefix so query traffic is consumed rather than becoming agent keys.
      if (this.pending === '\x1b' && byte === 27) { output.push(27); continue; }
      this.pending += String.fromCharCode(byte);
      if (this.pending.startsWith('\x1b[')) {
        const start = '\x1b[200~';
        if (this.pending === start) { output.push(...Buffer.from(this.pending, 'latin1')); this.pending = ''; this.pasted = true; }
        else if (!start.startsWith(this.pending)) { output.push(...Buffer.from(this.pending, 'latin1')); this.pending = ''; }
        continue;
      }
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
  flush(): Buffer { const data = this.pending === '\x1b' ? Buffer.from(this.pending) : Buffer.alloc(0); if(!this.pending.startsWith('\x1b['))this.pending = ''; return data; }
}
