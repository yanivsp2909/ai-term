import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import headless from '@xterm/headless';
import { Homepage } from '../src/client/tui/homepage.js';
import { parseAccountCommand } from '../src/client/tui/accounts.js';
import type { SessionInfo, Settings, SuccessResponse } from '../src/shared/protocol.js';
import type { RequestBody } from '../src/client/connection.js';

// v0.6.4 client: /account, the start box's account choice, the limit note, and /handoff onto another account.
class TTY extends EventEmitter { isTTY = true; isRaw = false; columns = 130; rows = 45; output = ''; setRawMode(v: boolean) { this.isRaw = v; } resume() {} pause() {} write(data: string | Buffer) { this.output += data.toString(); return true; } }
async function screen(tty: TTY): Promise<string> { const terminal = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true }); try { await new Promise<void>(resolve => terminal.write(tty.output, resolve)); return Array.from({ length: 45 }, (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n'); } finally { terminal.dispose(); } }
const shows = (tty: TTY, text: string) => vi.waitFor(async () => expect(await screen(tty)).toContain(text));
const type = (tty: TTY, text: string) => { for (const char of text) tty.emit('data', Buffer.from(char)); };
const enter = (tty: TTY) => tty.emit('data', Buffer.from('\r'));
const now = new Date().toISOString();
const agent = (over: Partial<SessionInfo> = {}): SessionInfo => ({ id: randomUUID(), title: 'fixer', engine: 'claude-code', model: null, auth: { kind: 'account' }, authMethod: 'subscription', cwd: '/tmp', permission: 'ask', status: 'done', statusDetail: 'done', statusSince: now, exitCode: null, createdAt: now, lastOutputAt: null, ctxPercent: null, lastActivity: null, ...over });
class Client extends EventEmitter {
  requests: RequestBody[] = []; settings: Settings = { theme: 'graphite' }; sessions: SessionInfo[] = [];
  async request(body: RequestBody): Promise<SuccessResponse> {
    this.requests.push(body); const r: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.set') this.settings = { ...this.settings, ...body.patch };
    if (body.kind === 'settings.get' || body.kind === 'settings.set') r.settings = this.settings;
    if (body.kind === 'sessions.list') r.sessions = this.sessions;
    if (body.kind === 'keys.list') r.keys = [];
    if (body.kind === 'sessions.preview') { r.snapshot = 'x'; r.cols = 85; r.rows = 30; }
    if (body.kind === 'engines.status') r.engines = { claudeCode: { installed: true, path: '/c', version: '1', loggedIn: true, authMethod: 'subscription' }, codex: { installed: true, path: '/x', version: '1', loggedIn: true, authMethod: 'subscription' } };
    if (body.kind === 'sessions.create') r.session = agent({ title: body.title ?? 'new', status: 'starting', ...('auth' in body ? { auth: body.auth } : {}) } as Partial<SessionInfo>);
    return r;
  }
}
async function open(client: Client) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'ai-accounts-client-'))), tty = new TTY();
  const home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd, terminalProgram: 'unknown' });
  await home.start();
  return { tty, home, cwd, done: async () => { await home.stop(); await rm(cwd, { recursive: true, force: true }); } };
}

it('/account parses add, default, rm, use and list', () => {
  expect(parseAccountCommand('/account')).toEqual({ kind: 'list' });
  expect(parseAccountCommand('/account add claude work')).toEqual({ kind: 'add', engine: 'claude-code', name: 'work' });
  expect(parseAccountCommand('/account add codex side')).toEqual({ kind: 'add', engine: 'codex', name: 'side' });
  expect(parseAccountCommand('/account default work')).toEqual({ kind: 'default', name: 'work' });
  expect(parseAccountCommand('/account rm work')).toEqual({ kind: 'rm', name: 'work' });
  expect(parseAccountCommand('/account use own')).toEqual({ kind: 'use', name: 'own' });
  for (const bad of ['/account add claude own', '/account add gpt x', '/account add claude Bad', '/account rm', '/account frob']) expect(parseAccountCommand(bad)).toMatchObject({ kind: 'error' });
});

it('/account add saves the profile and opens the CLI\'s own login for it; default and rm are notes; nothing reads a token', async () => {
  const client = new Client(), h = await open(client);
  try {
    type(h.tty, '/account add claude work'); enter(h.tty);
    await vi.waitFor(() => expect(client.requests.find(r => r.kind === 'sessions.create')).toMatchObject({ engine: 'claude-code', login: true, auth: { kind: 'account', profile: 'work' } }));
    expect(client.settings.accounts).toEqual([{ name: 'work', engine: 'claude-code' }]);
    type(h.tty, '\x05'); // leave the login session (home key)
    type(h.tty, '/account default work'); enter(h.tty);
    await vi.waitFor(() => expect(client.settings.defaultAccounts).toEqual({ 'claude-code': 'work' }));
    type(h.tty, '/account rm work'); enter(h.tty);
    await shows(h.tty, "✓ account work removed · its folder stays");
    expect(client.settings.accounts).toEqual([]); expect(client.settings.defaultAccounts).toEqual({});
  } finally { await h.done(); }
});

it('the start box a key steps through own login and the engine\'s accounts for this one agent', async () => {
  const client = new Client(); client.settings = { theme: 'graphite', accounts: [{ name: 'work', engine: 'claude-code' }, { name: 'side', engine: 'codex' }] };
  const h = await open(client);
  try {
    type(h.tty, 'a task'); enter(h.tty); await shows(h.tty, 'Start a new agent');
    type(h.tty, 'a'); await shows(h.tty, 'account        work · a');
    type(h.tty, 'a'); await shows(h.tty, 'account        own login · a');
    type(h.tty, 'a'); enter(h.tty);
    await vi.waitFor(() => expect(client.requests.find(r => r.kind === 'sessions.create')).toMatchObject({ auth: { kind: 'account', profile: 'work' } }));
  } finally { await h.done(); }
});

it('when an agent hits its limit the homepage says so once and offers the choice; it never switches by itself', async () => {
  const client = new Client(), fixer = agent(); client.sessions = [fixer]; client.settings = { theme: 'graphite', accounts: [{ name: 'work', engine: 'claude-code' }] };
  const h = await open(client);
  try {
    client.emit('event', { kind: 'session.updated', session: { ...fixer, limit: { resets: '15:00' } } });
    await shows(h.tty, 'fixer hit its limit · resets 15:00 · wait, or /handoff fixer claude:work');
    await shows(h.tty, '⏸ limit · resets 15:00');
    expect(client.requests.some(r => r.kind === 'sessions.handoff' || r.kind === 'sessions.create')).toBe(false);
  } finally { await h.done(); }
});
