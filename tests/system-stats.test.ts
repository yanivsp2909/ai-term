import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Connection } from '../src/client/connection.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { DaemonServer } from '../src/daemon/server.js';
import { Logger } from '../src/daemon/log.js';
import { SystemSampler, defaultSamplerDeps, SAMPLE_COMMANDS, type SamplerDeps } from '../src/daemon/sysstats.js';
import { validateSystemStats } from '../src/shared/validate.js';
import type { SystemStats } from '../src/shared/protocol.js';
const roots: string[] = [], cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
type MakeSampler = (manager: SessionManager, log: Logger) => SystemSampler;
async function setup(makeSampler: MakeSampler) {
  const root = await mkdtemp(join(tmpdir(), 'ai-term-stats-')); roots.push(root);
  const paths = getPaths(root); await preparePaths(paths);
  const log = new Logger(paths.log);
  const manager = new SessionManager(paths, log, { executable: '/bin/sh', args: ['-c', 'exec sleep 30'], env: { PATH: '/usr/bin:/bin' } }); await manager.load();
  const sampler = makeSampler(manager, log), server = new DaemonServer(paths, manager, log, sampler); await server.listen();
  const entry = resolve('src/cli/index.ts');
  const connect = async () => { const client = await Connection.connect(paths, { entry, autoStart: false }); await client.hello; cleanup.unshift(async () => { client.close(); }); return client; };
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await server.close(); await manager.shutdown(); };
  cleanup.push(close);
  return { paths, manager, sampler, connect, close };
}
const statsOf = (events: unknown[]): SystemStats[] => events.flatMap(e => e && typeof e === 'object' && 'kind' in e && e.kind === 'system.stats' && 'stats' in e ? [validateSystemStats(e.stats)] : []);
const fake = (interval: number): MakeSampler => (manager, log) => {
  let tick = 0;
  const deps: SamplerDeps = {
    // A ps line that carries a command line must never reach a client.
    run: async file => file === SAMPLE_COMMANDS.ps.file ? manager.sessionRoots().map(r => `${r.pid} 1 2048 3.0`).join('\n') + '\n 77 1 10 1.0 /usr/bin/secret-tool --token=SECRET\n'
      : file === SAMPLE_COMMANDS.vmStat.file ? 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages active: 10.\nAnonymous pages: 12.\nPages purgeable: 2.\nPages wired down: 10.\nPages occupied by compressor: 10.\n'
        : `Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll\nen0 1500 <Link#1> 00:00:00:00:00:01 1 0 ${1000 * ++tick} 1 0 0 0\n`,
    cpus: () => [{ model: 'm', speed: 1, times: { user: 10 * ++tick, nice: 0, sys: 0, idle: 30 * tick, irq: 0 } }], totalmem: () => 8 * 1024 ** 3, now: () => performance.now(),
    sessions: () => manager.sessionRoots(), log, platform: 'darwin',
  };
  return new SystemSampler(deps, interval);
};

it('streams validated numbers only to subscribed clients and stops when the last one leaves or disconnects', async () => {
  const { connect, sampler, paths } = await setup(fake(50));
  const subscriber = await connect(), other = await connect(), watcher = await connect();
  const session = (await subscriber.request({ kind: 'sessions.create', engine: 'shell', cwd: paths.root })).session;
  if (!session) throw new Error('Missing session');
  const mine: unknown[] = [], theirs: unknown[] = [];
  subscriber.on('event', e => mine.push(e)); watcher.on('event', e => theirs.push(e));
  expect(sampler.running()).toBe(false);
  await subscriber.request({ kind: 'system.subscribe', on: true }); await other.request({ kind: 'system.subscribe', on: true });
  await expect.poll(() => statsOf(mine).length, { timeout: 3000 }).toBeGreaterThan(1);
  const latest = statsOf(mine).at(-1);
  expect(latest?.sessions).toEqual([{ sessionId: session.id, cpuPercent: 3, rssBytes: 2048 * 1024 }]);
  expect(JSON.stringify(mine)).not.toMatch(/secret|SECRET|sleep/);
  expect(statsOf(theirs)).toEqual([]);
  await other.request({ kind: 'system.subscribe', on: false });
  expect(sampler.running()).toBe(true);
  subscriber.close();
  await expect.poll(() => sampler.running()).toBe(false);
  expect(await readFile(paths.log, 'utf8').catch(() => 'no log written')).not.toMatch(/secret|SECRET/);
});

it('validates system.subscribe like every other request', async () => {
  const { connect, sampler } = await setup(fake(50));
  const client = await connect();
  for (const body of [{ kind: 'system.subscribe', on: 'yes' }, { kind: 'system.subscribe' }, { kind: 'system.subscribe', on: true, interval: 1 }])
    await expect(client.request(body as never)).rejects.toThrow();
  expect(sampler.running()).toBe(false);
});

it('real ps, vm_stat and netstat on this Mac give a live session non-zero memory and never its command name', async () => {
  const { connect, paths } = await setup((manager, log) => new SystemSampler(defaultSamplerDeps(() => manager.sessionRoots(), log), 300));
  const client = await connect(), events: unknown[] = [];
  client.on('event', e => events.push(e));
  const session = (await client.request({ kind: 'sessions.create', engine: 'shell', cwd: paths.root })).session;
  if (!session) throw new Error('Missing session');
  await client.request({ kind: 'system.subscribe', on: true });
  await expect.poll(() => statsOf(events).at(-1)?.sessions.length ?? 0, { timeout: 5000 }).toBe(1);
  const stats = statsOf(events).at(-1);
  expect(stats?.memTotalBytes).toBeGreaterThan(0); expect(stats?.memUsedBytes).toBeGreaterThan(0);
  expect(stats?.sessions[0]).toMatchObject({ sessionId: session.id }); expect(stats?.sessions[0]?.rssBytes).toBeGreaterThan(0);
  expect(JSON.stringify(events)).not.toMatch(/sleep|\/bin\//);
});

it('closing the server stops sampling for good, even with several subscribers', async () => {
  const { connect, sampler, close } = await setup(fake(50));
  const a = await connect(), b = await connect();
  await a.request({ kind: 'system.subscribe', on: true }); await b.request({ kind: 'system.subscribe', on: true });
  expect(sampler.running()).toBe(true);
  const calls: number[] = []; const original = sampler.setSubscribers.bind(sampler);
  sampler.setSubscribers = (count: number) => { calls.push(count); original(count); };
  await close();
  await new Promise(r => setTimeout(r, 100));
  await expect.poll(() => sampler.running(), { timeout: 10_000 }).toBe(false); expect(calls.filter(count => count > 0)).toEqual([]);
});
