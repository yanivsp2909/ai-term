import { readFileSync } from 'node:fs';
const tokens = JSON.parse(readFileSync(new URL('../../docs/design/tokens.json', import.meta.url), 'utf8')).color.tokens;
function tokenTheme(mode) {
  const result = {};
  for (const token of tokens) if (typeof token.value === 'object') result[token.name] = token.value[mode];
  for (const token of tokens) if (typeof token.value === 'string') result[token.name] = result[token.value.slice(1, -1)];
  return result;
}
export const dark = tokenTheme('dark'), light = tokenTheme('light');
export const theme = { ...dark };
let defaultBackground = false;
export function usePalette(palette) {
  Object.assign(theme, palette.colors);
  defaultBackground = palette.defaultBackground;
}
export function rgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
}
export function styleEscape(cell) {
  const background = defaultBackground && cell.bg.toLowerCase() === theme.bg.toLowerCase() ? '49' : `48;2;${rgb(cell.bg)}`;
  return `\x1b[0${cell.bold ? ';1' : ''};38;2;${rgb(cell.fg)};${background}m`;
}
export function colorOf(cell, foreground) {
  const mode = foreground ? 'Fg' : 'Bg';
  const fallback = foreground ? theme.ink : theme.surface;
  if (cell[`is${mode}Default`]()) return fallback;
  const n = cell[`get${mode}Color`]();
  if (cell[`is${mode}RGB`]()) return `#${n.toString(16).padStart(6, '0')}`;
  const ansi = [theme.bg, theme['status-error'], theme.accent, theme['status-waiting'], theme['ink-2'], theme['status-error'], theme.accent, theme.ink];
  if (n < 16) return ansi[n % 8];
  const levels = [0, 95, 135, 175, 215, 255];
  const value = n < 232 ? [levels[Math.floor((n - 16) / 36)], levels[Math.floor((n - 16) / 6) % 6], levels[(n - 16) % 6]] : Array(3).fill(8 + (n - 232) * 10);
  return `#${value.map(c => c.toString(16).padStart(2, '0')).join('')}`;
}
