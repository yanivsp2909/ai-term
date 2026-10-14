import tokens from '../../docs/design/tokens.json' with { type: 'json' };
export type ColorName = 'bg' | 'surface' | 'surface-2' | 'line' | 'ink' | 'ink-2' | 'ink-3' | 'accent' | 'on-accent' | 'status-running' | 'status-waiting' | 'status-error' | 'status-done' | 'status-idle' | 'cursor';
export type Colors = Record<ColorName, string>;
export const monoFont = tokens.type.families.mono;
export const sansFont = tokens.type.families.sans;
export const terminalFontSize = Number.parseInt(tokens.type.groups[0]?.styles[0]?.fontSize ?? '13', 10);
export function tokenColors(mode: 'dark' | 'light'): Colors {
  const colors: Partial<Colors> = {};
  for (const token of tokens.color.tokens) if (typeof token.value === 'object') colors[token.name as ColorName] = token.value[mode];
  for (const token of tokens.color.tokens) if (typeof token.value === 'string') colors[token.name as ColorName] = colors[token.value.slice(1, -1) as ColorName];
  for (const token of tokens.color.tokens) if (!colors[token.name as ColorName]) throw new Error(`Missing color ${token.name}`);
  return colors as Colors;
}
