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
import { BudgetLedger } from '../src/daemon/budget-ledger.js';
import * as engines from '../src/daemon/engines.js';
import type { Summarize } from '../src/daemon/handoff.js';
import { handoffMessage } from '../src/shared/handoff.js';
import type { PriceSnapshot } from '../src/daemon/usage-prices.js';

// Part E review (2026-10-15): security and silent-failure findings on the engine handoff.
const SECRET = 'AITERMCANARY-handoff-review-0123456789';
const snapshot: PriceSnapshot = { fetchedAt: '2026-10-12', providers: { anthropic: {}, openai: { 'gpt-6.1-mini': { input: 0.2, output: 0.8 } }, azure: {} } };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); SessionManager.handoffStartMs = 30_000; });
async function daemon(summarize?: Summarize, startScript = 'printf ready; read done; sleep 30') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-handoff-review-'))), paths = getPaths(root); await preparePaths(paths);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'settings.json'), JSON.stringify({ theme: 'graphite', worktrees: 'off', handoff: true }), { mode: 0o600 });
  const log = new Logger(paths.log), usage = new UsageService(root, log), vault = new Map<string, string>();
  const keys = new KeyStore(root, { vault: { read: async a => vault.get(a) ?? null, write: async (a, s) => { vault.set(a, s); }, remove: async a => { vault.delete(a); } } });
  const manager = new SessionManager(paths, log, undefined, undefined, undefined, keys, usage, '/opt/ai-term/dist/cli/index.js');
  let calls = 0;
  manager.setHandoffWriter({ prices: snapshot, summarize: summarize ?? (async () => { calls++; await new Promise(resolve => setTimeout(resolve, 50)); return { text: '## Goal\nship', inputTokens: 100, outputTokens: 20 }; }) });
  await usage.start(); await manager.load();
  cleanups.push(async () => { await manager.shutdown(); await usage.close(); });
  let spawns = 0; const real = pty.spawn;
  vi.spyOn(pty, 'spawn').mockImplementation((_file, _args, options) => real('/bin/sh', ['-c', spawns++ === 0 ? 'printf ready; read done; sleep 30' : startScript], { ...options, env: { PATH: '/usr/bin:/bin' } }));
  vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' });
  await keys.add({ provider: 'openai', label: 'cheap', secret: SECRET });
  const source = await manager.create({ engine: 'codex', model: null, auth: { kind: 'account' }, cwd: root, permission: 'ask', title: 'fixer' });
  await expect.poll(() => manager.get(source.id).status).toBe('running');
  return { manager, source, calls: () => calls, root };
}

it('MEDIUM: two handoffs of one agent at once: exactly one runs, one summary is paid', async () => {
  const d = await daemon();
  const results = await Promise.allSettled([d.manager.handoff(d.source.id, 'claude-code'), d.manager.handoff(d.source.id, 'claude-code')]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: new Error('Handoff already running') });
  expect(d.calls()).toBe(1);
});
it('MEDIUM: the note reaching argv carries no escapes, controls or bidi overrides; lines and tabs stay', () => {
  const message = handoffMessage('x', 'a\x1b]52;c;AAAA\x07b\x1b[2Jc\u202e\u0085d\r\ne\tf');
  // eslint-disable-next-line no-control-regex -- the controls are what must be gone.
  expect(message).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
  expect(message).toContain('\ne\tf');
  expect(handoffMessage('x', '👩\u200d💻 日本')).toContain('👩\u200d💻 日本');
});
it('LOW: the handoff runs only with the writer the user approved', async () => {
  const d = await daemon();
  await expect(d.manager.handoff(d.source.id, 'claude-code', { kind: 'agent' })).rejects.toThrow('The summary writer changed; run /handoff again');
  expect(d.calls()).toBe(0);
});
it('MEDIUM: a new agent that never starts is stopped again, so only the old one keeps working', async () => {
  SessionManager.handoffStartMs = 300;
  const d = await daemon(undefined, 'sleep 30');
  await expect(d.manager.handoff(d.source.id, 'claude-code')).rejects.toThrow("The new agent didn't start; the old one keeps running");
  await expect.poll(() => d.manager.list().filter(s => !['exited', 'error'].includes(s.status)).map(s => s.title)).toEqual(['fixer']);
});
it('MEDIUM: a failing usage record for the summary is logged, the hold released, and the handoff goes on', async () => {
  const d = await daemon();
  const usage = (d.manager as unknown as { usage: UsageService }).usage;
  vi.spyOn(usage, 'job').mockRejectedValue(new Error('disk'));
  const result = await d.manager.handoff(d.source.id, 'claude-code');
  expect(result.session.engine).toBe('claude-code');
  expect((d.manager as unknown as { ledger: BudgetLedger }).ledger.reserved()).toBe(0);
});
it('LOW: an agent that got busy while the note was written keeps running, and the answer says so', async () => {
  let release = () => {}, writing = false; const gate = new Promise<void>(resolve => { release = resolve; });
  const d = await daemon(async () => { writing = true; await gate; return { text: '## Goal\nship', inputTokens: 1, outputTokens: 1 }; });
  const handing = d.manager.handoff(d.source.id, 'claude-code');
  await expect.poll(() => writing).toBe(true);
  const live = (d.manager as unknown as { sessions: Map<string, { codexRun?: string }> }).sessions.get(d.source.id); if (live) live.codexRun = 'action';
  release();
  const result = await handing;
  expect(result.oldKeptRunning).toBe(true);
  expect(d.manager.get(d.source.id).status).toBe('running');
  expect(d.manager.get(d.source.id).handoffTo).toBeUndefined();
});
it('MEDIUM: a booking that fails never stops the daemon (no unhandled rejection) and is logged', async () => {
  const errors: string[] = [], ledger = new BudgetLedger({ book: async () => { throw new Error('x'); }, log: { error: text => { errors.push(text); } } });
  const id = crypto.randomUUID(); ledger.reserve({ sessionId: id, provider: 'openai', model: 'gpt-6.1-mini', amountUsd: 1 }, { daily: null, weekly: null, monthly: null }, { day: 0, week: 0, month: 0 });
  await expect(ledger.releaseSession(id)).resolves.toBeUndefined();
  expect(errors).toContain('Budget reservation could not be booked');
  await ledger.close();
});

