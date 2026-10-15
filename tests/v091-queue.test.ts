import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { limitFields, nextLocalTime, validateQueueItem, queueLines, type QueueItem } from '../src/shared/queue.js';
import { QueueService } from '../src/daemon/queue.js';
import { validateRequest } from '../src/shared/validate.js';

// v0.9.1 queue (D55, off by default): an agent waits in the queue and starts like a manual start when its trigger fires
// (after a named agent finishes, or at a local time), never without a limit. Prompt text after "times passed while the"
// was cut off; the safer reading: a time that passed while AI Term wasn't running is marked missed and never starts by
// itself.
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-queue-'))); roots.push(dir); return dir; }
const request = (over: Partial<QueueItem['request']> = {}): QueueItem['request'] => ({ engine: 'codex', model: 'gpt-5', auth: { kind: 'account' }, cwd: '/tmp/proj', permission: 'ask', effort: null, firstMessage: 'fix the tests', ...over });

it('nothing is queued without its limit: a $ budget for key engines, turns and $ for AI Term\'s agent, a stop time for a subscription CLI', () => {
  expect(limitFields('ai-term', 'key')).toEqual(['turns', 'usd']);
  expect(limitFields('codex', 'key')).toEqual(['usd']);
  expect(limitFields('claude-code', 'account')).toEqual(['until']);
  const base = { id: randomUUID(), createdAt: new Date().toISOString(), trigger: { kind: 'after' as const, agent: 'fixer' }, state: 'waiting' as const };
  expect(() => validateQueueItem({ ...base, request: request(), limit: {} })).toThrow();
  expect(validateQueueItem({ ...base, request: request(), limit: { until: '18:30' } }).limit).toEqual({ until: '18:30' });
  expect(() => validateQueueItem({ ...base, request: request({ engine: 'ai-term', auth: { kind: 'key', keyId: randomUUID() } }), limit: { turns: 20 } })).toThrow();
  expect(() => validateQueueItem({ ...base, request: request({ auth: { kind: 'key', keyId: randomUUID() } }), limit: { usd: 0 } })).toThrow();
});

it('a time trigger is the next local occurrence of HH:MM', () => {
  const now = new Date(2026, 9, 15, 20, 0, 0);
  expect(nextLocalTime('21:30', now).getTime()).toBe(new Date(2026, 9, 15, 21, 30).getTime());
  expect(nextLocalTime('07:00', now).getTime()).toBe(new Date(2026, 9, 16, 7, 0).getTime());
  expect(() => nextLocalTime('25:00', now)).toThrow();
});

it('the queue popup lists trigger, limit, engine, folder and mode, Don\'t ask marked; x removes, Esc closes', () => {
  const items: QueueItem[] = [
    { id: randomUUID(), createdAt: '', trigger: { kind: 'at', time: '21:30', due: new Date().toISOString() }, limit: { until: '23:00' }, request: request(), state: 'waiting' },
    { id: randomUUID(), createdAt: '', trigger: { kind: 'after', agent: 'fixer' }, limit: { usd: 2 }, request: request({ engine: 'codex', auth: { kind: 'key', keyId: randomUUID() }, permission: 'dontAsk' }), state: 'failed', note: 'codex not found in PATH' },
  ];
  const lines = queueLines(items);
  expect(lines[0]?.text).toBe('at 21:30 · stops at 23:00 · Codex · /tmp/proj · ask · waiting');
  expect(lines[1]?.text).toBe("after fixer · up to $2.00 · Codex · /tmp/proj · ! don't ask · ✗ codex not found in PATH");
  expect(lines[1]?.tone).toBe('status-error');
});

