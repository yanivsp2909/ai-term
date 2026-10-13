import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Homepage } from '../src/client/tui/homepage.js';
import { aiSubcommands } from '../src/client/tui/commands.js';
import { sortSessions } from '../src/client/tui/layout.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SuccessResponse, SessionInfo } from '../src/shared/protocol.js';
class TTY extends EventEmitter { isTTY = true; isRaw = false; columns = 130; rows = 45; output = ''; setRawMode(v: boolean) { this.isRaw = v; } resume() {} pause() {} write(v: string | Buffer) { this.output += v.toString(); return true; } }
const now = new Date().toISOString();
const agent = (title: string, status: SessionInfo['status'] = 'running'): SessionInfo => ({ id: randomUUID(), title, engine: 'codex', model: null, auth: { kind: 'account' }, cwd: '/tmp', permission: 'ask', status, statusDetail: status, statusSince: now, createdAt: now, lastOutputAt: now, exitCode: null, ctxPercent: null, lastActivity: null });
class Client extends EventEmitter {
  requests: RequestBody[] = [];
  constructor(private readonly sessions: SessionInfo[], private readonly refuseClicks = false) { super(); }
  async request(body: RequestBody): Promise<SuccessResponse> {
    this.requests.push(body); const result: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'clicks.subscribe' && this.refuseClicks) throw new Error('Unknown request kind');
    if (body.kind === 'settings.get') result.settings = { theme: 'graphite' };
    if (body.kind === 'sessions.list') result.sessions = this.sessions;
    if (body.kind === 'engines.status') result.engines = { claudeCode: { installed: true, path: '/stub/claude', version: '2.1.295', loggedIn: true, authMethod: 'subscription' }, codex: { installed: true, path: '/stub/codex', version: '0.160.1', loggedIn: true, authMethod: 'subscription' } };
    if (body.kind === 'sessions.preview') { result.snapshot = ''; result.cols = 88; result.rows = 27; }
    return result;
  }
}
async function fixture(sessions: SessionInfo[], options: { attachOnStart?: string; refuseClicks?: boolean } = {}) {
  const tty = new TTY(), client = new Client(sessions, options.refuseClicks), attached: string[] = [];
  const home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', attachSession: async id => { attached.push(id); return 'home key'; }, ...(options.attachOnStart ? { attachOnStart: options.attachOnStart } : {}) });
  await home.start();
  return { tty, client, home, attached };
}

it('the homepage asks the daemon to route notification clicks to it', async () => {
  const { client, home } = await fixture([agent('a')]);
  try { expect(client.requests).toContainEqual({ kind: 'clicks.subscribe', on: true }); } finally { await home.stop(); }
});

it('a click selects that agent; Enter then attaches it, so selecting never attaches by itself', async () => {
  const a = agent('alpha'), b = agent('beta'), { tty, client, home, attached } = await fixture([a, b]);
  // The agent the homepage did not select at start.
  const target = sortSessions([a, b])[1]?.id ?? '';
  try {
    client.emit('event', { kind: 'session.select', sessionId: target });
    await new Promise(r => setTimeout(r, 50));
    expect(attached).toEqual([]);
    tty.emit('data', Buffer.from('\r'));
    await vi.waitFor(() => expect(attached).toEqual([target]));
  } finally { await home.stop(); }
});

it('a click for an agent this homepage does not know, or a malformed event, changes nothing', async () => {
  const a = agent('alpha'), b = agent('beta'), { tty, client, home, attached } = await fixture([a, b]);
  try {
    client.emit('event', { kind: 'session.select', sessionId: randomUUID() });
    client.emit('event', { kind: 'session.select', sessionId: 'AITERMCANARY' });
    tty.emit('data', Buffer.from('\r'));
    await vi.waitFor(() => expect(attached).toEqual([sortSessions([a, b])[0]?.id]));
  } finally { await home.stop(); }
});

it('an older daemon without click routing still opens the homepage', async () => {
  const { home, client } = await fixture([agent('a')], { refuseClicks: true });
  try { expect(client.requests.some(r => r.kind === 'sessions.list')).toBe(true); } finally { await home.stop(); }
});

it('ai --attach <uuid> opens the homepage straight into that agent', async () => {
  const a = agent('alpha'), b = agent('beta'), target = sortSessions([a, b])[1]?.id ?? '', { home, attached } = await fixture([a, b], { attachOnStart: target });
  try { await vi.waitFor(() => expect(attached).toEqual([target])); } finally { await home.stop(); }
});

it('ai --attach for a removed or finished agent stays on the homepage with a note', async () => {
  const gone = randomUUID(), finished = agent('done-agent', 'exited');
  for (const [id, sessions] of [[gone, [agent('a')]], [finished.id, [finished]]] as const) {
    const { tty, home, attached } = await fixture([...sessions], { attachOnStart: id });
    try {
      await new Promise(r => setTimeout(r, 50));
      expect(attached).toEqual([]);
      expect(tty.output).toMatch(/agent is gone|has exited/);
    } finally { await home.stop(); }
  }
});

it('ai --attach is listed and refuses anything but one UUID before connecting', () => {
  expect(aiSubcommands).toContain('ai --attach <id>');
  for (const args of [['--attach'], ['--attach', 'AITERMCANARY'], ['--attach', randomUUID(), 'extra'], ['--attach', '-x']]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', resolve('src/cli/index.ts'), ...args], { encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', AI_TERM_HOME: '/nonexistent-ai-term-home' } });
    expect(result.status).toBe(2); expect(result.stderr).toContain('Usage:'); expect(result.stderr).not.toContain('AITERMCANARY');
  }
});
