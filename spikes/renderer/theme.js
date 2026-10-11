import { readFileSync } from 'node:fs';
const tokens = JSON.parse(readFileSync(new URL('../../docs/design/tokens.json', import.meta.url), 'utf8')).color.tokens;
export const theme = {};
for (const token of tokens) {
  if (typeof token.value === 'object') theme[token.name] = token.value.dark;
}
for (const token of tokens) {
  if (typeof token.value === 'string') theme[token.name] = theme[token.value.slice(1, -1)];
}
export function rgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
}
export function styleEscape(cell) {
  return `\x1b[0${cell.bold ? ';1' : ''};38;2;${rgb(cell.fg)};48;2;${rgb(cell.bg)}m`;
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
