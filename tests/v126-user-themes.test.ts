import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BASE_COLOR_NAMES, themeColors } from '../src/shared/theme-tokens.js';
import { MAX_THEME_FILES, THEME_FILE_MAX_BYTES, parseUserTheme, readUserThemes, themesFolder, validateThemeList } from '../src/shared/user-themes.js';
import { validateRequest } from '../src/shared/validate.js';

// v1.2.6: a theme of your own is a JSON file in ~/.ai-term/themes/ with the same token names as tokens.json, a dark and
// a light set. A bad or incomplete file is refused whole, with one line naming what's wrong; it is never half-applied.
const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });
async function home() { const dir = await mkdtemp(join(tmpdir(), 'ai-themes-')); cleanup.push(dir); await mkdir(themesFolder(dir)); return dir; }
const base = (id: 'slate' | 'dune', variant: 'dark' | 'light'): Record<string, string> => Object.fromEntries(BASE_COLOR_NAMES.map(name => [name, themeColors(id, variant)[name]]));
const omit = (set: Record<string, string>, ...names: string[]) => Object.fromEntries(Object.entries(set).filter(([name]) => !names.includes(name)));
const complete: { name: string; dark: Record<string, string>; light: Record<string, string> } = { name: 'Ocean', dark: { ...base('slate', 'dark'), bg: '#0a1a2a' }, light: base('slate', 'light') };

describe('a theme file', () => {
  it('complete: both variants with every base token, a label, the derived tokens filled in', () => {
    const result = parseUserTheme('ocean.json', JSON.stringify(complete));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme).toMatchObject({ name: 'ocean', label: 'Ocean' });
    expect(result.theme.dark.bg).toBe('#0a1a2a');
    expect(result.theme.dark['status-running']).toBe(complete.dark.accent);
    expect(result.theme.light['status-done']).toBe(complete.light['ink-2']);
  });

  it('incomplete: refused in one line that names the missing tokens', () => {
    const dark = omit(complete.dark, 'bg'), light = omit(complete.light, 'ink', 'cursor');
    const result = parseUserTheme('ocean.json', JSON.stringify({ dark, light }));
    expect(result).toEqual({ ok: false, refusal: { file: 'ocean.json', reason: 'missing dark.bg, light.ink, light.cursor' } });
    const empty = parseUserTheme('empty.json', '{}');
    expect(empty.ok).toBe(false);
    if (!empty.ok) { expect(empty.refusal.reason).toMatch(/^missing dark\.bg, .* and \d+ more$/); expect(empty.refusal.reason).not.toContain('\n'); }
  });

  it('wrong: unknown tokens, colors that are not #rrggbb, derived tokens set by hand, not JSON, too big, a built-in name', () => {
    const reason = (file: string, text: string) => { const r = parseUserTheme(file, text); return r.ok ? 'accepted' : r.refusal.reason; };
    expect(reason('a.json', JSON.stringify({ ...complete, dark: { ...complete.dark, glow: '#ffffff' } }))).toBe('unknown token dark.glow');
    // A name from the file reaches the screen as printable ASCII only.
    expect(reason('a.json', JSON.stringify({ ...complete, dark: { ...complete.dark, '\u001b[31mx': '#ffffff' } }))).toBe('unknown token dark.?[31mx');
    expect(reason('a.json', JSON.stringify({ ...complete, light: { ...complete.light, accent: 'teal' } }))).toBe("light.accent isn't a #rrggbb color");
    expect(reason('a.json', JSON.stringify({ ...complete, dark: { ...complete.dark, 'status-running': '#ffffff' } }))).toBe('dark.status-running is derived (= accent); leave it out');
    expect(reason('a.json', JSON.stringify({ ...complete, extra: 1 }))).toBe('unknown field extra; a theme has name, dark and light');
    expect(reason('a.json', '{ not json')).toBe("isn't valid JSON");
    expect(reason('a.json', '[]')).toBe("isn't a JSON object");
    expect(reason('a.json', JSON.stringify({ ...complete, name: 'x\u001b[31m' }))).toBe('name must be 1 to 32 printable characters');
    expect(reason('a.json', ' '.repeat(THEME_FILE_MAX_BYTES + 1))).toBe('bigger than 16 KB');
    expect(reason('graphite.json', JSON.stringify(complete))).toBe('takes the built-in name graphite; rename the file');
    expect(reason('auto.json', JSON.stringify(complete))).toBe('takes the built-in name auto; rename the file');
    expect(reason('My Theme.json', JSON.stringify(complete))).toBe('file name must be lowercase letters, digits and dashes, then .json');
  });
});

describe('the themes folder', () => {
  it('lists good files sorted, refuses bad ones with their reason, skips other files, and refuses links', async () => {
    const dir = await home(), folder = themesFolder(dir);
    await writeFile(join(folder, 'zeta.json'), JSON.stringify({ ...complete, name: 'Zeta' }));
    await writeFile(join(folder, 'ocean.json'), JSON.stringify(complete));
    await writeFile(join(folder, 'broken.json'), JSON.stringify({ dark: complete.dark }));
    await writeFile(join(folder, 'notes.txt'), 'not a theme');
    await writeFile(join(dir, 'outside.json'), JSON.stringify(complete));
    await symlink(join(dir, 'outside.json'), join(folder, 'linked.json'));
    const list = await readUserThemes(dir);
    expect(list.themes.map(t => t.name)).toEqual(['ocean', 'zeta']);
    expect(list.refused).toEqual([{ file: 'broken.json', reason: expect.stringMatching(/^missing light\.bg, /) as unknown as string }, { file: 'linked.json', reason: "isn't a regular file" }]);
    expect(validateThemeList(JSON.parse(JSON.stringify(list)))).toEqual(list);
  });

  it('no folder is no themes; at most 32 files are read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ai-themes-none-')); cleanup.push(dir);
    expect(await readUserThemes(dir)).toEqual({ themes: [], refused: [] });
    const many = await home();
    for (let i = 0; i < MAX_THEME_FILES + 3; i++) await writeFile(join(themesFolder(many), `t${String(i).padStart(2, '0')}.json`), JSON.stringify(complete));
    const list = await readUserThemes(many);
    expect(list.themes).toHaveLength(MAX_THEME_FILES);
    expect(list.refused).toEqual([{ file: 'themes', reason: `only the first ${MAX_THEME_FILES} files are read` }]);
  });

  it('validateThemeList refuses colors that are not hex and labels with controls', () => {
    const good = { themes: [{ name: 'ocean', label: 'Ocean', dark: themeColors('slate', 'dark'), light: themeColors('slate', 'light') }], refused: [] };
    expect(validateThemeList(good)).toEqual(good);
    expect(() => validateThemeList({ ...good, themes: [{ ...good.themes[0], dark: { ...good.themes[0]?.dark, bg: 'red' } }] })).toThrow();
    expect(() => validateThemeList({ ...good, themes: [{ ...good.themes[0], label: 'a\u001bb' }] })).toThrow();
    expect(() => validateThemeList({ themes: [], refused: [{ file: 'x.json', reason: 'two\nlines' }] })).toThrow();
  });

  it('themes.list is a request with no fields', async () => {
    await expect(validateRequest({ id: randomUUID(), kind: 'themes.list' })).resolves.toMatchObject({ kind: 'themes.list' });
    await expect(validateRequest({ id: randomUUID(), kind: 'themes.list', dir: '/etc' })).rejects.toThrow();
  });
});
