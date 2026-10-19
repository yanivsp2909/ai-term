import { describe, expect, it } from 'vitest';
import tokens from '../docs/design/tokens.json' with { type: 'json' };
import { BASE_COLOR_NAMES, BUILTIN_THEMES, contrastRatio, isBuiltinTheme, themeColors, tokenColors, type ColorName } from '../src/shared/theme-tokens.js';
import { createTheme, resolveVariant } from '../src/client/tui/theme.js';
import type { UserTheme } from '../src/shared/user-themes.js';
import { isThemeName, isThemeVariant } from '../src/shared/validate.js';

// v1.2.6 themes: every theme comes from docs/design/tokens.json through the one theme module, each with a dark and a
// light variant, and every text token reads at 4.5:1 or better on the three grounds it is drawn on.
const TEXT: readonly ColorName[] = ['ink', 'ink-2', 'ink-3', 'accent', 'status-waiting', 'status-error'];
const GROUNDS: readonly ColorName[] = ['bg', 'surface', 'surface-2'];

describe('the built-in themes', () => {
  it('are graphite, slate, ink, dune and high contrast, listed in tokens.json, each with dark and light', () => {
    expect(BUILTIN_THEMES.map(t => t.id)).toEqual(['graphite', 'slate', 'ink', 'dune', 'contrast']);
    expect(tokens.color.themes.map(t => t.id)).toEqual(BUILTIN_THEMES.map(t => t.id));
    expect(BUILTIN_THEMES.find(t => t.id === 'contrast')?.name).toBe('High contrast');
    for (const { id } of BUILTIN_THEMES) for (const variant of ['dark', 'light'] as const) {
      const colors = themeColors(id, variant);
      for (const name of BASE_COLOR_NAMES) expect(colors[name], `${id} ${variant} ${name}`).toMatch(/^#[0-9a-f]{6}$/);
      // The derived tokens stay what design.md says: running is the accent, done is ink-2, idle is ink-3.
      expect([colors['status-running'], colors['status-done'], colors['status-idle']]).toEqual([colors.accent, colors['ink-2'], colors['ink-3']]);
    }
  });

  it('every text token holds 4.5:1 on bg, surface and surface-2, and on-accent on accent, in every theme and variant', () => {
    const low: string[] = [];
    for (const { id } of BUILTIN_THEMES) for (const variant of ['dark', 'light'] as const) {
      const c = themeColors(id, variant);
      for (const text of TEXT) for (const ground of GROUNDS) if (contrastRatio(c[text], c[ground]) < 4.5) low.push(`${id} ${variant} ${text} on ${ground}: ${contrastRatio(c[text], c[ground]).toFixed(2)}`);
      if (contrastRatio(c['on-accent'], c.accent) < 4.5) low.push(`${id} ${variant} on-accent on accent`);
    }
    expect(low).toEqual([]);
  });

  it('high contrast holds 6:1 for every text token', () => {
    for (const variant of ['dark', 'light'] as const) {
      const c = themeColors('contrast', variant);
      for (const text of TEXT) for (const ground of GROUNDS) expect(contrastRatio(c[text], c[ground]), `${variant} ${text} on ${ground}`).toBeGreaterThanOrEqual(6);
    }
  });

  it('keeps the approved values: graphite is the old dark and light, slate and ink the old dark palettes', () => {
    expect(tokenColors('dark')).toEqual(themeColors('graphite', 'dark'));
    expect(tokenColors('light')).toEqual(themeColors('graphite', 'light'));
    expect(themeColors('graphite', 'dark')).toMatchObject({ bg: '#1e1f22', ink: '#e8e9ec', accent: '#5ad8cc', 'status-waiting': '#f5bc55' });
    expect(themeColors('graphite', 'light')).toMatchObject({ bg: '#fafaf9', ink: '#1b1d21', accent: '#07706a' });
    expect(themeColors('slate', 'dark')).toMatchObject({ bg: '#1b2029', surface: '#232935', 'surface-2': '#2d3443', line: '#46506a', ink: '#e6eaf0', 'ink-2': '#aeb6c4', 'ink-3': '#9aa4b5', accent: '#58d6c9' });
    expect(themeColors('ink', 'dark')).toMatchObject({ bg: '#111317', surface: '#191c21', 'surface-2': '#242830', line: '#3a3f48', ink: '#e6e8eb', 'ink-2': '#a3a9b4', 'ink-3': '#8e96a3', accent: '#4fd1c5' });
  });

  it('graphite stays at value.dark and value.light, where readers of the old shape look (spikes/renderer/theme.js, the A/B noise)', async () => {
    for (const token of tokens.color.tokens) if (typeof token.value === 'object') {
      const value = token.value as unknown as Record<string, unknown>;
      expect([value.dark, value.light], token.name).toEqual([themeColors('graphite', 'dark')[token.name as ColorName], themeColors('graphite', 'light')[token.name as ColorName]]);
    }
    const spike = await import('../spikes/renderer/theme.js') as { dark: Record<string, string> };
    expect(spike.dark.bg).toBe(themeColors('graphite', 'dark').bg);
  });

  it('contrastRatio is the WCAG ratio', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
  });
});

