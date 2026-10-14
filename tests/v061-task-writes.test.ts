import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pty from 'node-pty';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { UsageService } from '../src/daemon/usage-service.js';
import { atomicWrite } from '../src/daemon/store.js';
import * as engines from '../src/daemon/engines.js';

// Part C review: a subscription CLI can report 120 records a minute; each must not rewrite state.json and broadcast.
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('task totals from a burst of usage records coalesce into a few state writes and updates', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-task-writes-'))); roots.push(root);
  const paths = getPaths(root); await preparePaths(paths);
  await writeFile(join(root, 'settings.json'), JSON.stringify({ theme: 'graphite', worktrees: 'off' }), { mode: 0o600 });
  let writes = 0; const log = new Logger(paths.log), usage = new UsageService(root, log);
  const manager = new SessionManager(paths, log, undefined, undefined, (path, value) => { writes++; return atomicWrite(path, value); }, undefined, usage);
  const real = pty.spawn;
  vi.spyOn(pty, 'spawn').mockImplementation((_file, _args, options) => real('/bin/sh', ['-c', 'printf ready; read done'], { ...options, env: { PATH: '/usr/bin:/bin' } }));
  vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' });
  await usage.start(); await manager.load();
  try {
    const session = await manager.create({ engine: 'codex', model: null, auth: { kind: 'account' }, cwd: root, permission: 'ask' });
    await expect.poll(() => manager.get(session.id).status).toBe('running');
    const updates: unknown[] = []; manager.on('event', (event: { kind: string }) => { if (event.kind === 'session.updated') updates.push(event); });
    const before = writes;
    for (let i = 0; i < 100; i++) usage.emit('task', session.id, 10);
    await expect.poll(() => manager.get(session.id).taskUsage?.tokens, { timeout: 3000 }).toBe(1000);
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(writes - before).toBeLessThanOrEqual(3); expect(updates.length).toBeLessThanOrEqual(3);
  } finally { await manager.shutdown(); await usage.close(); }
});
