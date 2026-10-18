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

it('MEDIUM (follow-up): a background run\'s own refusal is shown; a system error from it stays one fixed line', async () => {
  const { AddonService } = await import('../src/daemon/addons.js'), { mkdtemp: temp } = await import('node:fs/promises');
  const home = await temp('/tmp/ai-gate10-run-'), definitions = new URL('../addons/', import.meta.url).pathname;
  const service = new AddonService(home, definitions, { create: vi.fn(), text: vi.fn(), brainPlan: async () => null, addonStandup: async () => { throw new Error("EACCES: permission denied, open '/Users/me/.ai-term/AITERMCANARY'"); } });
  try {
    const ask = await service.plan('standup', '', home, null), started = await service.start(ask.receipt);
    if (!('run' in started)) throw new Error('expected a run');
    await vi.waitFor(async () => { await expect(service.result(started.run)).rejects.toThrow('The add-on run failed; the daemon log says why'); });
    await expect(service.result(started.run)).rejects.not.toThrow('AITERMCANARY');
  } finally { await rm(home, { recursive: true, force: true }); }
});

it('LOW (follow-up): a queued agent that couldn\'t be stopped after losing its limit says so', async () => {
  const { QueueService } = await import('../src/daemon/queue.js'), { mkdtemp: temp } = await import('node:fs/promises'), { randomUUID } = await import('node:crypto');
  const root = await temp('/tmp/ai-gate10-q-'), listeners: ((s: { title: string }, p: { status: string }, n: { status: string }) => void)[] = [], id = randomUUID();
  const manager = { create: vi.fn(async () => ({ id })), on: (event: string, listener: never) => { if (event === 'statusChanged') listeners.push(listener); }, list: () => [], titles: () => ['fixer'],
    setQueueLimit: vi.fn(() => { throw new Error('no timer'); }), stop: vi.fn(async () => { throw new Error('stuck'); }) };
  const queue = new QueueService(root, manager as never, { error: vi.fn(), info: vi.fn() }, () => new Date(2026, 9, 15, 12, 0), async () => true);
  try {
    await queue.load();
    await queue.add({ trigger: { kind: 'after', agent: 'fixer' }, limit: { until: '23:59' }, request: { engine: 'codex', model: null, auth: { kind: 'account' }, cwd: '/tmp', permission: 'ask', effort: null, firstMessage: 'go' } });
    listeners.forEach(listener => listener({ title: 'fixer' }, { status: 'running' }, { status: 'done' }));
    await vi.waitFor(() => expect(queue.list()[0]?.note).toBe("its limit couldn't be set and AI Term couldn't stop it: stop it on the homepage"), { timeout: 10_000 });
    await queue.close();
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20_000);
