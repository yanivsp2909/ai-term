import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import headless from '@xterm/headless';
import { Homepage } from '../src/client/tui/homepage.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SessionInfo, SuccessResponse } from '../src/shared/protocol.js';

// v0.9.2 /dev on the homepage, typed as you would: the plan first, y starts exactly it, the card shows ▶ dev :port, /dev on
// a running one shows its last lines and x stops it.
const now = new Date().toISOString();
const fixer: SessionInfo = { id: randomUUID(), title: 'fixer', engine: 'codex', model: 'gpt', auth: { kind: 'account' }, cwd: '/tmp/trees/fixer', worktree: '/tmp/trees/fixer', branch: 'ai/fixer', permission: 'ask', status: 'done', statusDetail: 'done', statusSince: now, createdAt: now, lastOutputAt: now, exitCode: 0, ctxPercent: null, lastActivity: null, diffStat: { added: 3, removed: 1, files: 2 } };
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



it('typed: /dev-cmd sets the command; /dev shows the plan, y starts it, the card shows the port; /dev again shows its lines, x stops', async () => {
  const plan = { title: 'fixer', command: ['npm', 'run', 'dev'], cwd: '/tmp/trees/fixer', port: 4101, sandbox: true, fingerprint: 'd'.repeat(64), running: false, tail: [] as string[] };
  let running = false; const sent: RequestBody[] = [];
  const { tty, type, home } = await open(body => {
    sent.push(body);
    if (body.kind === 'project.setDevCommand') return { devCommand: { repo: '/tmp/repo', command: body.command } };
    if (body.kind === 'sessions.devPlan') return { devPlan: { ...plan, running, tail: running ? ['ready on 4101'] : [] } };
    if (body.kind === 'sessions.dev') { running = true; return {}; }
    if (body.kind === 'sessions.devStop') { running = false; return {}; }
    return {};
  });
  type('/dev-cmd npm run dev\r');
  await shows(tty, '✓ dev command for /tmp/repo: npm run dev · /dev starts it');
  type('/dev\r');
  await shows(tty, 'in /tmp/trees/fixer · http://127.0.0.1:4101 · PORT=4101');
  await shows(tty, 'sandbox: listens on 127.0.0.1 only');
  type('y');
  await vi.waitFor(() => expect(sent).toContainEqual({ kind: 'sessions.dev', sessionId: fixer.id, fingerprint: plan.fingerprint }));
  await shows(tty, '▶ dev server for fixer · http://127.0.0.1:4101');
  (home as unknown as EventEmitter).emit?.('noop');
  type('/dev\r');
  await shows(tty, '▶ running · http://127.0.0.1:4101');
  await shows(tty, 'ready on 4101');
  type('x');
  await vi.waitFor(() => expect(sent.some(body => body.kind === 'sessions.devStop')).toBe(true));
  await shows(tty, 'dev server for fixer stopped');
});
