import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { QueueService } from '../src/daemon/queue.js';

// v1.0 gate (silent failure): a queued agent started, then its limit couldn't be set: the panel said "failed" while
// the agent ran on with no limit. Every queued agent needs its limit, so it is stopped, and the note says what happened.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('an agent whose limit can\'t be set is stopped, and the note says it started and why it stopped', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-gate10-queue-'))); roots.push(root);
  const listeners: ((s: { title: string }, p: { status: string }, n: { status: string }) => void)[] = [], id = randomUUID(), errors: string[] = [];
  const manager = { create: vi.fn(async () => ({ id })), on: (event: string, listener: never) => { if (event === 'statusChanged') listeners.push(listener); }, list: () => [], titles: () => ['fixer'],
    setQueueLimit: vi.fn(() => { throw new Error('limit timer unavailable'); }), stop: vi.fn(async () => {}) };
  const queue = new QueueService(root, manager as never, { error: text => { errors.push(text); }, info: vi.fn() }, () => new Date(2026, 9, 15, 12, 0), async () => true);
  await queue.load();
  await queue.add({ trigger: { kind: 'after', agent: 'fixer' }, limit: { until: '23:59' }, request: { engine: 'codex', model: null, auth: { kind: 'account' }, cwd: '/tmp', permission: 'ask', effort: null, firstMessage: 'go' } });
  listeners.forEach(listener => listener({ title: 'fixer' }, { status: 'running' }, { status: 'done' }));
  await vi.waitFor(() => expect(manager.stop).toHaveBeenCalledWith(id), { timeout: 10_000 });
  expect(queue.list()[0]).toMatchObject({ state: 'started', sessionId: id, note: "its limit couldn't be set, so AI Term stopped it" });
  expect(errors).toContain('Queued agent started, but its limit could not be set (Error); it was stopped');
  await queue.close();
}, 20_000);