describe('createTheme', () => {
  const ocean: UserTheme = { name: 'ocean', label: 'Ocean', dark: { ...themeColors('slate', 'dark'), bg: '#0a1a2a' }, light: { ...themeColors('slate', 'light'), bg: '#f0f8ff' } };
  it('takes a theme and a variant; light is the old name for graphite light', () => {
    expect(createTheme('slate', undefined, 'light').colors.bg).toBe(themeColors('slate', 'light').bg);
    expect(createTheme('dune').colors.bg).toBe(themeColors('dune', 'dark').bg);
    expect(createTheme('light').colors.bg).toBe(themeColors('graphite', 'light').bg);
    expect(createTheme('light', undefined, 'dark').colors.bg).toBe(themeColors('graphite', 'light').bg);
  });
  it('system picks the variant from the terminal background; no answer is dark', () => {
    expect(resolveVariant('system', '#ffffff')).toBe('light');
    expect(resolveVariant('system', '#101010')).toBe('dark');
    expect(resolveVariant('system', undefined)).toBe('dark');
    expect(resolveVariant('light', '#000000')).toBe('light');
    expect(createTheme('contrast', '#f5f5f5', 'system').colors.bg).toBe(themeColors('contrast', 'light').bg);
  });
  it('a user theme uses its own colors; without them it is graphite', () => {
    expect(createTheme('ocean', undefined, 'dark', ocean).colors.bg).toBe('#0a1a2a');
    expect(createTheme('ocean', '#ffffff', 'system', ocean).colors.bg).toBe('#f0f8ff');
    expect(createTheme('ocean').colors.bg).toBe(themeColors('graphite', 'dark').bg);
    expect(createTheme('ocean', undefined, 'dark', ocean).colors['status-running']).toBe(ocean.dark.accent);
  });
  it('auto still matches the terminal: its ground is never painted', () => {
    const auto = createTheme('auto', '#202020');
    expect(auto.defaultBackground).toBe(true);
    expect(auto.colors.bg).toBe('#202020');
  });
});

describe('theme names and variants in settings', () => {
  it('a built-in, auto, light or a user file name; dark, light or system', () => {
    for (const name of ['graphite', 'slate', 'ink', 'dune', 'contrast', 'auto', 'light', 'ocean', 'my-theme-2']) expect(isThemeName(name), name).toBe(true);
    for (const name of ['', 'Ocean', 'my theme', '../x', 'a'.repeat(40), 7, null]) expect(isThemeName(name), String(name)).toBe(false);
    expect(isBuiltinTheme('dune')).toBe(true); expect(isBuiltinTheme('ocean')).toBe(false); expect(isBuiltinTheme('auto')).toBe(false);
    for (const v of ['dark', 'light', 'system']) expect(isThemeVariant(v)).toBe(true);
    expect(isThemeVariant('auto')).toBe(false);
  });
});
