import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import pty from 'node-pty';
import headless from '@xterm/headless';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import * as engines from '../src/daemon/engines.js';
import { validateForkPlan } from '../src/shared/fork.js';
import { Homepage } from '../src/client/tui/homepage.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SessionInfo, SuccessResponse } from '../src/shared/protocol.js';

// v0.7.4 /fork [agent] <model>: the same first message on a second model, in its own worktree started from the same
// commit, so `/diff <agent> vs <other>` compares the two. It spends tokens, so D49 asks first.
const run = promisify(execFile), cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
const git = (cwd: string, ...args: string[]) => run('/usr/bin/git', [...ID, ...args], { cwd });
async function daemon() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-fork-'))), home = join(root, 'home'), repo = join(root, 'repo');
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(home, { mode: 0o700 }); await mkdir(join(repo, 'web'), { recursive: true });
  await run('/usr/bin/git', ['init', '-q', '-b', 'main', '--', repo]); await writeFile(join(repo, 'web', 'login.ts'), 'const a = 1;\n');
  await git(repo, 'add', '--', '.'); await git(repo, 'commit', '-qm', 'initial', '--');
  const paths = getPaths(home); await preparePaths(paths);
  const manager = new SessionManager(paths, new Logger(paths.log)); await manager.load();
  cleanups.push(() => manager.shutdown());
  const spawned: string[][] = [], real = pty.spawn;
  vi.spyOn(pty, 'spawn').mockImplementation((_file, args, options) => { spawned.push(Array.isArray(args) ? [...args] : []); return real('/bin/sh', ['-c', 'printf ready; sleep 30'], { ...options, env: { PATH: '/usr/bin:/bin' } }); });
  vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' });
  return { root, home, repo, manager, spawned };
}

it('/fork asks first, then starts the same first message on the other model in its own worktree from the same start commit', async () => {
  const d = await daemon();
  const source = await d.manager.create({ engine: 'codex', model: 'gpt-a', auth: { kind: 'account' }, cwd: join(d.repo, 'web'), permission: 'ask', title: 'fixer', firstMessage: 'fix the login bug' });
  // Your checkout moves on meanwhile; the fork still starts where fixer started.
  await writeFile(join(d.repo, 'other.ts'), 'x\n'); await git(d.repo, 'add', '--', '.'); await git(d.repo, 'commit', '-qm', 'later', '--');
  const plan = validateForkPlan(await d.manager.forkPlan(source.id, { engine: 'claude-code', model: 'sonnet', auth: { kind: 'account' } }));
  expect(plan).toMatchObject({ source: 'fixer', engine: 'claude-code', model: 'sonnet', firstMessage: 'fix the login bug', subscription: true, priceUsd: null });
  expect(plan.base).toMatch(/^main @ [0-9a-f]{7}$/);
  const fork = await d.manager.fork(source.id, { engine: 'claude-code', model: 'sonnet', auth: { kind: 'account' } });
  expect(fork).toMatchObject({ title: 'fixer fork', engine: 'claude-code', model: 'sonnet', permission: 'ask', branch: 'ai/fixer-fork' });
  expect(fork.worktree).not.toBe(source.worktree);
  expect(fork.cwd).toBe(join(fork.worktree ?? '', 'web'));
  const start = async (tree: string) => (await git(tree, 'rev-parse', 'HEAD')).stdout.trim();
  expect(await start(fork.worktree ?? '')).toBe(await start(source.worktree ?? ''));
  expect(d.spawned.at(-1)?.at(-1)).toBe('fix the login bug');
});

it('refuses an agent without a first message or a worktree, and never forks into Don\'t ask', async () => {
  const d = await daemon();
  const bare = await d.manager.create({ engine: 'codex', model: 'gpt-a', auth: { kind: 'account' }, cwd: d.repo, permission: 'ask', title: 'idle' });
  await expect(d.manager.forkPlan(bare.id, { engine: 'codex', model: 'gpt-b', auth: { kind: 'account' } })).rejects.toThrow("Fork needs the agent's first message; it started without one, or before the background service restarted");
  const loose = await d.manager.create({ engine: 'codex', model: 'gpt-a', auth: { kind: 'account' }, cwd: d.home, permission: 'dontAsk', title: 'loose', firstMessage: 'x' });
  await expect(d.manager.forkPlan(loose.id, { engine: 'codex', model: 'gpt-b', auth: { kind: 'account' } })).rejects.toThrow('Fork needs an agent with a worktree, so the two can be compared');
  const source = await d.manager.create({ engine: 'codex', model: 'gpt-a', auth: { kind: 'account' }, cwd: d.repo, permission: 'dontAsk', title: 'fast', firstMessage: 'go' });
  expect((await d.manager.fork(source.id, { engine: 'codex', model: 'gpt-b', auth: { kind: 'account' } })).permission).toBe('ask');
});