import { requestTimeout } from '../src/client/connection.js';
it('HIGH: the client waits as long as a handoff can take (note, start, stop), and the plan longer than a quick request', () => {
  expect(requestTimeout('sessions.handoff')).toBeGreaterThanOrEqual(360_000);
  expect(requestTimeout('sessions.handoffPlan')).toBeGreaterThanOrEqual(30_000);
  expect(requestTimeout('sessions.list')).toBe(5000);
});
it('HIGH: with no key, an agent still working is refused, so its pending reply can never become the note; /send waits too', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-handoff-stale-'))), paths = getPaths(root); await preparePaths(paths);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'settings.json'), JSON.stringify({ theme: 'graphite', worktrees: 'off', handoff: true }), { mode: 0o600 });
  const log = new Logger(paths.log), usage = new UsageService(root, log), manager = new SessionManager(paths, log, undefined, undefined, undefined, undefined, usage);
  await usage.start(); await manager.load(); cleanups.push(async () => { await manager.shutdown(); await usage.close(); });
  const real = pty.spawn;
  vi.spyOn(pty, 'spawn').mockImplementation((_file, _args, options) => real('/bin/sh', ['-c', 'printf ready; read done; sleep 30'], { ...options, env: { PATH: '/usr/bin:/bin' } }));
  vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' });
  const source = await manager.create({ engine: 'codex', model: null, auth: { kind: 'account' }, cwd: root, permission: 'ask', title: 'fixer' });
  await expect.poll(() => manager.get(source.id).status).toBe('running');
  await expect(manager.handoff(source.id, 'claude-code')).rejects.toThrow('Agent is still working · hand off when it is done');
});
it('MEDIUM: the source exiting while the note is written is charged once, and no new agent starts from it', async () => {
  let release = () => {}, writing = false; const gate = new Promise<void>(resolve => { release = resolve; });
  const d = await daemon(async () => { writing = true; await gate; return { text: '## Goal\nship', inputTokens: 100, outputTokens: 20 }; });
  const handing = d.manager.handoff(d.source.id, 'claude-code');
  await expect.poll(() => writing).toBe(true);
  await d.manager.stop(d.source.id);
  release();
  await expect(handing).rejects.toThrow('Agent exited before the handoff finished');
  const usage = (d.manager as unknown as { usage: UsageService }).usage;
  const worst = usage.summary().today.costUsd;
  expect(worst).toBeGreaterThan(0);
  expect(d.manager.list().filter(s => s.engine === 'claude-code')).toHaveLength(0);
  // One charge: the held worst case, not that plus the real usage.
  expect(worst).toBeCloseTo((d.manager as unknown as { lastHandoffWorst: number }).lastHandoffWorst, 10);
});

// Fix review (2026-10-15).
import { validateRequest } from '../src/shared/validate.js';
it('MEDIUM fix review: only bidi overrides and line separators go; ZWJ, ZWNJ, emoji tags and RLM stay', () => {
  const text = 'team 👨\u200d👩\u200d👧 and 🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f} and می\u200cخواهم \u200f', message = handoffMessage('a', text + '\u202e\u2066x\u2028');
  expect(message).toContain(text.trim()); expect(message).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u2028\u2029]/);
});
it('LOW fix review: a note of only escapes is empty; the socket needs the approved writer; a kept agent is not marked handed off', async () => {
  const d = await daemon(async () => ({ text: '\x1b[0m\u202e', inputTokens: 1, outputTokens: 1 }));
  await expect(d.manager.handoff(d.source.id, 'claude-code')).rejects.toThrow('The handoff note came back empty');
  await expect(validateRequest({ id: crypto.randomUUID(), kind: 'sessions.handoff', sessionId: d.source.id, engine: 'codex' })).rejects.toThrow('Invalid handoff request');
});
