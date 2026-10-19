import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, realpath, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { QueueService } from '../src/daemon/queue.js';
import { limitCaps, overLimit, untilWithin, type QueueItem } from '../src/shared/queue.js';
import { QueueForm } from '../src/client/tui/queue-panel.js';
import { AS_ROOT } from './platform.js';

// Part E review (security-reviewer, typescript-reviewer; fresh context): each failed before its fix.
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-queue-rev-'))); roots.push(dir); return dir; }
const request = (over: Partial<QueueItem['request']> = {}): QueueItem['request'] => ({ engine: 'codex', model: 'gpt-5', auth: { kind: 'account' }, cwd: '/tmp/proj', permission: 'ask', effort: null, ...over });
const log = () => ({ error: vi.fn(), info: vi.fn() });
const manager = (over: Record<string, unknown> = {}) => ({ create: vi.fn(async () => ({ id: randomUUID() })), on: vi.fn(), setQueueLimit: vi.fn(), titles: () => ['fixer'], ...over });

it('HIGH (both): settings that can\'t be read count as the queue being off and are logged, never a crash', async () => {
  const root = await temp(), logger = log();
  const queue = new QueueService(root, manager() as never, logger, () => new Date(), async () => { throw new Error('Unsafe settings file'); });
  await queue.load();
  await expect(queue.tick()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith('Queue settings unreadable; nothing starts (Error)');
});

it('HIGH (TS review): while the daemon shuts down nothing is started or marked failed', async () => {
  const root = await temp(), listeners: ((session: { title: string }, previous: { status: string }, next: { status: string }) => void)[] = [];
  const m = manager({ on: (event: string, listener: never) => { if (event === 'statusChanged') listeners.push(listener); } });
  const queue = new QueueService(root, m as never, log(), () => new Date(), async () => true);
  await queue.load();
  await queue.add({ trigger: { kind: 'after', agent: 'fixer' }, limit: { until: '23:59' }, request: request() });
  queue.close();
  listeners.forEach(listener => listener({ title: 'fixer' }, { status: 'working' }, { status: 'exited' }));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(m.create).not.toHaveBeenCalled();
  expect(queue.list()[0]?.state).toBe('waiting');
});

it('HIGH (both): a stop time must come within 12 hours of the start; a due time missed by more than two minutes (a sleeping Mac) is marked missed, not started late', async () => {
  expect(untilWithin('21:30', '23:00')).toBe(true);
  expect(untilWithin('21:30', '21:00')).toBe(false);
  expect(untilWithin('21:30', '21:30')).toBe(false);
  const root = await temp(), m = manager();
  let clock = new Date(2026, 9, 15, 21, 0);
  const queue = new QueueService(root, m as never, log(), () => clock, async () => true);
  await queue.load();
  await expect(queue.add({ trigger: { kind: 'at', time: '21:30' }, limit: { until: '21:00' }, request: request() })).rejects.toThrow('within 12 hours');
  await queue.add({ trigger: { kind: 'at', time: '21:30' }, limit: { until: '23:00' }, request: request() });
  clock = new Date(2026, 9, 15, 23, 30);
  await queue.tick();
  expect(m.create).not.toHaveBeenCalled();
  expect(queue.list()[0]).toMatchObject({ state: 'missed' });
});

it('HIGH (security review): a key CLI that AI Term runs on its own agent keeps its $ budget as that run\'s cap; a tokens-only report is not "unpriced"', () => {
  expect(limitCaps({ usd: 0.5 }, { turns: 100, spendUsd: 5 })).toEqual({ turns: 100, spendUsd: 0.5 });
  expect(overLimit({ usd: 2 }, { tokens: 10, costUsd: null })).toBe(false);
  expect(overLimit({ usd: 2 }, { tokens: 10, costUsd: null, unknownPrice: true })).toBe(true);
});

it.skipIf(AS_ROOT)('MEDIUM (both): an item removed while another starts is not started; a failed save says so; one bad item keeps the file aside and the rest load (skipped as root: file modes do not stop root)', async () => {
  const root = await temp();
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const m = manager({ create: vi.fn(async () => { await gate; return { id: randomUUID() }; }) });
  let clock = new Date(2026, 9, 15, 20, 0);
  const queue = new QueueService(root, m as never, log(), () => clock, async () => true);
  await queue.load();
  await queue.add({ trigger: { kind: 'at', time: '20:30' }, limit: { until: '22:00' }, request: request() });
  const second = await queue.add({ trigger: { kind: 'at', time: '20:30' }, limit: { until: '22:00' }, request: request() });
  clock = new Date(2026, 9, 15, 20, 31);
  const ticking = queue.tick();
  await vi.waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
  await queue.remove(second.id); release(); await ticking;
  expect(m.create).toHaveBeenCalledTimes(1);
  await chmod(root, 0o500);
  try { await expect(queue.add({ trigger: { kind: 'after', agent: 'fixer' }, limit: { until: '22:00' }, request: request() })).rejects.toThrow('The queue could not be saved'); }
  finally { await chmod(root, 0o700); }
  const other = await temp(), good = (await new QueueService(root, manager() as never, log(), () => clock, async () => true));
  void good;
  await writeFile(join(other, 'queue.json'), JSON.stringify([{ id: randomUUID(), createdAt: '', trigger: { kind: 'after', agent: 'fixer' }, limit: { until: '22:00' }, request: request(), state: 'waiting' }, { bogus: true }]), { mode: 0o600 });
  const loaded = new QueueService(other, manager() as never, log(), () => clock, async () => true);
  await loaded.load();
  expect(loaded.list()).toHaveLength(1);
  expect((await readdir(other)).some(name => name.startsWith('queue.json.unreadable-'))).toBe(true);
});

it('MEDIUM (TS review): /queue add after <name> needs an agent by that name; a double Enter queues once', async () => {
  const root = await temp();
  const queue = new QueueService(root, manager() as never, log(), () => new Date(), async () => true);
  await queue.load();
  await expect(queue.add({ trigger: { kind: 'after', agent: 'fxier' }, limit: { until: '23:00' }, request: request() })).rejects.toThrow('No agent has that name');
  const submit = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 30)); return null; });
  const form = new QueueForm(request(), ['fixer'], () => {}, () => {}, submit);
  form.type('after fixer'); form.key('enter');
  form.type('until 23:00'); form.key('enter'); form.key('enter');
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(submit).toHaveBeenCalledTimes(1);
});
