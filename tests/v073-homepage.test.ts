import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import headless from '@xterm/headless';
import { Homepage } from '../src/client/tui/homepage.js';
import { DaemonRequestError, type RequestBody } from '../src/client/connection.js';
import type { SessionInfo, SuccessResponse } from '../src/shared/protocol.js';
import type { MergePlan, PrPlan } from '../src/shared/merge.js';

// v0.7.3 on the homepage: /merge and /pr (and m in the diff popup) show the exact commands and the secret scan first;
// y runs them, or, with hits, only a typed `override` then ⏎ does. A conflict offers an agent to rebase the branch.
const now = new Date().toISOString();
const fixer: SessionInfo = { id: randomUUID(), title: 'fixer', engine: 'codex', model: 'gpt', auth: { kind: 'account' }, cwd: '/tmp', worktree: '/tmp/trees/fixer', branch: 'ai/fixer', permission: 'ask', status: 'done', statusDetail: 'done', statusSince: now, createdAt: now, lastOutputAt: now, exitCode: null, ctxPercent: null, lastActivity: null };
const fp = 'a'.repeat(64);
const mergePlan = (hits = 0): MergePlan => ({ title: 'fixer', branch: 'ai/fixer', base: 'main', repo: '/tmp/repo', ahead: 2, commands: ['cd /tmp/repo', 'git merge --no-ff --no-edit --no-gpg-sign -- ai/fixer'], hits: Array.from({ length: hits }, (_, i) => ({ file: 'config.ts', line: i + 1, kind: 'API key (sk-)', length: 48 })), moreHits: 0, fingerprint: fp });
class TTY extends EventEmitter { isTTY = true; isRaw = false; columns = 130; rows = 45; output = ''; setRawMode(v: boolean) { this.isRaw = v; } resume() {} pause() {} write(data: string | Buffer) { this.output += data.toString(); return true; } }
async function screen(tty: TTY): Promise<string> { const terminal = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true }); try { await new Promise<void>(resolve => terminal.write(tty.output, resolve)); return Array.from({ length: 45 }, (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n'); } finally { terminal.dispose(); } }
const shows = (tty: TTY, text: string) => vi.waitFor(async () => expect(await screen(tty)).toContain(text));
async function open(answer: (body: RequestBody) => Partial<SuccessResponse> | Error) {
  const requests: RequestBody[] = [];
  const client = Object.assign(new EventEmitter(), { async request(body: RequestBody): Promise<SuccessResponse> {
    requests.push(body); const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.get') response.settings = { theme: 'graphite' };
    if (body.kind === 'sessions.list') response.sessions = [fixer];
    if (body.kind === 'sessions.preview') { response.snapshot = ''; response.cols = 85; response.rows = 30; }
    const extra = answer(body); if (extra instanceof Error) throw extra;
    return { ...response, ...extra };
  } });
  const tty = new TTY(), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', terminalProgram: 'unknown' });
  await home.start();
  return { tty, home, requests, type: (text: string) => { for (const char of text) tty.emit('data', Buffer.from(char)); } };
}

it('/merge shows the commands and merges on y; n keeps everything', async () => {
  const h = await open(body => body.kind === 'sessions.mergePlan' ? { mergePlan: mergePlan() } : body.kind === 'sessions.merge' ? { merged: { commit: 'b'.repeat(40) } } : {});
  try {
    h.type('/merge fixer\r');
    await shows(h.tty, 'Merge ai/fixer → main in your checkout · 2 commits'); await shows(h.tty, '$ git merge --no-ff --no-edit --no-gpg-sign -- ai/fixer'); await shows(h.tty, 'secret scan: nothing found');
    h.type('n'); await vi.waitFor(async () => expect(await screen(h.tty)).not.toContain('Merge ai/fixer'));
    h.type('/merge\r'); await shows(h.tty, 'Merge ai/fixer'); h.type('y');
    await vi.waitFor(() => expect(h.requests).toContainEqual({ kind: 'sessions.merge', sessionId: fixer.id, fingerprint: fp, override: false }));
    await shows(h.tty, '✓ merged ai/fixer into main');
  } finally { await h.home.stop(); }
});

it('with secret scan hits, y does nothing; only typing override then ⏎ goes on', async () => {
  const h = await open(body => body.kind === 'sessions.mergePlan' ? { mergePlan: mergePlan(2) } : body.kind === 'sessions.merge' ? { merged: { commit: 'b'.repeat(40) } } : {});
  try {
    h.type('/merge fixer\r');
    await shows(h.tty, '⚠ config.ts:1 · API key (sk-) · 48 characters hidden'); await shows(h.tty, 'type override and ⏎ to merge anyway');
    h.type('y\r'); await new Promise(resolve => setTimeout(resolve, 100));
    expect(h.requests.some(r => r.kind === 'sessions.merge')).toBe(false);
    h.type('override\r');
    await vi.waitFor(() => expect(h.requests).toContainEqual({ kind: 'sessions.merge', sessionId: fixer.id, fingerprint: fp, override: true }));
  } finally { await h.home.stop(); }
});

it('a conflict says the checkout is untouched and offers an agent to rebase the branch in its worktree', async () => {
  const h = await open(body => body.kind === 'sessions.mergePlan' ? { mergePlan: mergePlan() } : body.kind === 'sessions.merge' ? new DaemonRequestError('Merge conflict; it was undone and your checkout is as it was') : body.kind === 'sessions.create' ? { session: { ...fixer, id: randomUUID(), title: 'fixer rebase' } } : body.kind === 'engines.status' ? {} : {});
  try {
    h.type('/merge fixer\r'); await shows(h.tty, 'Merge ai/fixer'); h.type('y');
    await shows(h.tty, '/merge fixer rebase starts an agent to rebase ai/fixer onto main');
    h.type('/merge fixer rebase\r');
    await vi.waitFor(() => expect(h.requests.find(r => r.kind === 'sessions.create')).toMatchObject({ cwd: '/tmp/trees/fixer', useWorktree: false, permission: 'ask', firstMessage: expect.stringContaining('git rebase main') }));
  } finally { await h.home.stop(); }
});

it('/pr shows the push and gh commands; without gh it is a one-line note', async () => {
  const pr: PrPlan = { title: 'fixer', branch: 'ai/fixer', base: 'main', remote: 'git@github.com:yaniv/ai-term.git', gh: 'ready', commands: ['cd /tmp/trees/fixer', 'git push -u -- origin ai/fixer', 'gh pr create --head ai/fixer --base main --fill'], hits: [], moreHits: 0, fingerprint: fp };
  let gh: PrPlan['gh'] = 'missing';
  const h = await open(body => body.kind === 'sessions.prPlan' ? { prPlan: { ...pr, gh } } : body.kind === 'sessions.pr' ? { pr: { url: 'https://github.com/yaniv/ai-term/pull/7' } } : {});
  try {
    h.type('/pr fixer\r'); await shows(h.tty, "gh isn't installed · install the GitHub CLI, or run: git push -u -- origin ai/fixer");
    gh = 'ready'; h.type('/pr fixer\r');
    await shows(h.tty, 'Open a pull request: ai/fixer → main · git@github.com:yaniv/ai-term.git'); await shows(h.tty, '$ gh pr create --head ai/fixer --base main --fill');
    h.type('y'); await shows(h.tty, '✓ pull request opened · https://github.com/yaniv/ai-term/pull/7');
  } finally { await h.home.stop(); }
});
