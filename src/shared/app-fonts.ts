import { chromeFontSize, monoFont, sansFont, terminalFontSize } from './theme-tokens.js';

// v1.2.6: the AI Term app's own fonts (/settings → app fonts). A terminal running ai keeps whatever font it uses; these
// reach only the app's window. A family is a name and nothing else (no quotes, commas or CSS), so it can be put first in
// the token chain as one quoted CSS family; the chain after it covers a family that isn't installed. No font is shipped.
export interface AppFonts { terminal?: string; terminalSize?: number; chrome?: string; chromeSize?: number; ligatures?: boolean }
export const TERMINAL_SIZES = { min: 9, max: 32 } as const;
export const CHROME_SIZES = { min: 11, max: 18 } as const;
export const FONT_NAME_RULE = 'a font name takes letters, digits, spaces, dots, dashes and underscores';
export function isFontFamily(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,46}[A-Za-z0-9._-])?$/.test(value); }
const inRange = (value: unknown, range: { min: number; max: number }): value is number => typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max;
export function validateAppFonts(value: unknown): AppFonts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid app fonts');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['terminal', 'terminalSize', 'chrome', 'chromeSize', 'ligatures'].includes(k))
    || v.terminal !== undefined && !isFontFamily(v.terminal) || v.chrome !== undefined && !isFontFamily(v.chrome)
    || v.terminalSize !== undefined && !inRange(v.terminalSize, TERMINAL_SIZES) || v.chromeSize !== undefined && !inRange(v.chromeSize, CHROME_SIZES)
    || v.ligatures !== undefined && typeof v.ligatures !== 'boolean') throw new Error('Invalid app fonts');
  return { ...v } as AppFonts;
}
export interface FontStacks { terminal: string; terminalSize: number; chrome: string; chromeSize: number; ligatures: boolean }
export function fontStacks(fonts: AppFonts | undefined): FontStacks {
  return {
    terminal: fonts?.terminal ? `"${fonts.terminal}", ${monoFont}` : monoFont, terminalSize: fonts?.terminalSize ?? terminalFontSize,
    chrome: fonts?.chrome ? `"${fonts.chrome}", ${sansFont}` : sansFont, chromeSize: fonts?.chromeSize ?? chromeFontSize,
    ligatures: fonts?.ligatures === true,
  };
}
// The exact stacks fontStacks can make: what the app's renderer accepts, so nothing else ever reaches its CSS.
export function isFontStack(value: unknown, chain: string): value is string {
  if (value === chain) return true;
  const prefix = typeof value === 'string' && value.endsWith(`", ${chain}`) && value.startsWith('"') ? value.slice(1, -`", ${chain}`.length) : null;
  return prefix !== null && isFontFamily(prefix);
}
export function describeFonts(fonts: AppFonts | undefined): string {
  const s = fontStacks(fonts);
  return `terminal ${fonts?.terminal ?? 'default'} ${s.terminalSize} · chrome ${fonts?.chrome ?? 'default'} ${s.chromeSize} · ligatures ${s.ligatures ? 'on' : 'off'}`;
}
