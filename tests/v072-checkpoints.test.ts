import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, realpath, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import headless from '@xterm/headless';
import { MAX_CHECKPOINTS, applyUndo, dropCheckpoints, listCheckpoints, snapshot, undoPlan } from '../src/daemon/checkpoints.js';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { SettingsStore } from '../src/daemon/settings.js';
import { Homepage } from '../src/client/tui/homepage.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SessionInfo, SuccessResponse } from '../src/shared/protocol.js';
import type { UndoPlan } from '../src/shared/checkpoints.js';

// v0.7.2 (D55, on): after every agent turn the worktree is snapshotted into refs/ai-term/checkpoints/<slug>/<n> through
// a temporary index, so the agent's own index, branch and HEAD never change; /undo restores the previous one (asking
// first), /redo brings the undone state back. Nothing outside the agent's worktree is ever touched.
const run = promisify(execFile), roots: string[] = [], managers: SessionManager[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.shutdown(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => run('/usr/bin/git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd });
async function fixture() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ai-ckpt-'))); roots.push(temp);
  const repo = join(temp, 'repo'), tree = join(temp, 'trees', 'fixer'); await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'a.ts'), 'one\n'); await writeFile(join(repo, 'keep.txt'), 'keep\n'); await writeFile(join(repo, '.gitignore'), '*.log\n');
  await run('/usr/bin/git', ['init', '--', repo]); await git(repo, 'add', '--', '.'); await git(repo, 'commit', '-m', 'initial', '--');
  await git(repo, 'worktree', 'add', '-bai/fixer', '--', tree, 'HEAD');
  return { temp, repo, tree };
}
// What the agent itself sees in git: its index, HEAD, branch and status, which a checkpoint or undo must never change.
const agentGit = async (tree: string) => [await readFile(join((await git(tree, 'rev-parse', '--absolute-git-dir')).stdout.trim(), 'index')), (await git(tree, 'rev-parse', 'HEAD')).stdout, (await git(tree, 'branch', '--show-current')).stdout];

it('a checkpoint holds tracked and untracked (not ignored) files and leaves the agent\'s index, HEAD and branch alone', async () => {
  const { tree } = await fixture();
  await writeFile(join(tree, 'src', 'a.ts'), 'two\n'); await writeFile(join(tree, 'new.md'), 'new\n'); await writeFile(join(tree, 'debug.log'), 'ignored\n');
  const before = await agentGit(tree), status = (await git(tree, 'status', '--porcelain')).stdout;
  const first = await snapshot(tree, 'fixer');
  expect(first?.n).toBe(1);
  expect((await git(tree, 'show-ref', '--', 'refs/ai-term/checkpoints/fixer/1')).stdout).toContain(first?.commit ?? 'missing');
  const files = (await git(tree, 'ls-tree', '-r', '--name-only', first?.commit ?? '', '--')).stdout.split('\n').filter(Boolean);
  expect(files.sort()).toEqual(['.gitignore', 'keep.txt', 'new.md', 'src/a.ts']);
  expect((await git(tree, 'show', `${first?.commit}:src/a.ts`)).stdout).toBe('two\n');
  expect(await agentGit(tree)).toEqual(before); expect((await git(tree, 'status', '--porcelain')).stdout).toBe(status);
  // Nothing changed: no new checkpoint. A change: the next number.
  expect(await snapshot(tree, 'fixer')).toBeNull();
  await writeFile(join(tree, 'new.md'), 'newer\n');
  expect((await snapshot(tree, 'fixer'))?.n).toBe(2);
});

it(`only the last ${MAX_CHECKPOINTS} checkpoints are kept`, async () => {
  const { tree } = await fixture();
  for (let i = 0; i < MAX_CHECKPOINTS + 3; i++) { await writeFile(join(tree, 'n.txt'), `${i}\n`); await snapshot(tree, 'fixer'); }
  const list = await listCheckpoints(tree, 'fixer');
  expect(list).toHaveLength(MAX_CHECKPOINTS); expect(list[0]?.n).toBe(4); expect(list.at(-1)?.n).toBe(MAX_CHECKPOINTS + 3);
}, 60_000);

