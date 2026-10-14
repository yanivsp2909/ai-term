import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pty from 'node-pty';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { UsageService } from '../src/daemon/usage-service.js';
import { KeyStore } from '../src/daemon/keys.js';
import * as engines from '../src/daemon/engines.js';
import { HttpReporter, reporterEnv } from '../src/agent/report.js';

// v0.6.1 through the real daemon: the budget route (B25) and cost per task (D55), as the agent and the CLIs report them.
const SECRET = 'AITERMCANARY-b25-0123456789abcdef', ENDPOINT = 'https://narvis-resource.openai.azure.com/openai/v1';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
async function daemon(settings: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-b25-daemon-'))), paths = getPaths(root); await preparePaths(paths);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'settings.json'), JSON.stringify({ theme: 'slate', worktrees: 'off', ...settings }), { mode: 0o600 });
  const log = new Logger(paths.log), usage = new UsageService(root, log), vault = new Map<string, string>();
  const keys = new KeyStore(root, { vault: { read: async a => vault.get(a) ?? null, write: async (a, s) => { vault.set(a, s); }, remove: async a => { vault.delete(a); } } });
  const manager = new SessionManager(paths, log, undefined, undefined, undefined, keys, usage, '/opt/ai-term/dist/cli/index.js');
  await usage.start(); await manager.load();
  cleanups.push(async () => { await manager.shutdown(); await usage.close(); });
  const spawned: { env: Record<string, string> }[] = [];
  const real = pty.spawn;
  vi.spyOn(pty, 'spawn').mockImplementation((file, args, options) => {
    spawned.push({ env: { ...(options?.env as Record<string, string>) } });
    return real('/bin/sh', ['-c', 'printf ready; read done'], { ...options, env: { PATH: '/usr/bin:/bin' } });
  });
  vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' });
  const foundry = await keys.add({ provider: 'foundry', label: 'narvis', secret: SECRET, endpoint: ENDPOINT, deployments: ['gpt-6.1-sol'] });
  await keys.saveTest(foundry.id, [{ model: 'gpt-6.1-sol', status: 'ready' }]);
  return { root, manager, usage, foundry, spawned };
}
async function agent(d: Awaited<ReturnType<typeof daemon>>) {
  const session = await d.manager.create({ engine: 'ai-term', model: 'gpt-6.1-sol', auth: { kind: 'key', keyId: d.foundry.id }, cwd: d.root, permission: 'ask' });
  const reporter = new HttpReporter(reporterEnv(d.spawned.at(-1)?.env ?? {}), () => { throw new Error('report failed'); });
  await expect.poll(() => d.manager.get(session.id).status).toBe('running');
  return { session, reporter };
}

it('two live agents race for the last of the daily budget through the daemon: one grant, one refusal', async () => {
  const d = await daemon({ budgets: { daily: 0.5, weekly: null, monthly: null } }), a = await agent(d), b = await agent(d);
  const answers = await Promise.all([a.reporter.reserve('gpt-6.1-sol', 0.3), b.reporter.reserve('gpt-6.1-sol', 0.3)]);
  expect(answers.filter(answer => answer && 'grant' in answer)).toHaveLength(1);
  expect(answers.filter(answer => answer && 'refused' in answer)).toEqual([{ refused: { budget: 'daily', spent: 0, reserved: 0.3, limit: 0.5 } }]);
  expect((await a.reporter.facts('gpt-6.1-sol'))?.reserved).toBeCloseTo(0.3, 10);
  // Booked at its worst case: Usage and the agent's own total show it.
  const winner = answers.findIndex(answer => answer && 'grant' in answer), granted = answers[winner], holder = winner === 0 ? a : b;
  if (!granted || !('grant' in granted)) throw new Error('no grant');
  await holder.reporter.settle(granted.grant.id, true);
  expect((await a.reporter.facts('gpt-6.1-sol'))?.reserved).toBe(0);
  expect(d.usage.summary().today.costUsd).toBeCloseTo(0.3, 10);
  expect(d.manager.get(holder.session.id).taskUsage).toEqual({ tokens: 0, costUsd: 0.3 });
});

it('the route refuses what isn\'t this agent\'s to reserve, and an agent that exits has its reservations booked', async () => {
  const d = await daemon({ budgets: { daily: 10, weekly: null, monthly: null } }), a = await agent(d);
  expect(await a.reporter.reserve('not-its-model', 0.1)).toBeNull();
  expect(await a.reporter.reserve('gpt-6.1-sol', -1)).toBeNull();
  const granted = await a.reporter.reserve('gpt-6.1-sol', 0.25);
  expect(granted && 'grant' in granted).toBe(true);
  await d.manager.stop(a.session.id);
  await expect.poll(() => d.usage.summary().today.costUsd).toBeCloseTo(0.25, 10);
  expect(await a.reporter.reserve('gpt-6.1-sol', 0.1)).toBeNull();
});

it('cost per task: an agent\'s own usage adds up on its record, priced from the table', async () => {
  const d = await daemon(), a = await agent(d);
  await a.reporter.usage('gpt-6.1-sol', { input: 1200, cached: 200, output: 300 });
  await expect.poll(() => d.manager.get(a.session.id).taskUsage?.tokens).toBe(1500);
  expect(d.manager.get(a.session.id).taskUsage?.costUsd).toBeCloseTo(d.usage.summary().today.costUsd, 10);
  // It survives a daemon restart with the record.
  const again = new SessionManager(getPaths(d.root), new Logger(getPaths(d.root).log));
  await again.load(); expect(again.get(a.session.id).taskUsage?.tokens).toBe(1500); await again.shutdown();
});

it('cost per task on a subscription counts tokens only, never in Usage or dollars; off in /settings sends no telemetry', async () => {
  const d = await daemon();
  const session = await d.manager.create({ engine: 'claude-code', model: 'sonnet', auth: { kind: 'account' }, cwd: d.root, permission: 'ask' });
  const env = d.spawned.at(-1)?.env ?? {};
  expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
  const credential = /x-ai-term-session=([a-f0-9]{64})/.exec(env.OTEL_EXPORTER_OTLP_METRICS_HEADERS ?? '')?.[1] ?? '', url = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? '';
  const point = (type: string, value: number) => ({ asInt: String(value), startTimeUnixNano: '1', timeUnixNano: String(Date.now() * 1e6), attributes: [{ key: 'type', value: { stringValue: type } }, { key: 'model', value: { stringValue: 'claude-sonnet-5' } }] });
  const body = { resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1, dataPoints: [point('input', 900), point('output', 100)] } }, { name: 'claude_code.cost.usage', sum: { aggregationTemporality: 1, dataPoints: [point('cost', 2)] } }] }] }] };
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ai-term-session': credential }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  await expect.poll(() => d.manager.get(session.id).taskUsage).toEqual({ tokens: 1000, costUsd: null });
  expect(d.usage.summary().today).toMatchObject({ tokens: 0, costUsd: 0 });
  const off = await daemon({ taskCost: false });
  await off.manager.create({ engine: 'claude-code', model: 'sonnet', auth: { kind: 'account' }, cwd: off.root, permission: 'ask' });
  expect(off.spawned.at(-1)?.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
});
