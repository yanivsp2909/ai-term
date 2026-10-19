import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import headless from '@xterm/headless';
import { Homepage } from '../src/client/tui/homepage.js';
import { parseAddonResult } from '../src/shared/addon-results.js';
import type { AddonAsk } from '../src/shared/addons.js';
import type { RequestBody } from '../src/client/connection.js';
import type { KeyView, SessionInfo, SuccessResponse } from '../src/shared/protocol.js';
import { batch3 } from './fixtures/addon-results.js';

// Backlog F3 (live-suite Part C suggestion): a /study session's popup, once closed, could not be opened again: /study
// alone is the due list and /study <topic> starts a new paid session. Now the due list offers r for your last session.
class TTY extends EventEmitter { isTTY = true; columns = 130; rows = 45; output = ''; setRawMode() {} resume() {} pause() {} write(s: string | Buffer) { this.output += String(s); return true; } }
async function screen(tty: TTY) { const term = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true }); try { await new Promise<void>(r => term.write(tty.output, r)); return Array.from({ length: 45 }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n'); } finally { term.dispose(); } }
const ask = (over: Partial<AddonAsk>): AddonAsk => ({ receipt: randomUUID(), name: 'study', summary: 'Study', cwd: '/tmp', target: null, brain: 'none', brainNeed: 'none', worktree: false, readOnly: true, files: [], inputTokens: { low: 1, high: 2 }, outputTokens: { low: 1, high: 2 }, priceUsd: { low: 0.01, high: 0.02 }, subscription: false, ...over });

it('/study alone offers r to reopen your last /study session, and r opens it with its result', async () => {
  const now = new Date().toISOString(), studyId = randomUUID(), dueRun = randomUUID(), requests: RequestBody[] = [];
  const key = { id: randomUUID(), provider: 'anthropic', label: 'work', last4: 'abcd', createdAt: now, lastTest: [{ model: 'claude-sonnet-5-5', ok: true, testedAt: now }] } as unknown as KeyView;
  const agent: SessionInfo = { id: studyId, engine: 'claude-code', title: '/study', model: null, auth: { kind: 'account' }, cwd: '/tmp', permission: 'ask', status: 'done', statusDetail: 'done', statusSince: now, createdAt: now, exitCode: null, lastOutputAt: null, ctxPercent: null };
  const client = Object.assign(new EventEmitter(), { async request(body: RequestBody): Promise<SuccessResponse> {
    requests.push(body); const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.get') response.settings = { theme: 'graphite' }; if (body.kind === 'sessions.list') response.sessions = [] as SessionInfo[]; if (body.kind === 'keys.list') response.keys = [key];
    if (body.kind === 'sessions.preview') { response.snapshot = ''; response.cols = 85; response.rows = 30; }
    if (body.kind === 'addons.plan') response.addonAsk = body.name === 'study-due' ? ask({ name: 'study-due', free: true, priceUsd: { low: 0, high: 0 } }) : ask({ target: body.target });
    if (body.kind === 'addons.start') { const plan = requests.filter((r): r is Extract<RequestBody, { kind: 'addons.plan' }> => r.kind === 'addons.plan').at(-1); if (plan?.name === 'study-due') response.addonRun = dueRun; else response.session = agent; }
    if (body.kind === 'addons.result') response.addonResult = body.sessionId === dueRun ? { kind: 'study-due', topics: [] } : parseAddonResult(JSON.stringify(batch3.study), 'study', true);
    return response;
  } });
  const tty = new TTY(), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', terminalProgram: 'unknown' }); await home.start();
  try {
    tty.emit('data', Buffer.from('/study git worktrees\r'));
    await vi.waitFor(async () => expect(await screen(tty)).toContain('y starts'), { timeout: 10_000 });
    tty.emit('data', Buffer.from('y'));
    await vi.waitFor(async () => expect(await screen(tty)).toContain('Check: two agents edit a.ts'), { timeout: 10_000 });
    tty.emit('data', Buffer.from('\x1b')); await vi.waitFor(async () => expect(await screen(tty)).not.toContain('Check: two agents edit a.ts'), { timeout: 10_000 });
    tty.emit('data', Buffer.from('/study\r'));
    await vi.waitFor(async () => expect(await screen(tty)).toContain('r reopens your last session: git worktrees'), { timeout: 10_000 });
    tty.emit('data', Buffer.from('r'));
    await vi.waitFor(async () => expect(await screen(tty)).toContain('Check: two agents edit a.ts'), { timeout: 10_000 });
    // Reopening costs nothing: no second session was started.
    expect(requests.filter(r => r.kind === 'addons.start')).toHaveLength(2);
    expect(requests.filter(r => r.kind === 'addons.plan' && r.name === 'study')).toHaveLength(1);
  } finally { await home.stop(); }
}, 30_000);
