import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, realpath, mkdir, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import pty from 'node-pty';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { UsageService } from '../src/daemon/usage-service.js';
import { KeyStore } from '../src/daemon/keys.js';
import { BudgetLedger, type Reservation } from '../src/daemon/budget-ledger.js';
import * as engines from '../src/daemon/engines.js';
import { prepareProfile } from '../src/daemon/accounts.js';
import { listOllama, OllamaError } from '../src/daemon/providers/ollama.js';
import { HttpReporter } from '../src/agent/report.js';
import { RunLimits } from '../src/agent/limits.js';
import { redactSecrets } from '../src/shared/redact.js';
import { handoffMessage, handoffPrompt, validateHandoffPlan, type HandoffPlan } from '../src/shared/handoff.js';
import { handoffLines, handoffRequest } from '../src/client/tui/handoff-ask.js';
import { presetAuthLabel } from '../src/client/tui/presets.js';
import { accountAuthLabel } from '../src/client/tui/accounts.js';
import type { PriceSnapshot } from '../src/daemon/usage-prices.js';
import type { Preset } from '../src/shared/presets.js';
import { stubFacts } from './fixtures/agent-facts.js';
import { AS_ROOT } from './platform.js';

// v0.6 release gate (Part B, 2026-10-15): five fresh reviewers (security ×2, bounty hunter, silent failures, code review).
// Each real finding is a failing test here before its fix.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const tempDir = async (prefix: string) => { const root = await realpath(await mkdtemp(join(tmpdir(), prefix))); cleanups.push(() => rm(root, { recursive: true, force: true })); return root; };
const plan = (over: Partial<HandoffPlan> = {}): HandoffPlan => ({ source: 'fixer', engine: 'codex', writer: { kind: 'agent' }, inputTokens: { low: 1, high: 2 }, outputTokens: { low: 1, high: 2 }, priceUsd: null, subscription: true, ...over });

// ---- handoff ----
it('MEDIUM (accounts review): the handoff ask names the account that starts, and ⏎ sends exactly that one', () => {
  expect(handoffLines(plan({ account: 'work' })).map(l => l.text).join('\n')).toContain('codex starts on account work');
  expect(handoffLines(plan()).map(l => l.text).join('\n')).toContain('codex starts on your own login');
  const id = randomUUID();
  // No account typed and none in the plan: "own" is sent, so a default changed between the ask and ⏎ can't move it.
  expect(handoffRequest(plan(), id)).toEqual({ kind: 'sessions.handoff', sessionId: id, engine: 'codex', writer: { kind: 'agent' }, account: 'own' });
  expect(handoffRequest(plan({ account: 'work' }), id)).toMatchObject({ account: 'work' });
});

