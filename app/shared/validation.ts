import { pasteErrors, type TerminalSize, type AppTheme, type AppLook } from './api.js';
import { BASE_COLOR_NAMES, DERIVED_COLORS, monoFont, sansFont, type Colors } from '../../src/shared/theme-tokens.js';
import { CHROME_SIZES, TERMINAL_SIZES, isFontStack } from '../../src/shared/app-fonts.js';
export function validateAppTheme(value: unknown): AppTheme {
  if (value !== 'light' && value !== 'dark') throw new Error('Invalid theme acknowledgement');
  return value;
}
// v1.2.6: the look main sends is checked in preload before the renderer sees it: hex colors for exactly the token names,
// and only the font stacks fontStacks() can make (a family put first in the token chain), so nothing else reaches CSS.
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function isColors(value: unknown): value is Colors {
  const names = [...BASE_COLOR_NAMES, ...DERIVED_COLORS.keys()];
  return object(value) && Object.keys(value).length === names.length && names.every(name => typeof value[name] === 'string' && /^#[0-9a-fA-F]{6}$/.test(value[name]));
}
const size = (value: unknown, range: { min: number; max: number }): boolean => typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max;
export function validateLook(value: unknown): AppLook {
  if (!object(value) || Object.keys(value).length !== 3 || (value.mode !== 'dark' && value.mode !== 'light') || !isColors(value.colors)) throw new Error('Invalid app look');
  const f = value.fonts;
  if (!object(f) || Object.keys(f).length !== 5 || !isFontStack(f.terminal, monoFont) || !isFontStack(f.chrome, sansFont) || !size(f.terminalSize, TERMINAL_SIZES) || !size(f.chromeSize, CHROME_SIZES) || typeof f.ligatures !== 'boolean') throw new Error('Invalid app look');
  return { mode: value.mode, colors: { ...value.colors }, fonts: { terminal: f.terminal, terminalSize: f.terminalSize as number, chrome: f.chrome, chromeSize: f.chromeSize as number, ligatures: f.ligatures } };
}
export const MAX_WRITE_BYTES = 64 * 1024;
export const MAX_COPY_BYTES = 5 * 1024 * 1024;
export function validateWrite(value: unknown, limit = MAX_WRITE_BYTES): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > limit) throw new Error('Terminal text exceeds limit or is invalid');
  return value;
}
export class PasteRefusal extends Error {}
export function validatePaste(value: unknown): string {
  if (typeof value !== 'string') throw new PasteRefusal(pasteErrors.unavailable);
  if (Buffer.byteLength(value, 'utf8') > MAX_WRITE_BYTES - 12) throw new PasteRefusal(pasteErrors.size);
  // xterm wraps but does not escape clipboard ESC bytes. An embedded paste-end marker
  // could turn subsequent text into an approval key in ai, so refuse before forwarding.
  if (value.includes('\x1b')) throw new PasteRefusal(pasteErrors.controls);
  return value;
}
export function validateSize(value: unknown): TerminalSize {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid terminal size');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 2 || typeof v.cols !== 'number' || typeof v.rows !== 'number' ||
    !Number.isSafeInteger(v.cols) || !Number.isSafeInteger(v.rows) || v.cols < 2 || v.cols > 500 || v.rows < 2 || v.rows > 300) throw new Error('Invalid terminal size');
  return { cols: v.cols, rows: v.rows };
}
export function validateUrl(value: unknown): string {
  // URL() repairs whitespace and controls; reject them before parsing instead.
  if (typeof value !== 'string' || value.length > 8192 || value.trim() !== value || /[\p{C}\p{Zl}\p{Zp}]/u.test(value) || !/^https?:\/\//i.test(value)) throw new Error('Only http/https links are allowed');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('Only http/https links are allowed');
  return url.href;
}
export function validateEmpty(args: readonly unknown[]): void {
  if (args.length !== 0) throw new Error('Unexpected terminal message payload');
}
export function validateOne(args: readonly unknown[]): unknown {
  if (args.length !== 1) throw new Error('Invalid terminal message payload');
  return args[0];
}
