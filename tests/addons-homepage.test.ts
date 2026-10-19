import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import headless from '@xterm/headless';
import { Homepage } from '../src/client/tui/homepage.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SessionInfo, SuccessResponse } from '../src/shared/protocol.js';
class TTY extends EventEmitter { isTTY = true; columns = 130; rows = 45; output = ''; setRawMode() {} resume() {} pause() {} write(s: string | Buffer) { this.output += String(s); return true; } }
async function screen(tty: TTY) { const term = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true }); try { await new Promise<void>(r => term.write(tty.output, r)); return Array.from({ length: 45 }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n'); } finally { term.dispose(); } }
it('typed /plan opens one D49 popup; Enter never starts; y runs; a saves; s starts only the selected step', async () => {
  const requests: RequestBody[] = [], id = randomUUID();
  const session: SessionInfo = { id, title: '/plan', engine: 'claude-code', model: null, auth: { kind: 'account' }, cwd: '/tmp', permission: 'ask', status: 'done', statusDetail: 'ready', statusSince: new Date().toISOString(), exitCode: null, createdAt: new Date().toISOString(), lastOutputAt: null, ctxPercent: null, lastActivity: null };
  const client = Object.assign(new EventEmitter(), { async request(body: RequestBody): Promise<SuccessResponse> {
    requests.push(body); const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.get') response.settings = { theme: 'graphite' }; if (body.kind === 'sessions.list') response.sessions = []; if (body.kind === 'keys.list') response.keys = [];
    if (body.kind === 'sessions.preview') { response.snapshot = ''; response.cols = 85; response.rows = 30; }
    if (body.kind === 'addons.plan') response.addonAsk = { receipt: randomUUID(), name: 'plan', summary: 'Inspect the code and propose a step plan for approval', cwd: '/tmp', target: body.target, brain: 'none', brainNeed: 'recommended', worktree: false, readOnly: true, files: ['guides/plan.md'], inputTokens: { low: 2000, high: 500000 }, outputTokens: { low: 500, high: 12000 }, priceUsd: { low: 0, high: 0 }, subscription: true };
    if (body.kind === 'addons.start' || body.kind === 'addons.step') response.session = session;
    if (body.kind === 'addons.result') response.addonResult = { kind: 'plan', title: 'Build one thing', steps: [{ title: 'Write a test', prompt: 'Inspect src/a.ts; write a test and stop.' }] };
    if (body.kind === 'addons.approve') response.savedPlan = '/tmp/home/plans/repo/plan.json';
    return response;
  } });
  const tty = new TTY(), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', terminalProgram: 'unknown' }); await home.start();
  try {
    tty.emit('data', Buffer.from('/plan build one thing\r'));
    await vi.waitFor(async () => expect(await screen(tty)).toContain('y starts'));
    tty.emit('data', Buffer.from('\r')); await new Promise(r => setTimeout(r, 20)); expect(requests.some(r => r.kind === 'addons.start')).toBe(false);
    tty.emit('data', Buffer.from('y')); await vi.waitFor(async () => expect(await screen(tty)).toContain('a approves and saves'));
    tty.emit('data', Buffer.from('s')); expect(requests.some(r => r.kind === 'addons.step')).toBe(false);
    tty.emit('data', Buffer.from('a')); await vi.waitFor(async () => expect(await screen(tty)).toContain('✓ plan saved'));
    expect(requests.some(r => r.kind === 'addons.step')).toBe(false); tty.emit('data', Buffer.from('s'));
    await vi.waitFor(() => expect(requests).toContainEqual({ kind: 'addons.step', sessionId: id, step: 0 }));
  } finally { await home.stop(); }
});
