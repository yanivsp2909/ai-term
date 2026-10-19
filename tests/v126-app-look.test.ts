import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monoFont, sansFont, themeColors, BASE_COLOR_NAMES } from '../src/shared/theme-tokens.js';
import { describeFonts, validateAppFonts } from '../src/shared/app-fonts.js';
import { validateSettingsPatch } from '../src/shared/validate.js';
import { appLook } from '../app/shared/look.js';
import { validateLook } from '../app/shared/validation.js';
import { readLook } from '../app/main/look.js';
import { ligatureRanges } from '../app/renderer/ligatures.js';
import { FontsForm } from '../src/client/tui/fonts-form.js';
import type { AppFonts } from '../src/shared/app-fonts.js';

// v1.2.6: the Mac app follows the saved theme (system follows macOS light/dark), and has its own fonts: the terminal's
// family and size apart from the chrome's, and ligatures on or off. A terminal running ai keeps its own font.
const ocean = { name: 'ocean', label: 'Ocean', dark: { ...themeColors('slate', 'dark'), bg: '#0a1a2a' }, light: { ...themeColors('slate', 'light'), bg: '#f0f8ff' } };
const LIST = { themes: [ocean], refused: [] };

describe('the app look', () => {
  it('follows the saved theme and variant; system and an unset variant follow macOS; light is graphite light', () => {
    expect(appLook({ theme: 'slate', themeVariant: 'light' }, LIST, true)).toMatchObject({ mode: 'light', colors: { bg: themeColors('slate', 'light').bg } });
    expect(appLook({ theme: 'dune', themeVariant: 'system' }, LIST, true)).toMatchObject({ mode: 'dark', colors: { bg: themeColors('dune', 'dark').bg } });
    expect(appLook({ theme: 'graphite' }, LIST, false)).toMatchObject({ mode: 'light', colors: { bg: themeColors('graphite', 'light').bg } });
    expect(appLook({ theme: 'light' }, LIST, true)).toMatchObject({ mode: 'light', colors: { bg: themeColors('graphite', 'light').bg } });
    expect(appLook({ theme: 'auto', themeVariant: 'light' }, LIST, true)).toMatchObject({ mode: 'dark', colors: { bg: themeColors('graphite', 'dark').bg } });
    expect(appLook({ theme: 'ocean', themeVariant: 'system' }, LIST, false).colors.bg).toBe('#f0f8ff');
    expect(appLook({ theme: 'gone' }, LIST, true).colors.bg).toBe(themeColors('graphite', 'dark').bg);
    expect(appLook({}, LIST, true).colors.bg).toBe(themeColors('graphite', 'dark').bg);
  });

  it('fonts: the token chain by default; your family goes first, quoted; sizes and ligatures as saved', () => {
    expect(appLook({}, LIST, true).fonts).toEqual({ terminal: monoFont, terminalSize: 13, chrome: sansFont, chromeSize: 13, ligatures: false });
    expect(appLook({ appFonts: { terminal: 'Fira Code', terminalSize: 15, chrome: 'Avenir Next', chromeSize: 12, ligatures: true } }, LIST, true).fonts)
      .toEqual({ terminal: `"Fira Code", ${monoFont}`, terminalSize: 15, chrome: `"Avenir Next", ${sansFont}`, chromeSize: 12, ligatures: true });
  });

  it('what reaches the renderer is checked: hex colors, the known font stacks, sizes in range, nothing else', () => {
    const look = appLook({ theme: 'slate', appFonts: { terminal: 'Fira Code' } }, LIST, true);
    expect(validateLook(JSON.parse(JSON.stringify(look)))).toEqual(look);
    expect(() => validateLook({ ...look, colors: { ...look.colors, bg: 'red' } })).toThrow();
    expect(() => validateLook({ ...look, fonts: { ...look.fonts, terminal: '"x"; } body { display: none' } })).toThrow();
    expect(() => validateLook({ ...look, fonts: { ...look.fonts, terminalSize: 99 } })).toThrow();
    expect(() => validateLook({ ...look, extra: 1 })).toThrow();
    expect(() => validateLook({ ...look, mode: 'blue' })).toThrow();
  });
});

describe('fonts in settings', () => {
  it('a family is letters, digits, spaces, dots, dashes and underscores; sizes have limits; nothing else is kept', () => {
    const good: AppFonts = { terminal: 'JetBrains Mono', terminalSize: 14, chrome: 'SF Pro Text', chromeSize: 12, ligatures: true };
    expect(validateAppFonts(good)).toEqual(good);
    expect(validateSettingsPatch({ appFonts: good }, true)).toEqual({ appFonts: good });
    expect(validateSettingsPatch({ themeVariant: 'system' }, true)).toEqual({ themeVariant: 'system' });
    for (const bad of [{ terminal: 'Menlo, monospace' }, { terminal: '"Menlo"' }, { chrome: 'a'.repeat(49) }, { chrome: ' ' }, { terminalSize: 8 }, { terminalSize: 33 }, { chromeSize: 19 }, { terminalSize: 13.5 }, { ligatures: 'yes' }, { color: 'red' }])
      expect(() => validateAppFonts(bad), JSON.stringify(bad)).toThrow();
    expect(() => validateSettingsPatch({ themeVariant: 'dim' }, true)).toThrow();
  });
  it('describeFonts says it in one line', () => {
    expect(describeFonts(undefined)).toBe('terminal default 13 · chrome default 13 · ligatures off');
    expect(describeFonts({ terminal: 'Fira Code', terminalSize: 15, ligatures: true })).toBe('terminal Fira Code 15 · chrome default 13 · ligatures on');
  });
});

