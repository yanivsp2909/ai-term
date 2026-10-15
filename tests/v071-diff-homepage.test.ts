import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import headless from '@xterm/headless';
import { Homepage } from '../src/client/tui/homepage.js';
import { DaemonRequestError, type RequestBody } from '../src/client/connection.js';
import type { SessionInfo, SuccessResponse } from '../src/shared/protocol.js';
import type { AgentDiff } from '../src/shared/diff.js';

// v0.7.1 on the homepage: d on a card or /diff [agent] opens the diff popup; x discards through the v0.3.2 removal flow,
// m merges (v0.7.3), Esc keeps it for later. Keys in the popup never reach an agent (D22).
const now = new Date().toISOString();
const agent = (title: string, status: SessionInfo['status']): SessionInfo => ({ id: randomUUID(), title, engine: 'codex', model: 'gpt', auth: { kind: 'account' }, cwd: '/tmp', worktree: `/tmp/trees/${title}`, branch: `ai/${title}`, permission: 'ask', status, statusDetail: status, statusSince: now, createdAt: now, lastOutputAt: now, exitCode: status === 'exited' ? 0 : null, ctxPercent: null, lastActivity: null });
const diffOf = (title: string): AgentDiff => ({ title, branch: `ai/${title}`, base: 'main @ abc1234', added: 1, removed: 0, capped: false, files: [{ path: 'notes.md', status: 'untracked', added: 1, removed: 0, lines: ['+hello'] }] });
class TTY extends EventEmitter { isTTY = true; isRaw = false; columns = 130; rows = 45; output = ''; setRawMode(v: boolean) { this.isRaw = v; } resume() {} pause() {} write(data: string | Buffer) { this.output += data.toString(); return true; } }
async function screen(tty: TTY): Promise<string> { const terminal = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true }); try { await new Promise<void>(resolve => terminal.write(tty.output, resolve)); return Array.from({ length: 45 }, (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n'); } finally { terminal.dispose(); } }
const shows = (tty: TTY, text: string) => vi.waitFor(async () => expect(await screen(tty)).toContain(text));
class Client extends EventEmitter {
  requests: RequestBody[] = []; diffError?: string;
  constructor(public sessions: SessionInfo[]) { super(); }
  async request(body: RequestBody): Promise<SuccessResponse> {
    this.requests.push(body); const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.get') response.settings = { theme: 'graphite' };
    if (body.kind === 'sessions.list') response.sessions = this.sessions;
    if (body.kind === 'sessions.preview') { response.snapshot = ''; response.cols = 85; response.rows = 30; }
    if (body.kind === 'sessions.diff') { if (this.diffError) throw new DaemonRequestError(this.diffError); response.diff = diffOf(this.sessions.find(s => s.id === body.sessionId)?.title ?? '?'); }
    if (body.kind === 'sessions.remove') { this.emit('event', { kind: 'session.removed', sessionId: body.sessionId }); }
    return response;
  }
}
async function open(client: Client) { const tty = new TTY(), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', terminalProgram: 'unknown' }); await home.start(); return { tty, home }; }
const type = (tty: TTY, text: string) => { for (const char of text) tty.emit('data', Buffer.from(char)); };
const escape = async (tty: TTY) => { tty.emit('data', Buffer.from('\x1b')); await new Promise(resolve => setTimeout(resolve, 60)); };

it('d on the selected card opens its diff; Esc keeps it for later', async () => {
  const fixer = agent('fixer', 'done'), client = new Client([fixer]), { tty, home } = await open(client);
  try {
    type(tty, 'd');
    await vi.waitFor(() => expect(client.requests).toContainEqual({ kind: 'sessions.diff', sessionId: fixer.id }));
    await shows(tty, 'Diff fixer · ai/fixer vs main @ abc1234'); await shows(tty, '+hello');
    await escape(tty);
    await vi.waitFor(async () => expect(await screen(tty)).not.toContain('Diff fixer'));
    expect(client.requests.some(r => r.kind === 'sessions.remove' || r.kind === 'sessions.send')).toBe(false);
  } finally { await home.stop(); }
});

it('/diff <agent> opens that agent\'s diff; a name two agents share or none has is refused', async () => {
  const a = agent('fixer', 'done'), b = agent('writer', 'exited'), c = agent('twin', 'done'), d = agent('twin', 'done'), client = new Client([a, b, c, d]), { tty, home } = await open(client);
  try {
    type(tty, '/diff writer\r');
    await vi.waitFor(() => expect(client.requests).toContainEqual({ kind: 'sessions.diff', sessionId: b.id }));
    await shows(tty, 'Diff writer'); await escape(tty);
    await vi.waitFor(async () => expect(await screen(tty)).not.toContain('Diff writer'));
    type(tty, '/diff twin\r'); await shows(tty, '2 agents are named twin · rename one with r');
    type(tty, '/diff ghost\r'); await shows(tty, 'no agent named ghost');
  } finally { await home.stop(); }
});

it('x in the diff of an exited agent discards it through the removal flow; a live one must be stopped first', async () => {
  const live = agent('fixer', 'done'), ended = agent('writer', 'exited'), client = new Client([live, ended]), { tty, home } = await open(client);
  try {
    type(tty, `/diff fixer\r`); await shows(tty, 'Diff fixer'); type(tty, 'x');
    await shows(tty, 'stop fixer first (s), then x in its diff');
    expect(client.requests.some(r => r.kind === 'sessions.remove')).toBe(false);
    type(tty, `/diff writer\r`); await shows(tty, 'Diff writer'); type(tty, 'x');
    await vi.waitFor(() => expect(client.requests).toContainEqual({ kind: 'sessions.remove', sessionId: ended.id }));
  } finally { await home.stop(); }
});

it('a diff the daemon refuses shows its reason as a note', async () => {
  const fixer = agent('fixer', 'done'), client = new Client([fixer]); client.diffError = 'This agent has no worktree to diff';
  const { tty, home } = await open(client);
  try { type(tty, 'd'); await shows(tty, 'This agent has no worktree to diff'); } finally { await home.stop(); }
});

it('with no agent selected, d types a d (a task like "deploy" keeps its first letter)', async () => {
  const client = new Client([]), { tty, home } = await open(client);
  try { type(tty, 'deploy it'); await shows(tty, 'deploy it'); expect(client.requests.some(r => r.kind === 'sessions.diff')).toBe(false); } finally { await home.stop(); }
});