it('/undo shows what changes, restores the previous checkpoint after a fresh snapshot, and /redo brings it back', async () => {
  const { tree } = await fixture();
  await writeFile(join(tree, 'src', 'a.ts'), 'turn one\n'); await snapshot(tree, 'fixer');
  await writeFile(join(tree, 'src', 'a.ts'), 'turn two\n'); await writeFile(join(tree, 'added.md'), 'added\n'); await rm(join(tree, 'keep.txt')); await snapshot(tree, 'fixer');
  const before = await agentGit(tree);
  const plan = await undoPlan(tree, 'fixer', 'undo');
  expect(plan).toMatchObject({ kind: 'undo', target: 1, changes: expect.arrayContaining([{ path: 'src/a.ts', change: 'modified' }, { path: 'added.md', change: 'removed' }, { path: 'keep.txt', change: 'restored' }]) });
  expect(await applyUndo(tree, 'fixer', 'undo', plan.fingerprint)).toEqual({ restored: 3 });
  expect(await readFile(join(tree, 'src', 'a.ts'), 'utf8')).toBe('turn one\n'); expect(await readFile(join(tree, 'keep.txt'), 'utf8')).toBe('keep\n');
  await expect(access(join(tree, 'added.md'))).rejects.toThrow();
  expect(await agentGit(tree)).toEqual(before);
  const redo = await undoPlan(tree, 'fixer', 'redo');
  expect(redo.changes).toEqual(expect.arrayContaining([{ path: 'added.md', change: 'restored' }]));
  await applyUndo(tree, 'fixer', 'redo', redo.fingerprint);
  expect(await readFile(join(tree, 'src', 'a.ts'), 'utf8')).toBe('turn two\n'); expect(await readFile(join(tree, 'added.md'), 'utf8')).toBe('added\n');
  await expect(undoPlan(tree, 'fixer', 'redo')).rejects.toThrow('Nothing to redo');
});

it('a change after the preview refuses the undo; with no earlier checkpoint there is nothing to undo', async () => {
  const { tree } = await fixture();
  await expect(undoPlan(tree, 'fixer', 'undo')).rejects.toThrow('No checkpoint to go back to');
  await writeFile(join(tree, 'src', 'a.ts'), 'x\n'); await snapshot(tree, 'fixer');
  await writeFile(join(tree, 'src', 'a.ts'), 'y\n');
  // Changed since the last checkpoint: undo goes back to it.
  const plan = await undoPlan(tree, 'fixer', 'undo');
  expect(plan.target).toBe(1);
  await writeFile(join(tree, 'src', 'a.ts'), 'z\n');
  await expect(applyUndo(tree, 'fixer', 'undo', plan.fingerprint)).rejects.toThrow('Changed since you looked; run /undo again');
  expect(await readFile(join(tree, 'src', 'a.ts'), 'utf8')).toBe('z\n');
});

it('restoring never writes through a symlinked folder or outside the worktree', async () => {
  const { temp, tree } = await fixture();
  const outside = join(temp, 'outside'); await mkdir(outside);
  await writeFile(join(tree, 'src', 'a.ts'), 'mine\n'); await snapshot(tree, 'fixer');
  await rm(join(tree, 'src'), { recursive: true }); await symlink(outside, join(tree, 'src'));
  const plan = await undoPlan(tree, 'fixer', 'undo');
  await expect(applyUndo(tree, 'fixer', 'undo', plan.fingerprint)).rejects.toThrow('A folder in the worktree is a symlink; nothing was restored');
  await expect(access(join(outside, 'a.ts'))).rejects.toThrow();
});

it('checkpoint refs go away with the worktree', async () => {
  const { repo, tree } = await fixture();
  await writeFile(join(tree, 'x.txt'), 'x\n'); await snapshot(tree, 'fixer');
  await dropCheckpoints(repo, 'fixer');
  expect((await git(repo, 'for-each-ref', '--', 'refs/ai-term/')).stdout).toBe('');
});