describe('the fonts form (/settings, the app only)', () => {
  it('types a family, steps sizes with ←→, Space toggles ligatures on its row, ⏎ saves and goes back, Esc goes back without saving', async () => {
    const saved: AppFonts[] = []; let back = 0;
    const form = new FontsForm({ terminalSize: 13 }, { save: async f => { saved.push(f); }, back: () => { back++; }, changed: () => {} });
    expect(form.lines().join('\n')).toContain('App fonts · the AI Term app only; a terminal keeps its own font');
    for (const ch of 'Fira Code') await form.key(ch === ' ' ? 'space' : ch);
    await form.key('down'); await form.key('right'); await form.key('right');
    await form.key('down'); for (const ch of 'Avenir') await form.key(ch);
    await form.key('down'); await form.key('left');
    await form.key('down'); await form.key('space');
    expect(form.lines().join('\n')).toMatch(/› ligatures: on/);
    await form.key('enter');
    expect(saved).toEqual([{ terminal: 'Fira Code', terminalSize: 15, chrome: 'Avenir', chromeSize: 12, ligatures: true }]);
    expect(back).toBe(1);
    const other = new FontsForm(undefined, { save: async f => { saved.push(f); }, back: () => { back++; }, changed: () => {} });
    await other.key('x'); await other.key('escape');
    expect(back).toBe(2); expect(saved).toHaveLength(1);
  });
  it('an empty family means the default; a family with a comma is refused in plain words and nothing is saved', async () => {
    const saved: AppFonts[] = [];
    const form = new FontsForm({ terminal: 'Menlo' }, { save: async f => { saved.push(f); }, back: () => {}, changed: () => {} });
    for (let i = 0; i < 5; i++) await form.key('backspace');
    await form.key('enter');
    expect(saved).toEqual([{ terminalSize: 13, chromeSize: 13, ligatures: false }]);
    const comma = new FontsForm(undefined, { save: async f => { saved.push(f); }, back: () => {}, changed: () => {} });
    for (const ch of 'Menlo,x') await comma.key(ch);
    await comma.key('enter');
    expect(saved).toHaveLength(1);
    expect(comma.lines().join('\n')).toContain('a font name takes letters, digits, spaces, dots, dashes and underscores');
  });
});

describe('ligatures', () => {
  it('joins the usual programming sequences, longest first, and nothing else', () => {
    expect(ligatureRanges('a => b !== c')).toEqual([[2, 4], [7, 10]]);
    expect(ligatureRanges('x->y <= z && w || v')).toEqual([[1, 3], [5, 7], [10, 12], [15, 17]]);
    expect(ligatureRanges('plain words, no arrows')).toEqual([]);
    expect(ligatureRanges('===')).toEqual([[0, 3]]);
  });
});

describe('reading the look from disk (app main)', () => {
  const cleanup: string[] = [];
  afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });
  it('reads settings.json and the themes folder; a missing or broken settings file is the default look with a reason', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-look-')); cleanup.push(root);
    expect(await readLook(root, true)).toEqual({ look: appLook({}, { themes: [], refused: [] }, true), problem: null });
    await mkdir(join(root, 'themes'));
    await writeFile(join(root, 'themes', 'ocean.json'), JSON.stringify({ name: 'Ocean', dark: Object.fromEntries(BASE_COLOR_NAMES.map(n => [n, ocean.dark[n]])), light: Object.fromEntries(BASE_COLOR_NAMES.map(n => [n, ocean.light[n]])) }));
    await writeFile(join(root, 'settings.json'), JSON.stringify({ theme: 'ocean', themeVariant: 'dark', appFonts: { chromeSize: 12 }, notifications: false }));
    const read = await readLook(root, false);
    expect(read.problem).toBeNull();
    expect(read.look).toMatchObject({ mode: 'dark', colors: { bg: '#0a1a2a' }, fonts: { chromeSize: 12 } });
    await writeFile(join(root, 'settings.json'), '{ broken');
    expect(await readLook(root, true)).toEqual({ look: appLook({}, { themes: [], refused: [] }, true), problem: "settings.json isn't valid JSON" });
    await writeFile(join(root, 'settings.json'), JSON.stringify({ theme: 'slate', appFonts: { terminal: 'bad;font' } }));
    expect(await readLook(root, true)).toMatchObject({ look: { colors: { bg: themeColors('slate', 'dark').bg }, fonts: { terminal: monoFont } }, problem: 'the saved fonts are not valid; the defaults are used' });
  });
});
