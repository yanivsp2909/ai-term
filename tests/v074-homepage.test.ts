import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import headless from '@xterm/headless';
import { Homepage } from '../src/client/tui/homepage.js';
import type { RequestBody } from '../src/client/connection.js';
import { cardText } from '../src/client/tui/agent-card.js';
import type { SessionInfo, SuccessResponse } from '../src/shared/protocol.js';

// v0.7.4 on the homepage: /test-cmd sets the project's test command; /test runs it after showing what runs (and which
// test setup files the agent changed); cards say `✓ tests pass` or `✗ N failing`.
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

it('cards say what the tests said, next to the change count', () => {
  const card = (tests: SessionInfo['tests']) => cardText({ ...fixer, ...(tests ? { tests } : {}) }, Date.now(), 80).activity?.text;
  expect(card(undefined)).toBe('+3 −1 · ready to review');
  expect(card({ state: 'running' })).toBe('+3 −1 · ◐ testing');
  expect(card({ state: 'pass' })).toBe('+3 −1 · ✓ tests pass');
  expect(card({ state: 'fail', failing: 2 })).toBe('+3 −1 · ✗ 2 failing');
  expect(card({ state: 'fail', failing: 1 })).toBe('+3 −1 · ✗ 1 failing');
  expect(card({ state: 'fail', failing: null })).toBe('+3 −1 · ✗ tests fail');
  expect(card({ state: 'timeout' })).toBe('+3 −1 · ✗ tests timed out');
  expect(card({ state: 'error' })).toBe("+3 −1 · ✗ tests couldn't start");
  expect(card({ state: 'ask', changed: ['package.json', 'Makefile'] })).toBe('+3 −1 · ? test setup changed · /test');
  expect(cardText({ ...fixer, tests: { state: 'fail', failing: 2 } }, Date.now(), 80).activity?.color).toBe('status-error');
});

it('/test-cmd shows and sets the command of the selected agent\'s project; none clears it', async () => {
  let command: string[] | null = null;
  const h = await open(body => body.kind === 'project.testCommand' ? { testCommand: { repo: '/tmp/repo', command } } : body.kind === 'project.setTestCommand' ? (command = body.command, { testCommand: { repo: '/tmp/repo', command } }) : {});
  try {
    h.type('/test-cmd\r'); await shows(h.tty, 'no test command for /tmp/repo · /test-cmd <command>');
    h.type('/test-cmd npm run test -- --reporter=dot\r');
    await vi.waitFor(() => expect(h.requests).toContainEqual({ kind: 'project.setTestCommand', cwd: '/tmp/trees/fixer', command: ['npm', 'run', 'test', '--', '--reporter=dot'] }));
    await shows(h.tty, '✓ test command for /tmp/repo: npm run test -- --reporter=dot · runs when an agent finishes');
    h.type('/test-cmd none\r'); await vi.waitFor(() => expect(h.requests).toContainEqual({ kind: 'project.setTestCommand', cwd: '/tmp/trees/fixer', command: null }));
    h.type('/test-cmd "unclosed\r'); await shows(h.tty, '/test-cmd <command> · none clears it; no shell: pipes and && are plain words');
  } finally { await h.home.stop(); }
});

it('/test shows the command, the folder and the changed setup files; y runs exactly that plan', async () => {
  const plan = { title: 'fixer', command: ['./check.sh'], cwd: '/tmp/trees/fixer', changed: ['package.json'], fingerprint: fp };
  const h = await open(body => body.kind === 'sessions.testPlan' ? { testPlan: plan } : {});
  try {
    h.type('/test fixer\r');
    await shows(h.tty, 'Run tests for fixer'); await shows(h.tty, '$ ./check.sh'); await shows(h.tty, 'package.json');
    await shows(h.tty, 'changed by this agent: running the tests runs them');
    h.type('y');
    await vi.waitFor(() => expect(h.requests).toContainEqual({ kind: 'sessions.test', sessionId: fixer.id, fingerprint: fp }));
    await shows(h.tty, '◐ testing fixer');
  } finally { await h.home.stop(); }
});