it('the daemon checkpoints a turn that ends, refuses /undo while the agent runs or asks, and honours the setting', async () => {
  const { temp, repo } = await fixture();
  const home = join(temp, 'home'); await mkdir(home, { mode: 0o700 });
  const paths = getPaths(home); await preparePaths(paths);
  const m = new SessionManager(paths, new Logger(paths.log)); managers.push(m); await m.load();
  const agent = await m.create({ engine: 'codex', model: 'gpt-test', auth: { kind: 'account' }, cwd: repo, permission: 'ask', title: 'fixer' });
  const tree = agent.worktree ?? '';
  await writeFile(join(tree, 'work.md'), 'work\n');
  await m.checkpointTurn(agent.id);
  expect((await listCheckpoints(tree, 'fixer')).map(c => c.n)).toEqual([1]);
  const live = (m as unknown as { sessions: Map<string, { info: SessionInfo }> }).sessions.get(agent.id);
  if (!live) throw new Error('no live');
  live.info.status = 'running';
  await expect(m.undoPlan(agent.id, 'undo')).rejects.toThrow('Stop or wait for the agent first; it is running');
  live.info.status = 'waiting'; live.info.statusDetail = 'permission';
  await expect(m.undoPlan(agent.id, 'undo')).rejects.toThrow('Stop or wait for the agent first; it is asking');
  live.info.status = 'done';
  await writeFile(join(tree, 'work.md'), 'more\n');
  expect((await m.undoPlan(agent.id, 'undo')).target).toBe(1);
  await new SettingsStore(home).set({ checkpoints: false });
  await m.checkpointTurn(agent.id);
  expect((await listCheckpoints(tree, 'fixer')).map(c => c.n)).toEqual([1]);
  await expect(m.undoPlan(agent.id, 'undo')).rejects.toThrow('Checkpoints are off · /settings u turns them on');
});

class TTY extends EventEmitter { isTTY = true; isRaw = false; columns = 130; rows = 45; output = ''; setRawMode(v: boolean) { this.isRaw = v; } resume() {} pause() {} write(data: string | Buffer) { this.output += data.toString(); return true; } }
async function screen(tty: TTY): Promise<string> { const terminal = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true }); try { await new Promise<void>(resolve => terminal.write(tty.output, resolve)); return Array.from({ length: 45 }, (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n'); } finally { terminal.dispose(); } }

it('/undo on the homepage shows the plan and restores only on y; n and Esc keep everything', async () => {
  const now = new Date().toISOString();
  const fixer: SessionInfo = { id: randomUUID(), title: 'fixer', engine: 'codex', model: 'gpt', auth: { kind: 'account' }, cwd: '/tmp', worktree: '/tmp/trees/fixer', branch: 'ai/fixer', permission: 'ask', status: 'done', statusDetail: 'done', statusSince: now, createdAt: now, lastOutputAt: now, exitCode: null, ctxPercent: null, lastActivity: null };
  const plan: UndoPlan = { kind: 'undo', title: 'fixer', target: 2, targetAt: now, changes: [{ path: 'src/a.ts', change: 'modified' }, { path: 'new.md', change: 'removed' }], more: 0, fingerprint: 'f'.repeat(64) };
  const requests: RequestBody[] = [];
  const client = Object.assign(new EventEmitter(), { async request(body: RequestBody): Promise<SuccessResponse> {
    requests.push(body); const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.get') response.settings = { theme: 'graphite' };
    if (body.kind === 'sessions.list') response.sessions = [fixer];
    if (body.kind === 'sessions.preview') { response.snapshot = ''; response.cols = 85; response.rows = 30; }
    if (body.kind === 'sessions.undoPlan') response.undoPlan = plan;
    if (body.kind === 'sessions.undo') response.undone = { restored: 2 };
    return response;
  } });
  const tty = new TTY(), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', terminalProgram: 'unknown' });
  await home.start();
  const type = (text: string) => { for (const char of text) tty.emit('data', Buffer.from(char)); };
  try {
    type('/undo fixer\r');
    await vi.waitFor(async () => expect(await screen(tty)).toContain('Undo fixer → checkpoint 2'));
    expect(await screen(tty)).toContain('M src/a.ts'); expect(await screen(tty)).toContain('− new.md');
    type('n');
    await vi.waitFor(async () => expect(await screen(tty)).not.toContain('Undo fixer'));
    expect(requests.some(r => r.kind === 'sessions.undo')).toBe(false);
    type('/undo\r'); await vi.waitFor(async () => expect(await screen(tty)).toContain('Undo fixer'));
    type('y');
    await vi.waitFor(() => expect(requests).toContainEqual({ kind: 'sessions.undo', sessionId: fixer.id, redo: false, fingerprint: plan.fingerprint }));
    await vi.waitFor(async () => expect(await screen(tty)).toContain('✓ undone · fixer is back at checkpoint 2 · /redo brings it back'));
  } finally { await home.stop(); }
});
