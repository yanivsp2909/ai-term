import { expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { KeyStore } from '../src/daemon/keys.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { DaemonServer } from '../src/daemon/server.js';
import { Connection } from '../src/client/connection.js';
import { BASE_COLOR_NAMES, themeColors } from '../src/shared/theme-tokens.js';
import { themeProblem, themesFolder } from '../src/shared/user-themes.js';

// v1.2.6: the daemon reads your theme files for the TUI (themes.list), and only saves a theme that can be used: a
// built-in, auto, light, or a file that passed every check. Anything else is refused in one line, nothing saved.
const set = (variant: 'dark' | 'light') => Object.fromEntries(BASE_COLOR_NAMES.map(n => [n, themeColors('dune', variant)[n]]));
it('themes.list over the socket; settings.set refuses a theme file that is missing or refused', async () => {
  const root = await mkdtemp('/tmp/ai-themes-daemon-'), p = getPaths(root); await preparePaths(p);
  await mkdir(themesFolder(root));
  await writeFile(join(themesFolder(root), 'sand.json'), JSON.stringify({ name: 'Sand', dark: set('dark'), light: set('light') }));
  await writeFile(join(themesFolder(root), 'broken.json'), JSON.stringify({ dark: set('dark') }));
  const vault = new Map<string, string>(), keys = new KeyStore(root, { vault: { read: async a => vault.get(a) ?? null, write: async (a, s) => { vault.set(a, s); }, remove: async a => { vault.delete(a); } } });
  const log = new Logger(p.log), m = new SessionManager(p, log, undefined, undefined, undefined, keys), server = new DaemonServer(p, m, log, undefined, keys);
  let client: Connection | undefined;
  try {
    await m.load(); await server.listen(); client = await Connection.connect(p, { entry: '/unused', autoStart: false });
    const list = (await client.request({ kind: 'themes.list' })).themes;
    expect(list?.themes.map(t => t.label)).toEqual(['Sand']);
    expect(list?.refused.map(r => r.file)).toEqual(['broken.json']);
    expect((await client.request({ kind: 'settings.set', patch: { theme: 'sand', themeVariant: 'light' } })).settings).toMatchObject({ theme: 'sand', themeVariant: 'light' });
    await expect(client.request({ kind: 'settings.set', patch: { theme: 'broken' } })).rejects.toThrow(/^theme broken can't be used \(missing light\.bg, /);
    await expect(client.request({ kind: 'settings.set', patch: { theme: 'gone' } })).rejects.toThrow("theme gone isn't in ~/.ai-term/themes");
    expect((await client.request({ kind: 'settings.get' })).settings?.theme).toBe('sand');
  } finally { client?.close(); await server.close(); await m.shutdown(); await rm(root, { recursive: true, force: true }); }
});

it('themeProblem: built-ins, auto and light always; a file only when it passed', () => {
  const list = { themes: [{ name: 'sand', label: 'Sand', dark: themeColors('dune', 'dark'), light: themeColors('dune', 'light') }], refused: [{ file: 'broken.json', reason: 'missing light.bg' }] };
  for (const name of ['graphite', 'contrast', 'auto', 'light', 'sand']) expect(themeProblem(list, name), name).toBeNull();
  expect(themeProblem(list, 'broken')).toBe("theme broken can't be used (missing light.bg)");
  expect(themeProblem(list, 'gone')).toBe("theme gone isn't in ~/.ai-term/themes");
});
