import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import headless from '@xterm/headless';
import { Homepage } from '../src/client/tui/homepage.js';
import type { RequestBody } from '../src/client/connection.js';
import { cardText } from '../src/client/tui/agent-card.js';
import type { SessionInfo, SuccessResponse } from '../src/shared/protocol.js';

// v0.9.1 /queue on the homepage, typed as you would: /queue add opens the start box as "Queue a new agent", its ⏎ asks when
// it starts and its limit, then queue.add goes to the daemon; /queue lists, x removes.
const now = new Date().toISOString();
const fixer: SessionInfo = { id: randomUUID(), title: 'fixer', engine: 'codex', model: 'gpt', auth: { kind: 'account' }, cwd: '/tmp/trees/fixer', worktree: '/tmp/trees/fixer', branch: 'ai/fixer', permission: 'ask', status: 'done', statusDetail: 'done', statusSince: now, createdAt: now, lastOutputAt: now, exitCode: 0, ctxPercent: null, lastActivity: null, diffStat: { added: 3, removed: 1, files: 2 } };
const fp = 'c'.repeat(64);
class TTY extends EventEmitter { isTTY = true; isRaw = false; columns = 130; rows = 45; output = ''; setRawMode(v: boolean) { this.isRaw = v; } resume() {} pause() {} write(data: string | Buffer) { this.output += data.toString(); return true; } }
async function screen(tty: TTY): Promise<string> { const terminal = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true }); try { await new Promise<void>(resolve => terminal.write(tty.output, resolve)); return Array.from({ length: 45 }, (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n'); } finally { terminal.dispose(); } }
const shows = (tty: TTY, text: string) => vi.waitFor(async () => expect(await screen(tty)).toContain(text));
async function open(answer: (body: RequestBody) => Partial<SuccessResponse> | Error, sessions: SessionInfo[] = [fixer]) {
  const requests: RequestBody[] = [];
  const client = Object.assign(new EventEmitter(), { async request(body: RequestBody): Promise<SuccessResponse> {
    requests.push(body); const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.get') response.settings = { theme: 'graphite' };
    if (body.kind === 'sessions.list') response.sessions = sessions;
    if (body.kind === 'sessions.preview') { response.snapshot = ''; response.cols = 85; response.rows = 30; }
    const extra = answer(body); if (extra instanceof Error) throw extra;
    return { ...response, ...extra };
  } });
  const tty = new TTY(), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', terminalProgram: 'unknown' });
  await home.start();
  return { tty, home, requests, type: (text: string) => { for (const char of text) tty.emit('data', Buffer.from(char)); } };
}


it('typed: /queue add → the start box queues instead of starting → after fixer → until 23:00 → queue.add with the start box\'s request', async () => {
  const queued: unknown[] = [];
  const { tty, requests, type } = await open(body => {
    if (body.kind === 'settings.get') return { settings: { theme: 'graphite', queue: true } };
    if (body.kind === 'engines.status') return { engines: { claudeCode: { installed: true, path: '/bin/claude', version: '1.0.0', loggedIn: true, authMethod: 'subscription' }, codex: { installed: true, path: '/bin/codex', version: '1.0.0', loggedIn: true, authMethod: 'subscription' } }, agentSandbox: { dontAsk: true } };
    if (body.kind === 'queue.add') { queued.push(body); return { queue: [] }; }
    return {};
  });
  type('/queue add\r');
  await shows(tty, 'Queue a new agent');
  await shows(tty, '⏎ asks when it starts and its limit');
  type('\r');
  await shows(tty, 'When does it start? after <agent>');
  type('soon\r');
  await shows(tty, '✗ type after <agent> or at HH:MM');
  for (let i = 0; i < 4; i++) tty.emit('data', Buffer.from([0x7f]));
  type('after fixer\r');
  await shows(tty, 'Its limit: a stop time, like until 23:00');
  type('until 23:00\r');
  await shows(tty, '✓ queued · /queue lists it');
  expect(queued).toEqual([expect.objectContaining({ kind: 'queue.add', trigger: { kind: 'after', agent: 'fixer' }, limit: { until: '23:00' }, request: expect.objectContaining({ engine: expect.any(String), permission: 'ask', cwd: '/tmp' }) })]);
  expect(requests.some(body => body.kind === 'sessions.create')).toBe(false);
});

it('typed: /queue lists the items, x removes the chosen one; with the queue off /queue add says how to turn it on', async () => {
  const item = { id: randomUUID(), createdAt: now, trigger: { kind: 'at' as const, time: '21:30' }, limit: { until: '23:00' }, request: { engine: 'codex' as const, model: null, auth: { kind: 'account' as const }, cwd: '/tmp/proj', permission: 'dontAsk' as const, effort: null }, state: 'waiting' as const };
  let on = true; const removed: string[] = [];
  const { tty, type } = await open(body => {
    if (body.kind === 'settings.get') return { settings: { theme: 'graphite', queue: on } };
    if (body.kind === 'queue.list') return { queue: [item] };
    if (body.kind === 'queue.remove') { removed.push(body.itemId); return { queue: [] }; }
    return {};
  });
  type('/queue\r');
  await shows(tty, "› at 21:30 · stops at 23:00 · Codex · /tmp/proj · ! don't ask · waiting");
  type('x');
  await vi.waitFor(() => expect(removed).toEqual([item.id]));
  await shows(tty, '✓ removed from the queue');
  await vi.waitFor(async () => expect(await screen(tty)).toContain('nothing queued'));
  tty.emit('data', Buffer.from([0x1b]));
  await vi.waitFor(async () => expect(await screen(tty)).not.toContain('╭─ Queue'));
  on = false;
  type('/queue add\r');
  await shows(tty, 'the queue is off · turn it on in /settings (b)');
});