it('MEDIUM (accounts review): secrets on the agent\'s screen never reach the summary request or the new agent\'s argv', () => {
  const secrets = ['sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'sk-proj-BBBBBBBBBBBBBBBBBBBBBBBB', 'ghp_' + 'C'.repeat(36), 'AKIA' + 'IOSFODNN7EXAMPLE', 'xai-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', 'AIza' + 'SyEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE', 'xox' + 'b-1234567890-abcdefghij'];
  const screen = `$ cat .env\nANTHROPIC_API_KEY=${secrets[0]}\nexport DB_PASSWORD="hunter2-long-value"\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz012345\n${secrets.slice(1).join('\n')}\n-----BEGIN OPENSSH ${'PRIVATE'} KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\nall tests pass`;
  for (const text of [handoffPrompt('codex', screen), handoffMessage('fixer', screen)]) {
    for (const secret of [...secrets, 'hunter2-long-value', 'abcdefghijklmnopqrstuvwxyz012345', 'b3BlbnNzaC1rZXktdjEAAAAA']) expect(text).not.toContain(secret);
    expect(text).toContain('ANTHROPIC_API_KEY=[redacted]'); expect(text).toContain('all tests pass');
  }
  // Ordinary text survives: hashes, ids, words with "key" in them.
  expect(redactSecrets('commit 3f2a9c1d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c · the key point · task-1234')).toBe('commit 3f2a9c1d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c · the key point · task-1234');
});

it('LOW (code review): an agent titled with emoji can still hand off (lengths count characters, not UTF-16 units)', () => {
  const title = 'Deploy fix ' + '🚀'.repeat(30);
  expect(() => validateHandoffPlan(plan({ source: title }))).not.toThrow();
});

const snapshot: PriceSnapshot = { fetchedAt: '2026-10-12', providers: { anthropic: {}, openai: { 'gpt-6.1-mini': { input: 0.2, output: 0.8 } }, azure: {} } };
async function handoffDaemon(options: { usage: boolean; startScript?: string; budget?: boolean }) {
  const root = await tempDir('ai-gate06-'), paths = getPaths(root); await preparePaths(paths);
  await writeFile(join(root, 'settings.json'), JSON.stringify({ theme: 'graphite', worktrees: 'off', handoff: true, ...(options.budget ? { budgets: { daily: 0.000001, weekly: null, monthly: null } } : {}) }), { mode: 0o600 });
  const log = new Logger(paths.log), usage = options.usage ? new UsageService(root, log) : undefined, vault = new Map<string, string>();
  const keys = new KeyStore(root, { vault: { read: async a => vault.get(a) ?? null, write: async (a, s) => { vault.set(a, s); }, remove: async a => { vault.delete(a); } } });
  const manager = new SessionManager(paths, log, undefined, undefined, undefined, keys, usage, '/opt/ai-term/dist/cli/index.js');
  let calls = 0;
  manager.setHandoffWriter({ prices: snapshot, summarize: async () => { calls++; return { text: '## Goal\nship', inputTokens: 100, outputTokens: 20 }; } });
  await usage?.start(); await manager.load();
  cleanups.push(async () => { await manager.shutdown(); await usage?.close(); });
  let spawns = 0; const real = pty.spawn;
  const later = options.startScript ?? 'printf ready; read done; sleep 30';
  vi.spyOn(pty, 'spawn').mockImplementation((_file, _args, spawnOptions) => real('/bin/sh', ['-c', spawns++ === 0 ? 'printf ready; read done; sleep 30' : later], { ...spawnOptions, env: { PATH: '/usr/bin:/bin' } }));
  vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' });
  await keys.add({ provider: 'openai', label: 'cheap', secret: 'AITERM' + 'CANARY-gate06-0123456789abcdef' });
  const source = await manager.create({ engine: 'codex', model: null, auth: { kind: 'account' }, cwd: root, permission: 'ask', title: 'fixer' });
  await expect.poll(() => manager.get(source.id).status).toBe('running');
  return { root, paths, manager, source, calls: () => calls };
}

it('MEDIUM (silent failures): with no budget ledger a keyed handoff summary is refused, never sent unchecked', async () => {
  const d = await handoffDaemon({ usage: false, budget: true });
  await expect(d.manager.handoff(d.source.id, 'claude-code')).rejects.toThrow('Budget check unavailable; try again');
  expect(d.calls()).toBe(0);
});

it('LOW (code review): "handed off →" survives a daemon restart', async () => {
  const d = await handoffDaemon({ usage: true });
  const result = await d.manager.handoff(d.source.id, 'claude-code');
  expect(result.oldKeptRunning).toBe(false);
  await expect.poll(async () => (await readFile(d.paths.state, 'utf8')).includes('handoffTo')).toBe(true);
  await d.manager.shutdown();
  const again = new SessionManager(d.paths, new Logger(d.paths.log));
  await again.load(); cleanups.push(() => again.shutdown());
  expect(again.get(d.source.id).handoffTo).toBe(result.session.title);
});

it('LOW (silent failures): a new agent that didn\'t start and couldn\'t be stopped says so, not "the old one keeps running" alone', async () => {
  SessionManager.handoffStartMs = 300; cleanups.push(async () => { SessionManager.handoffStartMs = 30_000; });
  const d = await handoffDaemon({ usage: true, startScript: 'sleep 30' });
  const realStop = d.manager.stop.bind(d.manager);
  vi.spyOn(d.manager, 'stop').mockImplementation(async id => { if (id !== d.source.id) throw new Error('Session stop timed out'); return realStop(id); });
  await expect(d.manager.handoff(d.source.id, 'claude-code')).rejects.toThrow("The new agent didn't start and couldn't be stopped; stop it with s");
});

// ---- budgets ----
async function ledger(options: Partial<ConstructorParameters<typeof BudgetLedger>[0]> = {}) {
  const root = await tempDir('ai-gate06-ledger-'), file = join(root, 'budget-reservations.json'), booked: Reservation[] = [], errors: string[] = [], warnings: [string, string | null][] = [];
  const made = new BudgetLedger({ file, book: async r => { booked.push(r); }, log: { error: text => { errors.push(text); } }, warn: (key, text) => { warnings.push([key, text]); }, ...options });
  return { ledger: made, file, root, booked, errors, warnings };
}
const daily = (limit: number) => ({ daily: limit, weekly: null, monthly: null }), none = { day: 0, week: 0, month: 0 };
const request = (sessionId: string, amountUsd: number, id?: string) => ({ sessionId, provider: 'openai' as const, model: 'gpt-6.1-mini', amountUsd, ...(id ? { id } : {}) });

it('MEDIUM (code review): a reserve the agent stopped waiting for is cancelled, never held and booked as phantom spend', async () => {
  const l = await ledger(), session = randomUUID(), id = randomUUID();
  // The agent gave up first: its cancel (a settle for an id not held yet) arrives before the late reserve.
  expect(await l.ledger.settle(session, id, false)).toBe(false);
  expect(l.ledger.reserve(request(session, 0.4, id), daily(1), none)).toMatchObject({ refused: { budget: 'unavailable' } });
  expect(l.ledger.reserved()).toBe(0);
  // Or the reserve is granted first and the cancel releases it without booking.
  const other = randomUUID();
  expect(l.ledger.reserve(request(session, 0.4, other), daily(1), none)).toEqual({ grant: { id: other } });
  expect(await l.ledger.settle(session, other, false)).toBe(true);
  expect(l.booked).toEqual([]); expect(l.ledger.reserved()).toBe(0);
  // An id can't be reused, and another session can't cancel this one's id.
  const third = randomUUID();
  expect(l.ledger.reserve(request(session, 0.1, third), daily(1), none)).toEqual({ grant: { id: third } });
  expect(l.ledger.reserve(request(session, 0.1, third), daily(1), none)).toMatchObject({ refused: { budget: 'unavailable' } });
  expect(await l.ledger.settle(randomUUID(), third, false)).toBe(false); expect(l.ledger.reserved()).toBeCloseTo(0.1);
});

it('MEDIUM (code review): the agent cancels a reserve whose answer came too late', async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let raw = ''; req.on('data', c => { raw += String(c); }); req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>; bodies.push(body);
      if (body.kind === 'budget.reserve') setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ grant: { id: body.id } })); }, 1500);
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ settled: false })); }
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); cleanups.push(() => new Promise<void>(r => server.close(() => r())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no address');
  const reporter = new HttpReporter({ port: address.port, status: 'a'.repeat(64) }, () => {});
  expect(await reporter.reserve('gpt-6.1-mini', 0.4)).toBeNull();
  await expect.poll(() => bodies.map(b => b.kind)).toEqual(['budget.reserve', 'budget.settle']);
  const [reserve, cancel] = bodies;
  expect(typeof reserve?.id).toBe('string'); expect(cancel).toEqual({ kind: 'budget.settle', id: reserve?.id, worstCase: false });
}, 10_000);

