import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, lstat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRequest, validateSuccess } from '../src/shared/validate.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary() { const root = await mkdtemp(join(tmpdir(), 'ai-term-settings-')); roots.push(root); return root; }
it('S2 accepts settings patches and rejects unsafe defaults and themes', async () => {
  for (const theme of ['graphite', 'slate', 'ink', 'auto', 'light']) {
    const request = { id: randomUUID(), kind: 'settings.set', patch: { theme } };
    expect(await validateRequest(request)).toEqual(request);
  }
  expect(await validateRequest({ id: randomUUID(), kind: 'settings.get' })).toMatchObject({ kind: 'settings.get' });
  for (const patch of [{ theme: 'Bad Theme' }, { theme: 'slate', permission: 'dontAsk' }, {}, null, { theme: 3 }]) {
    await expect(validateRequest({ id: randomUUID(), kind: 'settings.set', patch })).rejects.toThrow();
  }
  expect(() => validateSuccess({ id: randomUUID(), ok: true, settings: { theme: 'Bad Theme' } })).toThrow();
});
it('persists the theme atomically at 0600 and loads it after reopening', async () => {
  const { SettingsStore } = await import('../src/daemon/settings.js');
  const root = await temporary(), store = new SettingsStore(root);
  expect(await store.get()).toEqual({ theme: 'graphite' });
  expect(await store.set({ theme: 'slate' })).toEqual({ theme: 'slate' });
  expect((await lstat(join(root, 'settings.json'))).mode & 0o777).toBe(0o600);
  expect(await new SettingsStore(root).get()).toEqual({ theme: 'slate' });
  await Promise.all([store.set({ theme: 'ink' }), store.set({ theme: 'light' })]);
  expect(await new SettingsStore(root).get()).toEqual({ theme: 'light' });
});
it('refuses symlinked or malformed settings instead of silently replacing them', async () => {
  const { SettingsStore } = await import('../src/daemon/settings.js');
  const root = await temporary(), target = join(root, 'target');
  await writeFile(target, '{"theme":"slate"}');
  await symlink(target, join(root, 'settings.json'));
  await expect(new SettingsStore(root).get()).rejects.toThrow();
  await rm(join(root, 'settings.json'));
  await writeFile(join(root, 'settings.json'), '{"theme":"not/valid"}');
  await expect(new SettingsStore(root).get()).rejects.toThrow();
});
it('settings.get and settings.set round-trip through the daemon with invalid patches refused', async () => {
  const { getPaths, preparePaths } = await import('../src/shared/paths.js');
  const { SessionManager } = await import('../src/daemon/session-manager.js');
  const { DaemonServer } = await import('../src/daemon/server.js');
  const { Connection } = await import('../src/client/connection.js');
  const { Logger } = await import('../src/daemon/log.js');
  const root = await temporary(), paths = getPaths(root); await preparePaths(paths);
  const log = new Logger(paths.log), manager = new SessionManager(paths, log, { executable: '/bin/sh', args: [], env: { PATH: '/usr/bin:/bin' } }); await manager.load();
  const server = new DaemonServer(paths, manager, log); await server.listen();
  const client = await Connection.connect(paths, { entry: '/unused', autoStart: false });
  try {
    expect((await client.request({ kind: 'settings.get' })).settings).toEqual({ theme: 'graphite' });
    expect((await client.request({ kind: 'settings.set', patch: { theme: 'auto' } })).settings).toEqual({ theme: 'auto' });
    expect((await client.request({ kind: 'settings.get' })).settings).toEqual({ theme: 'auto' });
  } finally { client.close(); await server.close(); await manager.shutdown(); }
});
it('resizing detached sessions broadcasts new preview dimensions once, without redundant events', async () => {
  const { getPaths, preparePaths } = await import('../src/shared/paths.js'), { SessionManager } = await import('../src/daemon/session-manager.js'), { Logger } = await import('../src/daemon/log.js');
  const root = await temporary(), paths = getPaths(root); await preparePaths(paths);
  const manager = new SessionManager(paths, new Logger(paths.log), { executable: '/bin/sh', args: ['-c', 'exit 0'], env: { PATH: '/usr/bin:/bin' } }); await manager.load();
  try {
    const session = await manager.create({ cwd: root }), events: unknown[] = []; manager.on('event', e => events.push(e));
    await manager.previewSize(40, 12); await manager.previewSize(40, 12);
    expect(events.filter(e => !!e && typeof e === 'object' && 'kind' in e && e.kind === 'session.previewResized')).toEqual([{ kind: 'session.previewResized', sessionId: session.id, cols: 40, rows: 12 }]);
  } finally { await manager.shutdown(); }
});
