import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import headless from '@xterm/headless';
import { Homepage } from '../src/client/tui/homepage.js';
import { BrainAsk, brainLines } from '../src/client/tui/brain-ask.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SuccessResponse } from '../src/shared/protocol.js';
import type { BrainPlan } from '../src/shared/brain.js';

// v1.0.2 /brain on the homepage, typed as you would: the ask shows what is mapped, what is skipped and what a model pass
// costs; ⏎ on the first row builds the free local map; ↓ then ⏎ builds with that model; a turns agents on or off;
// /brain show opens it; /brain rm deletes it.
const keyId = randomUUID();
const plan: BrainPlan = { repo: '/tmp/proj', files: 42, changed: 3, removed: 1, skipped: { binary: 2, large: 0, env: 1, secret: 0 }, builtAt: new Date(Date.now() - 2 * 3600_000).toISOString(), summarize: 3,
  inputTokens: { low: 8000, high: 12500 }, outputTokens: { low: 90, high: 780 }, models: [{ keyId, provider: 'anthropic', keyLabel: 'work', last4: 'aaaa', model: 'claude-haiku-5', priceUsd: { low: 0.0084, high: 0.0164 } }], selected: 0, fingerprint: 'f'.repeat(64), agents: true };

it('the ask: what changed, what is skipped, the free local pass first, then each model with its price; Esc cancels', () => {
  const lines = brainLines(plan, 0).map(line => line.text);
  expect(lines[0]).toBe('Brain · proj · 42 files · 3 changed, 1 removed since the last map (2h old)');
  expect(lines).toContain("skipped: 2 binary, 1 .env; ignored files aren't read");
  expect(lines).toContain('› local map only · free');
  expect(lines).toContain('  claude-haiku-5 · key ····aaaa · $0.0084–$0.02');
  expect(lines.join('\n')).toContain('model pass: a short summary of 3 modules and the main design decisions, secrets removed · estimated 8.0K–12.5K in · 90–780 out');
  expect(lines.at(-1)).toBe('↑↓ choose · ⏎ builds · a agents on/off · Esc cancels');
  const build = vi.fn(), agents = vi.fn(), close = vi.fn();
  const ask = new BrainAsk(plan, () => {}, close, build, agents);
  ask.key('a'); expect(agents).toHaveBeenCalledWith(false);
  ask.key('down'); ask.key('enter'); expect(build).toHaveBeenCalledWith(plan.models[0]);
  const free = new BrainAsk(plan, () => {}, () => {}, build, agents); free.key('enter'); expect(build).toHaveBeenLastCalledWith(null);
});