it('LOW (budgets review): the grant goes out only once the hold is on disk', async () => {
  const l = await ledger(), session = randomUUID();
  const answer = l.ledger.reserve(request(session, 0.2), daily(1), none);
  await l.ledger.flushed();
  expect(JSON.parse(await readFile(l.file, 'utf8'))).toMatchObject({ reservations: [{ id: 'grant' in answer ? answer.grant.id : '', amountUsd: 0.2 }] });
});

it.skipIf(AS_ROOT)('MEDIUM (silent failures): a hold that can\'t be saved warns on the homepage until a save works again (skipped as root: file modes do not stop root)', async () => {
  const l = await ledger(), session = randomUUID();
  await chmod(l.root, 0o500); cleanups.push(() => chmod(l.root, 0o700));
  l.ledger.reserve(request(session, 0.2), daily(1), none); await l.ledger.flushed();
  expect(l.warnings.at(-1)).toEqual(['save', 'Budget holds could not be saved; agents keep running.']);
  await chmod(l.root, 0o700);
  l.ledger.reserve(request(session, 0.2), daily(1), none); await l.ledger.flushed();
  expect(l.warnings.at(-1)).toEqual(['save', null]);
});

it('MEDIUM + LOW (silent failures, budgets review): an unreadable or partly bad reservation file warns, and one failing booking doesn\'t stop the rest', async () => {
  const l = await ledger();
  await writeFile(l.file, '{not json', { mode: 0o600 });
  await l.ledger.load();
  expect(l.warnings).toContainEqual(['load', 'Some in-flight spend from the last run could not be counted.']);
  const good = (n: number) => ({ id: randomUUID(), sessionId: randomUUID(), provider: 'openai', model: 'm', amountUsd: n, at: new Date().toISOString() });
  let calls = 0; const booked: number[] = [];
  const m = await ledger({ book: async r => { if (calls++ === 0) throw new Error('disk'); booked.push(r.amountUsd); } });
  await writeFile(m.file, JSON.stringify({ v: 1, reservations: [good(1), good(2), { junk: true }] }), { mode: 0o600 });
  await m.ledger.load();
  expect(booked).toEqual([2]); expect(m.errors).toContain('Budget reservation could not be booked at start');
  expect(m.warnings).toContainEqual(['load', 'Some in-flight spend from the last run could not be counted.']);
});