it('the queue survives a restart; a time that passed while AI Term was off is marked missed and never starts by itself', async () => {
  const root = await temp(), started: unknown[] = [];
  const manager = { create: vi.fn(async () => { started.push(1); return { id: randomUUID() }; }), on: vi.fn(), list: () => [], setQueueLimit: vi.fn() };
  const now = new Date(2026, 9, 15, 20, 0);
  const one = new QueueService(root, manager as never, { error: vi.fn(), info: vi.fn() }, () => now, async () => true);
  await one.load();
  await one.add({ trigger: { kind: 'at', time: '20:30' }, limit: { until: '22:00' }, request: request() });
  expect((await stat(join(root, 'queue.json'))).mode & 0o777).toBe(0o600);
  const later = new QueueService(root, manager as never, { error: vi.fn(), info: vi.fn() }, () => new Date(2026, 9, 15, 21, 0), async () => true);
  await later.load();
  expect(later.list()[0]).toMatchObject({ state: 'missed' });
  await later.tick();
  expect(started).toEqual([]);
});

it('a due item starts exactly like a manual start; a failed start shows on the item and never retries; with the queue off nothing fires', async () => {
  const root = await temp();
  let on = true;
  const create = vi.fn(async () => { throw new Error('codex not found in PATH'); });
  const manager = { create, on: vi.fn(), list: () => [], setQueueLimit: vi.fn() };
  let clock = new Date(2026, 9, 15, 20, 0);
  const queue = new QueueService(root, manager as never, { error: vi.fn(), info: vi.fn() }, () => clock, async () => on);
  await queue.load();
  await queue.add({ trigger: { kind: 'at', time: '20:30' }, limit: { until: '22:00' }, request: request() });
  on = false;
  await expect(queue.add({ trigger: { kind: 'at', time: '20:30' }, limit: { until: '22:00' }, request: request() })).rejects.toThrow('The queue is off');
  clock = new Date(2026, 9, 15, 20, 31);
  await queue.tick();
  expect(create).not.toHaveBeenCalled();
  on = true;
  await queue.tick();
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ engine: 'codex', cwd: '/tmp/proj', permission: 'ask', firstMessage: 'fix the tests' }));
  expect(queue.list()[0]).toMatchObject({ state: 'failed', note: 'codex not found in PATH' });
  await queue.tick();
  expect(create).toHaveBeenCalledTimes(1);
});

it('requests: queue.add, queue.list, queue.remove are validated', async () => {
  const id = randomUUID();
  await expect(validateRequest({ id, kind: 'queue.list' })).resolves.toMatchObject({ kind: 'queue.list' });
  await expect(validateRequest({ id, kind: 'queue.remove', itemId: randomUUID() })).resolves.toMatchObject({ kind: 'queue.remove' });
  await expect(validateRequest({ id, kind: 'queue.add', trigger: { kind: 'at', time: '9:5' }, limit: { until: '10:00' }, request: request() })).rejects.toThrow();
  await expect(validateRequest({ id, kind: 'queue.add', trigger: { kind: 'after', agent: 'fixer' }, limit: { until: '10:00' }, request: request() })).resolves.toMatchObject({ kind: 'queue.add' });
  expect(JSON.parse(JSON.stringify({ x: 1 }))).toEqual({ x: 1 });
  void readFile;
});

it('after a named agent finishes, its waiting items start; one that ends with an error doesn\'t start them and says why', async () => {
  const root = await temp(), listeners: ((session: { title: string }, previous: { status: string }, next: { status: string }) => void)[] = [];
  const create = vi.fn(async () => ({ id: randomUUID() }));
  const manager = { create, on: (event: string, listener: never) => { if (event === 'statusChanged') listeners.push(listener); }, list: () => [], setQueueLimit: vi.fn() };
  const queue = new QueueService(root, manager as never, { error: vi.fn(), info: vi.fn() }, () => new Date(), async () => true);
  await queue.load();
  await queue.add({ trigger: { kind: 'after', agent: 'fixer' }, limit: { until: '23:59' }, request: request() });
  await queue.add({ trigger: { kind: 'after', agent: 'broken' }, limit: { until: '23:59' }, request: request() });
  listeners.forEach(listener => listener({ title: 'fixer' }, { status: 'working' }, { status: 'done' }));
  listeners.forEach(listener => listener({ title: 'broken' }, { status: 'working' }, { status: 'error' }));
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(queue.list().map(item => item.state)).toEqual(['started', 'failed']));
  expect(queue.list()[1]?.note).toBe('broken ended with an error, so this one didn\'t start');
  expect(manager.setQueueLimit).toHaveBeenCalledWith(expect.any(String), { until: '23:59' }, expect.any(Function));
});