class TTY extends EventEmitter { isTTY = true; isRaw = false; columns = 130; rows = 45; output = ''; setRawMode(v: boolean) { this.isRaw = v; } resume() {} pause() {} write(data: string | Buffer) { this.output += data.toString(); return true; } }
async function screen(tty: TTY): Promise<string> { const terminal = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true }); try { await new Promise<void>(resolve => terminal.write(tty.output, resolve)); return Array.from({ length: 45 }, (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n'); } finally { terminal.dispose(); } }
const shows = (tty: TTY, text: string) => vi.waitFor(async () => expect(await screen(tty)).toContain(text));

it('typed: /brain asks, ⏎ builds the free map, /brain show opens it, /brain rm deletes it', async () => {
  const sent: RequestBody[] = [];
  const client = Object.assign(new EventEmitter(), { async request(body: RequestBody): Promise<SuccessResponse> {
    sent.push(body); const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.get') response.settings = { theme: 'graphite' };
    if (body.kind === 'sessions.list') response.sessions = [];
    if (body.kind === 'keys.list') response.keys = [];
    if (body.kind === 'brain.plan') response.brainPlan = plan;
    if (body.kind === 'brain.build') response.brainResult = { repo: '/tmp/proj', path: '/h/.ai-term/brain/proj-0123456789/brain.md', lines: 120, files: 42, changed: 3, summarized: 0, costUsd: null, model: null };
    if (body.kind === 'brain.show') response.brainText = { repo: '/tmp/proj', text: '# Brain: proj\n\n## Modules\n### src/a.ts\nexports: foo', builtAt: new Date().toISOString() };
    return response;
  } });
  const tty = new TTY(), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp/proj', terminalProgram: 'unknown' });
  await home.start();
  const type = (text: string) => { for (const char of text) tty.emit('data', Buffer.from(char)); };
  type('/brain\r');
  await shows(tty, 'Brain · proj · 42 files');
  type('\r');
  await vi.waitFor(() => expect(sent).toContainEqual({ kind: 'brain.build', cwd: '/tmp/proj', fingerprint: plan.fingerprint }));
  await shows(tty, '✓ brain for proj: 42 files, 120 lines · /brain show');
  type('/brain show\r');
  await shows(tty, '# Brain: proj');
  type('\x1b');
  // A lone Esc, then typing: right after it, a / would read as Alt+/. Esc has gone through once the brain view is closed.
  await vi.waitFor(async () => expect(await screen(tty)).not.toContain('# Brain: proj'), { timeout: 10_000 });
  type('/brain rm\r');
  await vi.waitFor(() => expect(sent).toContainEqual({ kind: 'brain.remove', cwd: '/tmp/proj' }));
  await shows(tty, '✓ brain removed for this repository · /brain builds a new one');
});


it('B30: start box shows remembered brain choice, b changes this agent and saves it for this repository', async () => {
  const sent: RequestBody[] = [];
  const client = Object.assign(new EventEmitter(), { async request(body: RequestBody): Promise<SuccessResponse> {
    sent.push(body);
    return { id: randomUUID(), ok: true,
      ...(body.kind === 'settings.get' ? { settings: { theme: 'graphite' as const } } : {}),
      ...(body.kind === 'sessions.list' ? { sessions: [] } : {}),
      ...(body.kind === 'keys.list' ? { keys: [] } : {}),
      ...(body.kind === 'brain.preferences' ? { brainPreferences: { agents: false, trusted: false } } : {}),
      ...(body.kind === 'engines.status' ? { engines: { claudeCode: { installed: true, loggedIn: true, path: '/bin/false', version: '1', authMethod: 'subscription' as const }, codex: { installed: true, loggedIn: true, path: '/bin/false', version: '1', authMethod: 'subscription' as const } } } : {}),
    };
  } });
  const tty = new TTY(), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp/proj', terminalProgram: 'unknown' });
  await home.start();
  try {
    tty.emit('data', Buffer.from('goal\r'));
    await shows(tty, 'brain          off');
    await vi.waitFor(() => expect(sent).toContainEqual({ kind: 'brain.preferences', cwd: '/tmp/proj' }));
    tty.emit('data', Buffer.from('b'));
    await shows(tty, 'brain          on');
    await vi.waitFor(() => expect(sent).toContainEqual({ kind: 'brain.configure', cwd: '/tmp/proj', agents: true }));
    tty.emit('data', Buffer.from('\r'));
    await vi.waitFor(() => expect(sent.some(body => body.kind === 'sessions.create' && body.engine !== 'shell' && body.brain === true)).toBe(true));
  } finally { await home.stop(); }
});

it('B30: /brain trust and untrust persist an explicit repository choice', async () => {
  const sent: RequestBody[] = [];
  const client = Object.assign(new EventEmitter(), { async request(body: RequestBody): Promise<SuccessResponse> {
    sent.push(body); return { id: randomUUID(), ok: true, ...(body.kind === 'settings.get' ? { settings: { theme: 'graphite' as const } } : {}), ...(body.kind === 'sessions.list' ? { sessions: [] } : {}), ...(body.kind === 'keys.list' ? { keys: [] } : {}) };
  } });
  const tty = new TTY(), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp/proj', terminalProgram: 'unknown' });
  await home.start();
  try {
    tty.emit('data', Buffer.from('/brain trust\r'));
    await vi.waitFor(() => expect(sent).toContainEqual({ kind: 'brain.configure', cwd: '/tmp/proj', trusted: true }));
    tty.emit('data', Buffer.from('/brain untrust\r'));
    await vi.waitFor(() => expect(sent).toContainEqual({ kind: 'brain.configure', cwd: '/tmp/proj', trusted: false }));
  } finally { await home.stop(); }
});


it('MEDIUM review: cycling to a preset reloads its repository brain choice', async () => {
  const repoB = await mkdtemp(join(tmpdir(), 'ai-brain-preset-')), sent: RequestBody[] = [];
  const client = Object.assign(new EventEmitter(), { async request(body: RequestBody): Promise<SuccessResponse> {
    sent.push(body); return { id: randomUUID(), ok: true,
      ...(body.kind === 'settings.get' ? { settings: { theme: 'graphite' as const, presets: { other: { engine: 'claude-code' as const, model: null, effort: null, auth: { kind: 'account' as const }, cwd: repoB, permission: 'ask' as const, worktree: false } } } } : {}),
      ...(body.kind === 'sessions.list' ? { sessions: [] } : {}), ...(body.kind === 'keys.list' ? { keys: [] } : {}),
      ...(body.kind === 'brain.preferences' ? { brainPreferences: { agents: body.cwd !== repoB, trusted: false } } : {}),
      ...(body.kind === 'engines.status' ? { engines: { claudeCode: { installed: true, loggedIn: true, path: '/bin/false', version: '1', authMethod: 'subscription' as const }, codex: { installed: true, loggedIn: true, path: '/bin/false', version: '1', authMethod: 'subscription' as const } } } : {}),
    };
  } });
  const tty = new TTY(), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', terminalProgram: 'unknown' });
  await home.start();
  try {
    tty.emit('data', Buffer.from('goal\r')); await shows(tty, 'brain          on');
    tty.emit('data', Buffer.from('p'));
    await vi.waitFor(() => expect(sent).toContainEqual({ kind: 'brain.preferences', cwd: repoB }));
    await shows(tty, 'brain          off');
  } finally { await home.stop(); await rm(repoB, { recursive: true, force: true }); }
});