it('LOW (silent failures): a refused reserve logs why, once per session and reason', async () => {
  const l = await ledger(), session = randomUUID();
  for (let i = 0; i < 16; i++) l.ledger.reserve(request(session, 0), daily(1), none);
  l.ledger.reserve(request(session, 0), daily(1), none); l.ledger.reserve(request(session, 0), daily(1), none);
  expect(l.errors.filter(e => e === 'Budget reserve refused: too many held for one agent')).toHaveLength(1);
});

it('MEDIUM (budgets review): with a budget set, an unpriced model never goes on without a price; a spend cap alone may', () => {
  const limits = new RunLimits();
  const budgeted = limits.check(stubFacts({ model: 'vendor/x', budgets: { daily: 5, weekly: null, monthly: null } }), 100);
  expect(budgeted?.text).toContain("no price known for vendor/x, so your budgets can't count it"); expect(budgeted?.onContinue).toBeUndefined();
  const capped = new RunLimits().check(stubFacts({ model: 'vendor/x', caps: { turns: null, spendUsd: 5 } }), 100);
  expect(capped?.text).toContain("not counted in this run's spend cap"); expect(capped?.onContinue).toBeTypeOf('function');
});

// ---- accounts, presets, providers ----
it('LOW (code review): labels name the account that will bill: a picked one, else the engine\'s default, else your own login', () => {
  expect(accountAuthLabel({ kind: 'account' }, 'codex', { codex: 'work' }, 'own login · sub')).toBe('account work');
  expect(accountAuthLabel({ kind: 'account' }, 'claude-code', { codex: 'work' }, 'own login · sub')).toBe('own login · sub');
  expect(accountAuthLabel({ kind: 'account', profile: 'own' }, 'codex', { codex: 'work' }, 'own login · sub')).toBe('own login · sub');
  expect(accountAuthLabel({ kind: 'account', profile: 'side' }, 'codex', { codex: 'work' }, 'own login · sub')).toBe('account side');
  const preset = { engine: 'codex', auth: { kind: 'account', profile: 'side' } } as unknown as Preset;
  expect(presetAuthLabel(preset, [])).toBe('account side');
  expect(presetAuthLabel({ ...preset, auth: { kind: 'account' } } as Preset, [], { codex: 'work' })).toBe('account work');
});