it('/diff <agent> vs <other>: one worktree against the other\'s last checkpoint (else its branch)', async () => {
  const d = await daemon();
  const source = await d.manager.create({ engine: 'codex', model: 'gpt-a', auth: { kind: 'account' }, cwd: d.repo, permission: 'ask', title: 'fixer', firstMessage: 'fix it' });
  const fork = await d.manager.fork(source.id, { engine: 'codex', model: 'gpt-b', auth: { kind: 'account' } });
  await writeFile(join(source.worktree ?? '', 'web', 'login.ts'), 'const a = 2;\nshared();\n');
  await writeFile(join(fork.worktree ?? '', 'web', 'login.ts'), 'const a = 3;\nshared();\n');
  await d.manager.checkpointTurn(source.id);
  const compared = await d.manager.diff(fork.id, source.id);
  expect(compared).toMatchObject({ title: 'fixer fork', base: expect.stringMatching(/^fixer @ checkpoint 1$/) });
  expect(compared.files.map(f => f.path)).toEqual(['web/login.ts']);
  expect(compared.files[0]?.lines).toEqual(expect.arrayContaining(['-const a = 2;', '+const a = 3;']));
  expect(compared.files[0]?.lines).not.toContain('+shared();');
  await expect(d.manager.diff(fork.id, fork.id)).rejects.toThrow('Pick two different agents to compare');
});

class TTY extends EventEmitter { isTTY = true; isRaw = false; columns = 130; rows = 45; output = ''; setRawMode(v: boolean) { this.isRaw = v; } resume() {} pause() {} write(data: string | Buffer) { this.output += data.toString(); return true; } }
async function screen(tty: TTY): Promise<string> { const terminal = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true }); try { await new Promise<void>(resolve => terminal.write(tty.output, resolve)); return Array.from({ length: 45 }, (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n'); } finally { terminal.dispose(); } }
const shows = (tty: TTY, text: string) => vi.waitFor(async () => expect(await screen(tty)).toContain(text));

it('homepage: /fork <agent> <model> shows the D49 ask and ⏎ forks; /diff a vs b asks the daemon for the comparison', async () => {
  const now = new Date().toISOString();
  const fixer: SessionInfo = { id: randomUUID(), title: 'fixer', engine: 'codex', model: 'gpt-6.1-sol', auth: { kind: 'account' }, cwd: '/tmp/t/fixer', worktree: '/tmp/t/fixer', branch: 'ai/fixer', permission: 'ask', status: 'done', statusDetail: 'done', statusSince: now, createdAt: now, lastOutputAt: now, exitCode: null, ctxPercent: null, lastActivity: null, taskUsage: { tokens: 120_000, costUsd: null } };
  const forked: SessionInfo = { ...fixer, id: randomUUID(), title: 'fixer fork', engine: 'claude-code', model: 'sonnet', worktree: '/tmp/t/fixer-fork', cwd: '/tmp/t/fixer-fork', branch: 'ai/fixer-fork', status: 'running' };
  const plan = { source: 'fixer', engine: 'claude-code' as const, model: 'sonnet', authLabel: 'own login · sub', firstMessage: 'fix the login bug', base: 'main @ abc1234', tokens: { low: 60_000, high: 240_000 }, priceUsd: null, subscription: true };
  const requests: RequestBody[] = [];
  const client = Object.assign(new EventEmitter(), { async request(body: RequestBody): Promise<SuccessResponse> {
    requests.push(body); const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.get') response.settings = { theme: 'graphite' };
    if (body.kind === 'sessions.list') response.sessions = [fixer, forked];
    if (body.kind === 'sessions.preview') { response.snapshot = ''; response.cols = 85; response.rows = 30; }
    if (body.kind === 'keys.list') response.keys = [];
    if (body.kind === 'engines.status') response.engines = { claudeCode: { installed: true, path: '/bin/claude', version: '1', loggedIn: true, authMethod: 'subscription' }, codex: { installed: true, path: '/bin/codex', version: '1', loggedIn: true, authMethod: 'subscription' } };
    if (body.kind === 'sessions.forkPlan') response.forkPlan = plan;
    if (body.kind === 'sessions.fork') response.session = forked;
    if (body.kind === 'sessions.diff') response.diff = { title: 'fixer fork', branch: 'ai/fixer-fork', base: 'fixer @ checkpoint 1', files: [], added: 0, removed: 0, capped: false };
    return response;
  } });
  const tty = new TTY(), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', terminalProgram: 'unknown' });
  await home.start();
  const type = (text: string) => { for (const char of text) tty.emit('data', Buffer.from(char)); };
  try {
    type('/fork fixer sonnet\r');
    await vi.waitFor(() => expect(requests).toContainEqual({ kind: 'sessions.forkPlan', sessionId: fixer.id, engine: 'claude-code', model: 'sonnet', auth: { kind: 'account' } }));
    await shows(tty, 'Fork fixer → sonnet · claude code · own login · sub'); await shows(tty, 'first message: fix the login bug');
    await shows(tty, 'from the same start (main @ abc1234), in its own worktree, Ask');
    await shows(tty, "estimated 60.0K–240.0K tokens (from fixer's run so far) · uses your plan's limits");
    type('\r');
    await vi.waitFor(() => expect(requests).toContainEqual({ kind: 'sessions.fork', sessionId: fixer.id, engine: 'claude-code', model: 'sonnet', auth: { kind: 'account' } }));
    await shows(tty, '✓ forked fixer → fixer fork · /diff fixer fork vs fixer compares them');
    type('/diff fixer fork vs fixer\r');
    await vi.waitFor(() => expect(requests).toContainEqual({ kind: 'sessions.diff', sessionId: forked.id, against: fixer.id }));
    await shows(tty, 'fixer @ checkpoint 1');
  } finally { await home.stop(); }
});
