import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pty from 'node-pty';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { UsageService } from '../src/daemon/usage-service.js';
import { KeyStore } from '../src/daemon/keys.js';
import * as engines from '../src/daemon/engines.js';
import { cheapestWriter, handoffPlan, type Summarize } from '../src/daemon/handoff.js';
import { handoffMessage, HANDOFF_SUMMARY_BYTES } from '../src/shared/handoff.js';
import { cardText } from '../src/client/tui/agent-card.js';
import { validateSession, validateSettingsPatch } from '../src/shared/validate.js';
import type { KeyView, SessionInfo } from '../src/shared/protocol.js';
import type { PriceSnapshot } from '../src/daemon/usage-prices.js';

// v0.6.3 engine handoff (D55, off by default): a summary of one agent's screen starts a new agent of another engine in the
// same folder or worktree; the old one stops only after the new one runs.
const SECRET = 'AITERM' + 'CANARY-handoff-0123456789abcdef';
const snapshot: PriceSnapshot = { fetchedAt: '2026-10-12', providers: { anthropic: { 'claude-haiku-5': { input: 1, output: 5 }, 'claude-sonnet-5': { input: 3, output: 15 } }, openai: { 'gpt-6.1-mini': { input: 0.2, output: 0.8 } }, azure: {} } };
it('the summary writer is the cheapest priced model among your keys; none means the agent writes it', () => {
  const anthropic: KeyView = { id: randomUUID(), provider: 'anthropic', label: 'a', last4: 'aaaa' }, openai: KeyView = { id: randomUUID(), provider: 'openai', label: 'o', last4: 'oooo' };
  const writer = cheapestWriter([anthropic, openai], {}, snapshot);
  expect(writer && { provider: writer.key.provider, model: writer.model }).toEqual({ provider: 'openai', model: 'gpt-6.1-mini' });
  expect(cheapestWriter([], {}, snapshot)).toBeNull();
  const keyed = handoffPlan('fixer', 'claude-code', 'x'.repeat(3000), writer, false);
  expect(keyed.writer).toEqual({ kind: 'key', provider: 'openai', model: 'gpt-6.1-mini', keyLabel: 'o', last4: 'oooo' });
  expect(keyed.inputTokens.low).toBeLessThan(keyed.inputTokens.high); expect(keyed.outputTokens).toEqual({ low: 200, high: 2000 });
  expect(keyed.priceUsd?.high).toBeCloseTo((keyed.inputTokens.high * 0.2 + 2000 * 0.8) / 1e6, 10);
  expect(handoffPlan('fixer', 'codex', 'screen', null, true)).toMatchObject({ writer: { kind: 'agent' }, priceUsd: null, subscription: true });
});
it('the handoff message fits a first message and says where it came from', () => {
  const message = handoffMessage('fixer', '## Goal\n' + '😀'.repeat(10_000));
  expect(message.startsWith('Handoff from fixer.')).toBe(true); expect(Buffer.byteLength(message)).toBeLessThanOrEqual(HANDOFF_SUMMARY_BYTES);
  expect(message).not.toContain('�');
});
it('settings: handoff is off unless turned on (it spends tokens), and its switch is validated', () => {
  expect(validateSettingsPatch({ handoff: true }, true)).toEqual({ handoff: true });
  expect(() => validateSettingsPatch({ handoff: 'yes' }, true)).toThrow();
});
it('a card that handed off says where to', () => {
  const now = new Date().toISOString(), s: SessionInfo = { id: randomUUID(), title: 'fixer', engine: 'codex', model: null, auth: { kind: 'account' }, cwd: '/tmp', permission: 'ask', status: 'exited', statusDetail: 'exit 0', statusSince: now, exitCode: 0, createdAt: now, lastOutputAt: null, ctxPercent: null, lastActivity: null, handoffTo: 'fixer · claude code' };
  expect(cardText(s, Date.now(), 60).line3).toContain('handed off → fixer · claude code');
  expect(validateSession(s).handoffTo).toBe('fixer · claude code');
  expect(() => validateSession({ ...s, handoffTo: 'x'.repeat(500) })).toThrow();
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
async function daemon(settings: Record<string, unknown>, options: { key?: boolean; summarize?: Summarize } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-handoff-'))), paths = getPaths(root); await preparePaths(paths);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'settings.json'), JSON.stringify({ theme: 'graphite', worktrees: 'off', ...settings }), { mode: 0o600 });
  const log = new Logger(paths.log), usage = new UsageService(root, log), vault = new Map<string, string>();
  const keys = new KeyStore(root, { vault: { read: async a => vault.get(a) ?? null, write: async (a, s) => { vault.set(a, s); }, remove: async a => { vault.delete(a); } } });
  const manager = new SessionManager(paths, log, undefined, undefined, undefined, keys, usage, '/opt/ai-term/dist/cli/index.js');
  const prompts: string[] = [];
  manager.setHandoffWriter({ prices: snapshot, summarize: options.summarize ?? (async (_writer, secret, _endpoint, prompt) => { prompts.push(prompt); expect(secret).toBe(SECRET); return { text: '## Goal\nfix login\n## Done\nfound the bug\n## Left\nwrite the test\n## Files touched\nsrc/login.ts\n## Open questions\nnone', inputTokens: 1200, outputTokens: 300 }; }) });
  await usage.start(); await manager.load();
  cleanups.push(async () => { await manager.shutdown(); await usage.close(); });
  const spawned: { args: string[] }[] = [];
  const real = pty.spawn;
  vi.spyOn(pty, 'spawn').mockImplementation((_file, args, options) => { spawned.push({ args: Array.isArray(args) ? [...args] : [] }); return real('/bin/sh', ['-c', 'printf ready; read done; sleep 30'], { ...options, env: { PATH: '/usr/bin:/bin' } }); });
  const status = vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' });
  if (options.key !== false) await keys.add({ provider: 'openai', label: 'cheap', secret: SECRET });
  return { root, manager, usage, spawned, prompts, status };
}

it('off by default: /handoff is refused before anything runs', async () => {
  const d = await daemon({});
  const source = await d.manager.create({ engine: 'codex', model: null, auth: { kind: 'account' }, cwd: d.root, permission: 'ask', title: 'fixer' });
  await expect.poll(() => d.manager.get(source.id).status).toBe('running');
  await expect(d.manager.handoffPlan(source.id, 'claude-code')).rejects.toThrow('Handoff is off');
});

it('a keyed summary starts the new engine in the same folder with the note; the old agent stops only after it runs', async () => {
  const d = await daemon({ handoff: true });
  const source = await d.manager.create({ engine: 'codex', model: null, auth: { kind: 'account' }, cwd: d.root, permission: 'ask', title: 'fixer' });
  await expect.poll(() => d.manager.get(source.id).status).toBe('running');
  const plan = await d.manager.handoffPlan(source.id, 'claude-code');
  expect(plan.writer).toMatchObject({ kind: 'key', provider: 'openai' }); expect(plan.priceUsd).not.toBeNull();
  const order: string[] = [];
  d.manager.on('event', (event: { kind: string; session?: SessionInfo }) => { if (event.kind === 'session.updated' && event.session) order.push(`${event.session.title}:${event.session.status}`); });
  const result = await d.manager.handoff(source.id, 'claude-code');
  expect(result.session).toMatchObject({ engine: 'claude-code', cwd: d.root, auth: { kind: 'account' }, permission: 'ask' });
  expect(d.prompts[0]).toContain('ready');
  const args = d.spawned.at(-1)?.args ?? [];
  expect(args.at(-2)).toBe('--'); expect(args.at(-1)).toMatch(/^Handoff from fixer\.[\s\S]*## Left\nwrite the test/);
  await expect.poll(() => d.manager.get(source.id).status).toMatch(/^(exited|error)$/);
  expect(d.manager.get(source.id).handoffTo).toBe(result.session.title);
  const started = order.findIndex(entry => entry === `${result.session.title}:running`), stopped = order.findIndex(entry => entry.startsWith('fixer:') && /exited|error/.test(entry));
  expect(started).toBeGreaterThanOrEqual(0); expect(stopped).toBeGreaterThan(started);
  // The summary's real usage counts in Usage and on the old agent's task total; nothing else was spent.
  await expect.poll(() => d.usage.summary().today.tokens).toBe(1500);
  expect(result.summary).toMatchObject({ inputTokens: 1200, outputTokens: 300 });
});

it('refused while the source waits for you or runs a tool; a new agent that can\'t start leaves the old one running', async () => {
  const d = await daemon({ handoff: true });
  const source = await d.manager.create({ engine: 'codex', model: null, auth: { kind: 'account' }, cwd: d.root, permission: 'ask', title: 'fixer' });
  await expect.poll(() => d.manager.get(source.id).status).toBe('running');
  d.status.mockResolvedValue({ installed: false, path: null, version: null, loggedIn: null, authMethod: 'unknown' });
  await expect(d.manager.handoff(source.id, 'claude-code')).rejects.toThrow('claude not found in PATH');
  expect(d.manager.get(source.id).status).toBe('running'); expect(d.manager.get(source.id).handoffTo).toBeUndefined();
  // A session that is waiting on you is never handed off (simulated through the Codex approval title).
  const live = (d.manager as unknown as { sessions: Map<string, { codexRun?: string }> }).sessions.get(source.id);
  if (live) live.codexRun = 'action';
  d.status.mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' });
  await expect(d.manager.handoffPlan(source.id, 'claude-code')).rejects.toThrow('Agent is asking for permission');
});

it('with no key the agent writes its own note: its next reply becomes the new agent\'s first message', async () => {
  const d = await daemon({ handoff: true }, { key: false });
  const source = await d.manager.create({ engine: 'codex', model: null, auth: { kind: 'account' }, cwd: d.root, permission: 'ask', title: 'fixer' });
  await expect.poll(() => d.manager.get(source.id).status).toBe('running');
  const plan = await d.manager.handoffPlan(source.id, 'claude-code');
  expect(plan).toMatchObject({ writer: { kind: 'agent' }, priceUsd: null, subscription: true });
  const manager = d.manager as unknown as { sessions: Map<string, { reported?: boolean; lastReply?: string }>; ingressStatus(id: string, update: unknown): void };
  const live = manager.sessions.get(source.id); if (live) live.reported = true;
  // The agent finished its turn (H3: only a done agent writes its own note).
  manager.ingressStatus(source.id, { event: { seq: 50, at: new Date().toISOString(), kind: 'done' }, reply: 'earlier answer' });
  const handing = d.manager.handoff(source.id, 'claude-code');
  // The agent answers the request with its note (here: its turn-complete with a last reply), once the request has reached it.
  await expect.poll(() => d.manager.snapshot(source.id), { timeout: 10_000 }).toContain('Reply with the note only.');
  manager.ingressStatus(source.id, { event: { seq: 99, at: new Date().toISOString(), kind: 'done' }, reply: '## Goal\nship it\n## Left\ndocs' });
  const result = await handing;
  expect(d.spawned.at(-1)?.args.at(-1)).toMatch(/## Goal\nship it/);
  expect(result.summary).toBeNull();
});

import { EventEmitter } from 'node:events';
import headless from '@xterm/headless';
import { Homepage } from '../src/client/tui/homepage.js';
import { CredentialsPanel } from '../src/client/tui/credentials.js';
import type { Settings, SuccessResponse } from '../src/shared/protocol.js';
import type { RequestBody } from '../src/client/connection.js';
class TTY extends EventEmitter { isTTY = true; isRaw = false; columns = 130; rows = 45; output = ''; setRawMode(v: boolean) { this.isRaw = v; } resume() {} pause() {} write(data: string | Buffer) { this.output += data.toString(); return true; } }
async function screen(tty: TTY): Promise<string> { const terminal = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true }); try { await new Promise<void>(resolve => terminal.write(tty.output, resolve)); return Array.from({ length: 45 }, (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n'); } finally { terminal.dispose(); } }
const shows = (tty: TTY, text: string) => vi.waitFor(async () => expect(await screen(tty)).toContain(text));
const type = (tty: TTY, text: string) => { for (const char of text) tty.emit('data', Buffer.from(char)); };
const enter = (tty: TTY) => tty.emit('data', Buffer.from('\r'));
it('/handoff asks first with who writes the note, tokens and price; ⏎ runs it, Esc cancels', async () => {
  const now = new Date().toISOString(), fixer: SessionInfo = { id: randomUUID(), title: 'fixer', engine: 'codex', model: null, auth: { kind: 'account' }, cwd: '/tmp', permission: 'ask', status: 'running', statusDetail: 'running', statusSince: now, exitCode: null, createdAt: now, lastOutputAt: null, ctxPercent: null, lastActivity: null };
  const requests: RequestBody[] = [];
  const client = new (class extends EventEmitter { async request(body: RequestBody): Promise<SuccessResponse> {
    requests.push(body); const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.get') response.settings = { theme: 'graphite', handoff: true };
    if (body.kind === 'sessions.list') response.sessions = [fixer];
    if (body.kind === 'sessions.preview') { response.snapshot = 'agent screen'; response.cols = 85; response.rows = 30; }
    if (body.kind === 'sessions.handoffPlan') response.handoffPlan = { source: 'fixer', engine: 'claude-code', writer: { kind: 'key', provider: 'openai', model: 'gpt-6.1-mini', keyLabel: 'cheap', last4: 'oooo' }, inputTokens: { low: 1000, high: 3000 }, outputTokens: { low: 200, high: 2000 }, priceUsd: { low: 0.0004, high: 0.0022 }, subscription: false };
    if (body.kind === 'sessions.handoff') { response.session = { ...fixer, id: randomUUID(), title: 'fixer · claude code', engine: 'claude-code' }; response.handoffSummary = { inputTokens: 2400, outputTokens: 310, costUsd: 0.0007 }; }
    return response;
  } })();
  const tty = new TTY(), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', terminalProgram: 'unknown' });
  await home.start();
  try {
    type(tty, '/handoff fixer claude'); enter(tty);
    await shows(tty, 'Hand off fixer → claude code');
    await shows(tty, 'summary by gpt-6.1-mini · key ····oooo');
    await shows(tty, '1.0K–3.0K in · 200–2.0K out');
    await shows(tty, '$0.0004–$0.0022');
    expect(requests.some(r => r.kind === 'sessions.handoff')).toBe(false);
    tty.emit('data', Buffer.from('\x1b')); await vi.waitFor(async () => expect(await screen(tty)).not.toContain('Hand off fixer'));
    expect(requests.some(r => r.kind === 'sessions.handoff')).toBe(false);
    type(tty, '/handoff fixer claude'); enter(tty); await shows(tty, 'Hand off fixer → claude code');
    enter(tty);
    await shows(tty, '✓ handed off fixer → fixer · claude code · summary 2.4K in · 310 out · $0.0007');
    expect(requests.find(r => r.kind === 'sessions.handoff')).toEqual({ kind: 'sessions.handoff', sessionId: fixer.id, engine: 'claude-code', writer: { kind: 'key', provider: 'openai', model: 'gpt-6.1-mini', keyLabel: 'cheap', last4: 'oooo' }, account: 'own' });
    // v0.6 gate: ⏎ sends the account the ask showed (own when none), so a default changed meanwhile can't move it.
  } finally { await home.stop(); }
});
it('/settings has its own switch for handoff, off by default; g toggles it', async () => {
  let settings: Settings = { theme: 'graphite' };
  const panel = new CredentialsPanel('settings', { request: async body => { if (body.kind === 'settings.set') settings = { ...settings, ...body.patch }; return { id: randomUUID(), ok: true, settings, keys: [] }; }, changed() {}, close() {}, login: async () => {}, defaults() {}, theme: async () => {}, caps: vi.fn() });
  await panel.load();
  expect(panel.lines().join('\n')).toContain('handoff: off · /handoff spends tokens (g)');
  await panel.key('g'); expect(settings.handoff).toBe(true);
  expect(panel.lines().join('\n')).toContain('handoff: on · /handoff spends tokens (g)');
});
it('MEDIUM review: /handoff refuses a name two agents share, like /send', async () => {
  const now = new Date().toISOString(), base = { engine: 'codex' as const, model: null, auth: { kind: 'account' as const }, cwd: '/tmp', permission: 'ask' as const, status: 'done' as const, statusDetail: 'done', statusSince: now, exitCode: null, createdAt: now, lastOutputAt: null, ctxPercent: null, lastActivity: null };
  const twins: SessionInfo[] = [{ ...base, id: randomUUID(), title: 'Codex' }, { ...base, id: randomUUID(), title: 'Codex' }];
  const requests: RequestBody[] = [];
  const client = new (class extends EventEmitter { async request(body: RequestBody): Promise<SuccessResponse> { requests.push(body); const r: SuccessResponse = { id: randomUUID(), ok: true }; if (body.kind === 'settings.get') r.settings = { theme: 'graphite', handoff: true }; if (body.kind === 'sessions.list') r.sessions = twins; if (body.kind === 'sessions.preview') { r.snapshot = 'x'; r.cols = 85; r.rows = 30; } return r; } })();
  const tty = new TTY(), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', terminalProgram: 'unknown' });
  await home.start();
  try {
    type(tty, '/handoff Codex claude'); enter(tty);
    await shows(tty, '2 agents are named Codex · rename one with r');
    expect(requests.some(r => r.kind === 'sessions.handoffPlan')).toBe(false);
  } finally { await home.stop(); }
});
