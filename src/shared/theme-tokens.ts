import tokens from '../../docs/design/tokens.json' with { type: 'json' };
export type ColorName = 'bg' | 'surface' | 'surface-2' | 'line' | 'ink' | 'ink-2' | 'ink-3' | 'accent' | 'on-accent' | 'status-running' | 'status-waiting' | 'status-error' | 'status-done' | 'status-idle' | 'cursor';
export type Colors = Record<ColorName, string>;
export type BuiltinThemeId = 'graphite' | 'slate' | 'ink' | 'dune' | 'contrast';
export type ThemeVariant = 'dark' | 'light';
export const monoFont = tokens.type.families.mono;
export const sansFont = tokens.type.families.sans;
export const terminalFontSize = Number.parseInt(tokens.type.groups[0]?.styles[0]?.fontSize ?? '13', 10);
export const chromeFontSize = Number.parseInt(tokens.type.groups[1]?.styles[0]?.fontSize ?? '13', 10);

// v1.2.6: every theme is a column of docs/design/tokens.json (value.<theme>.<variant>); a token whose value is `{name}`
// is derived from that token in every theme (running = accent, done = ink-2, idle = ink-3).
export const BUILTIN_THEMES: readonly { id: BuiltinThemeId; name: string }[] = tokens.color.themes.map(t => ({ id: t.id as BuiltinThemeId, name: t.name }));
export function isBuiltinTheme(value: unknown): value is BuiltinThemeId { return BUILTIN_THEMES.some(t => t.id === value); }
const DERIVED = new Map(tokens.color.tokens.flatMap(t => typeof t.value === 'string' ? [[t.name as ColorName, t.value.slice(1, -1) as ColorName]] : []));
// The tokens a theme file gives; the derived ones it may not.
export const BASE_COLOR_NAMES: readonly ColorName[] = tokens.color.tokens.filter(t => typeof t.value === 'object').map(t => t.name as ColorName);
export const DERIVED_COLORS: ReadonlyMap<ColorName, ColorName> = DERIVED;
export function deriveColors(base: Readonly<Partial<Colors>>): Colors {
  const colors: Partial<Colors> = { ...base };
  for (const [name, from] of DERIVED) colors[name] = colors[from];
  for (const token of tokens.color.tokens) if (!colors[token.name as ColorName]) throw new Error(`Missing color ${token.name}`);
  return colors as Colors;
}
export function themeColors(id: BuiltinThemeId, variant: ThemeVariant): Colors {
  const base: Partial<Colors> = {};
  for (const token of tokens.color.tokens) if (typeof token.value === 'object') base[token.name as ColorName] = (token.value as Record<string, Record<ThemeVariant, string>>)[id]?.[variant];
  return deriveColors(base);
}
// The graphite column, as before v1.2.6 (the remote page, /export and the app's first paint use it).
export function tokenColors(mode: ThemeVariant): Colors { return themeColors('graphite', mode); }

function channel(n: number): number { const v = n / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }
export function relativeLuminance(color: string): number {
  const n = Number.parseInt(color.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
// WCAG 2 contrast ratio, 1 to 21.
export function contrastRatio(a: string, b: string): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}
