import { pasteErrors, type TerminalSize } from './api.js';
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