it('LOW (accounts review): an account name reused for the other engine is refused, not mixed with its links', async () => {
  const root = await tempDir('ai-gate06-prof-'), home = await tempDir('ai-gate06-home-');
  await mkdir(join(home, '.claude', 'skills'), { recursive: true }); await mkdir(join(home, '.codex', 'skills'), { recursive: true });
  await prepareProfile(root, 'claude-code', 'work', home);
  await expect(prepareProfile(root, 'codex', 'work', home)).rejects.toThrow('Account folder belongs to another engine; pick a new name');
  // The same engine again is fine (the folder keeps its login).
  await expect(prepareProfile(root, 'claude-code', 'work', home)).resolves.toBe(join(root, 'profiles', 'work'));
  // A link someone pointed elsewhere is refused too.
  await mkdir(join(root, 'profiles', 'odd'), { recursive: true, mode: 0o700 }); await symlink('/etc', join(root, 'profiles', 'odd', 'skills'));
  await expect(prepareProfile(root, 'claude-code', 'odd', home)).rejects.toThrow('Account folder belongs to another engine; pick a new name');
});

it('LOW (silent failures): an Ollama listing failure keeps its class for the log (never the body)', async () => {
  const caught = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (error) { return error; } return null; };
  const status = await caught(() => listOllama('http://127.0.0.1:11434', async () => ({ status: 503, body: 'secret text' })));
  expect(status).toBeInstanceOf(OllamaError); expect((status as OllamaError).detail).toBe('status 503');
  const json = await caught(() => listOllama('http://127.0.0.1:11434', async () => ({ status: 200, body: 'nope' })));
  expect((json as OllamaError).detail).toBe('not a model list');
  const reset = await caught(() => listOllama('http://127.0.0.1:11434', async () => { throw Object.assign(new Error('x secret'), { code: 'ECONNRESET' }); }));
  expect((reset as OllamaError).detail).toBe('ECONNRESET');
});

// ---- fix review (fresh typescript-reviewer on 750c544) ----
it('HIGH (fix review): bare and JSON-quoted secret names are redacted too', () => {
  for (const [input, gone] of [['PASSWORD=hunter2', 'hunter2'], ['password=hunter2', 'hunter2'], ['SECRET=abc123', 'abc123'], ['TOKEN=abc123', 'abc123'], ['{"password": "hunter2"}', 'hunter2'], ['"api_key":"abcd1234"', 'abcd1234'], ["apiKey: 'zz9-QQ-zz9'", 'zz9-QQ-zz9'], ['refreshToken=eyJhbGciOi.x', 'eyJhbGciOi.x']] as const)
    expect(redactSecrets(input), input).not.toContain(gone);
});

it('MEDIUM (fix review): ordinary code and notes are left alone', () => {
  for (const text of ['max_tokens: 4096', 'monkey=1', 'export const sortKey: string = "a"', 'password: string', 'const token = getToken();', 'Key: do this first', 'Basic src/daemon/session-manager.ts', 'primaryKey: id', 'type K = keyof T', 'see sk-learn docs'])
    expect(redactSecrets(text), text).toBe(text);
});

it('MEDIUM (fix review): a long unbroken run is redacted in linear time', () => {
  const started = performance.now();
  redactSecrets('a-'.repeat(25_000)); redactSecrets('x'.repeat(100_000) + 'KEY=1');
  expect(performance.now() - started).toBeLessThan(200);
});

it('LOW (fix review): a secret split by a control or cut at the 48k edge is still redacted', () => {
  expect(handoffMessage('x', 'sk-ant-api03-AAAA\u0007AAAAAAAAAAAAAAAAAAAAAA')).not.toContain('AAAAAAAAAAAAAAAAAAAAAA');
  const key = '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----\n' + 'Q'.repeat(2000) + '\n-----END OPENSSH PRIVATE KEY-----\n';
  const screen = 'x'.repeat(48_000 - 1000) + key + 'y'.repeat(500);
  expect(handoffPrompt('codex', screen)).not.toContain('QQQQQQQQQQ');
});
