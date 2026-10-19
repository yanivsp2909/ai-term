import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { QueueService } from '../src/daemon/queue.js';
import { DevServers } from '../src/daemon/dev-servers.js';
import type { QueueRequest } from '../src/shared/queue.js';
import { AS_ROOT } from './platform.js';

// Backlog F5 (v0.9+v1.0 gate LOW): queue and dev-server failures are logged with what kind of error it was, its class and
// code, never its message (which may name a path), so the log can say why.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { await chmod(root, 0o700).catch(() => undefined); await rm(root, { recursive: true, force: true }); } });
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-f5-'))); roots.push(dir); return dir; }
const coded = (code: string) => Object.assign(new Error(`failed at /Users/someone/${code}`), { code });
const request = (): QueueRequest => ({ engine: 'codex', model: null, auth: { kind: 'account' }, cwd: tmpdir(), permission: 'ask', effort: null });

it.skipIf(AS_ROOT)("the queue logs the kind of error: settings it can't read, an agent that can't start, a save that fails (skipped as root: file modes do not stop root)", async () => {
  const root = await temp(), errors: string[] = [], listeners: ((s: { title: string }, p: { status: string }, n: { status: string }) => void)[] = [];
  let settings: () => Promise<boolean> = async () => true;
  const manager = { create: vi.fn(async () => { throw coded('ENOENT'); }), on: (event: string, listener: never) => { if (event === 'statusChanged') listeners.push(listener); }, list: () => [], setQueueLimit: vi.fn(), stop: vi.fn() };
  const queue = new QueueService(root, manager as never, { error: text => errors.push(text), info: vi.fn() }, () => new Date(2026, 9, 15, 12, 0), () => settings());
  await queue.load();
  await queue.add({ trigger: { kind: 'after', agent: 'fixer' }, limit: { until: '23:59' }, request: request() });
  settings = async () => { throw coded('EACCES'); };
  await queue.tick();
  expect(errors).toContain('Queue settings unreadable; nothing starts (Error EACCES)');
  settings = async () => true;
  listeners.forEach(listener => listener({ title: 'fixer' }, { status: 'working' }, { status: 'done' }));
  await vi.waitFor(() => expect(errors).toContain('Queued agent could not start (Error ENOENT)'), { timeout: 10_000 });
  await queue.add({ trigger: { kind: 'after', agent: 'fixer' }, limit: { until: '23:59' }, request: request() });
  await chmod(root, 0o500);
  listeners.forEach(listener => listener({ title: 'fixer' }, { status: 'working' }, { status: 'done' }));
  await vi.waitFor(() => expect(errors.some(text => /^The queue could not be saved \(Error E[A-Z]+\)$/.test(text))).toBe(true), { timeout: 10_000 });
  await queue.close();
  expect(errors.join('\n')).not.toContain('/Users/someone');
}, 20_000);

it("a dev server that can't start is logged with the kind of error", async () => {
  const errors: string[] = [], dev = new DevServers({ error: text => errors.push(text) });
  await expect(dev.start(randomUUID(), { command: [join(await temp(), 'no-such-program')], cwd: tmpdir(), port: 4199, sandbox: null, env: { PATH: '/usr/bin:/bin' } }, () => {})).rejects.toThrow("The dev server couldn't start");
  expect(errors).toEqual(["Dev server couldn't start (Error ENOENT)"]);
});
