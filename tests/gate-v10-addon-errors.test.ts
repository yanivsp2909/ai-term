import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { DaemonServer } from '../src/daemon/server.js';
import { Connection } from '../src/client/connection.js';
import { BisectError } from '../src/daemon/bisect.js';
import { AddonError } from '../src/daemon/addons.js';

// v1.0 gate (silent failure): an add-on's own refusal often names what you typed (a path, a test command, a ref), so it
// wasn't in the daemon's fixed list and reached the popup as "Session operation failed". AI Term's own add-on texts pass
// (controls removed, cut to 300 characters); any other error stays one fixed line.
afterEach(() => vi.restoreAllMocks());
it('an add-on\'s own refusal reaches the popup as written; anything else stays fixed and unlogged', async () => {
  const root = await mkdtemp('/tmp/ai-gate10-'), paths = getPaths(root); await preparePaths(paths);
  const log = new Logger(paths.log), manager = new SessionManager(paths, log), server = new DaemonServer(paths, manager, log);
  let client: Connection | undefined;
  try {
    await manager.load(); await server.listen(); client = await Connection.connect(paths, { entry: '/unused', autoStart: false });
    const plan = vi.spyOn(manager.addons, 'plan');
    const request = { kind: 'addons.plan' as const, name: 'bisect', args: 'npm test', cwd: root, target: null };
    plan.mockRejectedValueOnce(new BisectError('npm test passes at HEAD; nothing to bisect'));
    await expect(client.request(request)).rejects.toThrow('npm test passes at HEAD; nothing to bisect');
    plan.mockRejectedValueOnce(new AddonError('No such path in this folder: src/missing\u001b[2J'));
    await expect(client.request(request)).rejects.toThrow(/^No such path in this folder: src\/missing\?\[2J$/);
    plan.mockRejectedValueOnce(new Error('EACCES: /Users/me/.ssh/AITERMCANARY'));
    await expect(client.request(request)).rejects.toThrow('Session operation failed');
    expect(await readFile(paths.log, 'utf8')).not.toContain('AITERMCANARY');
  } finally { client?.close(); await server.close(); await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