it('limits hold: AI Term\'s agent runs with the item\'s turns and $ as its caps; a key CLI stops at its $ (or at once when its cost is unknown); a subscription CLI stops at its time', async () => {
  const { limitCaps, overLimit, stopDelayMs } = await import('../src/shared/queue.js');
  expect(limitCaps({ turns: 20, usd: 3 }, { turns: 100, spendUsd: 5 })).toEqual({ turns: 20, spendUsd: 3 });
  expect(limitCaps({ until: '23:00' }, { turns: 100, spendUsd: 5 })).toEqual({ turns: 100, spendUsd: 5 });
  expect(overLimit({ usd: 2 }, { tokens: 10, costUsd: 1.99 })).toBe(false);
  expect(overLimit({ usd: 2 }, { tokens: 10, costUsd: 2 })).toBe(true);
  expect(overLimit({ usd: 2 }, { tokens: 10, costUsd: null, unknownPrice: true })).toBe(true);
  expect(stopDelayMs('21:30', new Date(2026, 9, 15, 21, 0))).toBe(30 * 60_000);
});

// End to end, as the daemon runs it: a real SessionManager and DaemonServer, a client connection, a fake CLI.
it('end to end: /queue add over the socket, the due item starts a real session through create(), with its stop time set; /queue lists it started', async () => {
  const { getPaths, preparePaths } = await import('../src/shared/paths.js');
  const { Logger } = await import('../src/daemon/log.js');
  const { SessionManager } = await import('../src/daemon/session-manager.js');
  const { DaemonServer } = await import('../src/daemon/server.js');
  const { Connection } = await import('../src/client/connection.js');
  const pty = (await import('node-pty')).default, engines = await import('../src/daemon/engines.js');
  const real = pty.spawn;
  vi.spyOn(pty, 'spawn').mockImplementation((file, args, options) => file === '/bin/sh' ? real('/bin/sh', ['-c', 'sleep 300'], { ...options, env: { PATH: '/usr/bin:/bin' } }) : real(file, args, options));
  vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' });
  const root = await temp(), paths = getPaths(join(root, 'home')); await preparePaths(paths);
  const { writeFile, mkdir } = await import('node:fs/promises'); const proj = join(root, 'proj'); await mkdir(proj);
  await writeFile(join(paths.root, 'settings.json'), JSON.stringify({ theme: 'graphite', worktrees: 'off', queue: true }), { mode: 0o600 });
  const log = new Logger(paths.log), manager = new SessionManager(paths, log); await manager.load();
  const server = new DaemonServer(paths, manager, log); await server.listen();
  let clock = new Date(2026, 9, 15, 20, 0);
  const queue = new QueueService(paths.root, { create: r => manager.create({ ...r }), on: (event, listener) => manager.on(event, listener), setQueueLimit: (id, limit, onStop) => manager.setQueueLimit(id, limit, onStop) }, log, () => clock);
  await queue.load(); server.setQueue(queue);
  const client = await Connection.connect(paths, { entry: join(process.cwd(), 'src', 'cli', 'index.ts'), autoStart: false });
  try {
    const added = await client.request({ kind: 'queue.add', trigger: { kind: 'at', time: '20:30' }, limit: { until: '23:00' }, request: request({ cwd: proj }) });
    expect(added.queue).toHaveLength(1);
    clock = new Date(2026, 9, 15, 20, 31); await queue.tick();
    const listed = (await client.request({ kind: 'queue.list' })).queue ?? [];
    expect(listed[0]).toMatchObject({ state: 'started', sessionId: expect.any(String) });
    expect(manager.list().find(session => session.id === listed[0]?.sessionId)).toMatchObject({ engine: 'codex', permission: 'ask', cwd: proj });
    await expect(client.request({ kind: 'queue.add', trigger: { kind: 'after', agent: 'x' }, limit: { usd: 2 }, request: request({ cwd: proj }) })).rejects.toThrow('An agent on your subscription needs a stop time');
  } finally { client.close(); queue.close(); await server.close(); await manager.shutdown(); }
}, 30_000);
