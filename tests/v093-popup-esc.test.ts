import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import headless from '@xterm/headless';
import { Homepage } from '../src/client/tui/homepage.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SessionInfo, SuccessResponse } from '../src/shared/protocol.js';

// v0.9.3 consistency polish: every popup a command opens closes on Esc and gives the homepage back as it was.
const now = new Date().toISOString();
const fixer = { id: randomUUID(), title: 'fixer', engine: 'codex', model: 'gpt', auth: { kind: 'account' }, cwd: '/tmp/trees/fixer', worktree: '/tmp/trees/fixer', branch: 'ai/fixer', permission: 'ask', status: 'done', statusDetail: 'done', statusSince: now, createdAt: now, lastOutputAt: now, exitCode: 0, ctxPercent: null, lastActivity: null } as unknown as SessionInfo;
class TTY extends EventEmitter { isTTY = true; isRaw = false; columns = 130; rows = 45; output = ''; setRawMode(v: boolean) { this.isRaw = v; } resume() {} pause() {} write(data: string | Buffer) { this.output += data.toString(); return true; } }
async function screen(tty: TTY): Promise<string[]> { const terminal = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true }); try { await new Promise<void>(resolve => terminal.write(tty.output, resolve)); return Array.from({ length: 45 }, (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? ''); } finally { terminal.dispose(); } }
const settle = () => new Promise(resolve => setTimeout(resolve, 150));
// Every command that opens a popup (the others answer in the note line).
const COMMANDS = ['/help', '/settings', '/usage', '/budget', '/doctor', '/worktrees', '/skills', '/agents', '/queue', '/model', '/login', '/diff', '/find fixer', '/review', '/test', '/undo', '/dev', '/brain'];
const fp = 'a'.repeat(64), keyId = randomUUID();
const PLANS: Partial<Record<RequestBody['kind'], Partial<SuccessResponse>>> = {
  'sessions.diff': { diff: { title: 'fixer', branch: 'ai/fixer', base: 'main @ abc1234', added: 1, removed: 0, capped: false, files: [{ path: 'notes.md', status: 'untracked', added: 1, removed: 0, lines: ['+hello'] }] } },
  'sessions.testPlan': { testPlan: { title: 'fixer', command: ['./check.sh'], cwd: '/tmp/trees/fixer', changed: [], fingerprint: fp, sandbox: true, loopback: false } },
  'sessions.reviewPlan': { reviewPlan: { title: 'fixer', files: 2, added: 3, removed: 1, cut: false, inputTokens: { low: 8000, high: 12000 }, outputTokens: { low: 200, high: 3000 }, selected: 0, fingerprint: fp, models: [{ keyId, provider: 'openai', keyLabel: 'o', last4: 'oooo', model: 'gpt-6.1-mini', priceUsd: { low: 0.002, high: 0.0048 } }] } },
  'sessions.undoPlan': { undoPlan: { kind: 'undo', title: 'fixer', target: 1, targetAt: now, changes: [{ path: 'a.ts', change: 'modified' }], more: 0, fingerprint: fp } },
  'brain.plan': { brainPlan: { repo: '/tmp/proj', files: 3, changed: 3, removed: 0, skipped: { binary: 0, large: 0, env: 0, secret: 0 }, builtAt: null, summarize: 0, inputTokens: { low: 0, high: 0 }, outputTokens: { low: 0, high: 0 }, models: [], selected: 0, fingerprint: fp, agents: true } },
  'sessions.devPlan': { devPlan: { title: 'fixer', command: ['npm', 'run', 'dev'], cwd: '/tmp/trees/fixer', port: 4101, sandbox: true, fingerprint: fp, running: false, tail: [] } },
} as never;
it.each(COMMANDS)('%s: Esc closes its popup and the homepage is back as it was', async command => {
  const client = Object.assign(new EventEmitter(), { async request(body: RequestBody): Promise<SuccessResponse> {
    const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.get') response.settings = { theme: 'graphite', queue: true, devServers: true };
    if (body.kind === 'sessions.list') response.sessions = [fixer];
    if (body.kind === 'sessions.preview') { response.snapshot = ''; response.cols = 85; response.rows = 30; }
    return { ...response, ...PLANS[body.kind] };
  } });
  const tty = new TTY(), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', terminalProgram: 'unknown' });
  await home.start(); await settle();
  const type = (text: string) => { for (const char of text) tty.emit('data', Buffer.from(char)); };
  const before = (await screen(tty)).slice(0, 38);
  type(command + '\r'); await settle();
  let open: string[] = [];
  await expect.poll(async () => { open = (await screen(tty)).slice(0, 38); return open; }, { message: `${command} opened nothing` }).not.toEqual(before);
  if (process.env.DUMP_POPUPS) process.stdout.write(`\n=== ${command}\n` + open.filter(line => line.trim()).join('\n') + '\n');
  // Esc goes through two 30 ms timers (terminal-reply hold, then the lone-escape timer) before the popup closes.
  type('\x1b'); await expect.poll(async () => (await screen(tty)).slice(0, 38), { timeout: 10_000 }).toEqual(before);
  home.stop?.();
});
