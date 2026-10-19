import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { prepareWorktree, repoDirectory } from '../src/daemon/worktrees.js';
import { branchNames, listWorktrees, repoTopLevel } from '../src/daemon/git.js';
import { codexAuth } from '../src/cli/doctor.js';
import { openFolder } from '../src/client/tui/open-folder.js';
import { AS_ROOT } from './platform.js';
vi.mock('../src/daemon/engines.js', () => ({ checkEngine: async () => ({ installed: true, path: process.execPath, loggedIn: true, authMethod: 'subscription' }) }));

// v0.3 gate, silent-failure findings: each failure must be visible and must never weaken isolation or deletion.
const run = promisify(execFile), roots: string[] = [], managers: SessionManager[] = [], locked: string[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.shutdown(); for (const p of locked.splice(0)) await chmod(p, 0o755); for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
async function fixture(files: Record<string, string> = { 'README': 'base' }) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ai-gate-silent-'))); roots.push(temp);
  const repo = join(temp, 'repo'), home = join(temp, 'home'); await mkdir(repo); await mkdir(home, { mode: 0o700 });
  for (const [name, text] of Object.entries(files)) await writeFile(join(repo, name), text);
  await run('/usr/bin/git', ['init', '-b', 'main', '--', repo]); await run('/usr/bin/git', ['add', '--', ...Object.keys(files)], { cwd: repo });
  await run('/usr/bin/git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'base', '--'], { cwd: repo });
  const paths = getPaths(home); await preparePaths(paths);
  return { temp, repo, home, paths };
}
const manager = async (paths: ReturnType<typeof getPaths>) => { const m = new SessionManager(paths, new Logger(paths.log)); managers.push(m); await m.load(); return m; };

it.skipIf(AS_ROOT)('M1: a worktree add that fails after git made the branch stops at once, tries to undo it, and logs what it left (skipped as root: file modes do not stop root)', async () => {
  const { repo, home } = await fixture();
  await chmod(join(repo, '.git'), 0o555); locked.push(join(repo, '.git'));
  const lines: string[] = [];
  const start = await prepareWorktree(home, repo, 'agent one', text => lines.push(text));
  await chmod(join(repo, '.git'), 0o755);
  expect(start).toMatchObject({ worktreeNote: 'worktree off: creation failed' });
  // It stops at the first failure instead of trying five slugs. The read-only .git that broke the add also stops git
  // deleting the half-made branch, so that one is left and said so; the empty folder is gone.
  expect((await branchNames(repo)).filter(b => b.startsWith('ai/'))).toEqual(['ai/agent-one']);
  expect(lines).toEqual(['Worktree start rollback: branch left in place', 'Worktree start failed; agent starts in place']);
  expect(await readdir(join(home, 'worktrees', repoDirectory(repo))).catch(() => [])).toEqual([]);
});

it('M1: a failure after the worktree was added rolls the worktree and its branch back', async () => {
  const { repo, home } = await fixture({ 'README': 'base', 'sub2': 'a file in HEAD' });
  // The checkout has a folder where HEAD has a file, so the worktree has no such subfolder.
  await rm(join(repo, 'sub2')); await mkdir(join(repo, 'sub2'));
  const start = await prepareWorktree(home, join(repo, 'sub2'), 'agent two');
  expect(start).toMatchObject({ worktreeNote: 'worktree off: creation failed' });
  expect(await listWorktrees(repo)).toHaveLength(1);
  expect((await branchNames(repo)).filter(b => b.startsWith('ai/'))).toEqual([]);
  expect(await readdir(join(home, 'worktrees', repoDirectory(repo))).catch(() => [])).toEqual([]);
});

it('M2 + L6: an unreadable settings.json keeps worktrees on (the safe default) and logs an error', async () => {
  const { repo, home, paths } = await fixture();
  await writeFile(join(home, 'settings.json'), '{not json', { mode: 0o600 });
  const m = await manager(paths);
  const agent = await m.create({ engine: 'codex', model: null, auth: { kind: 'account' }, cwd: repo, permission: 'dontAsk', title: 'isolated' });
  expect(agent.worktree).toBeDefined(); expect(agent.cwd).not.toBe(repo);
  expect(agent.brain).toBeUndefined();
  expect(await readFile(paths.log, 'utf8')).toMatch(/error Settings unreadable; new agents keep their worktrees/);
});

it('M3: a worktree whose .git file is gone but whose folder holds work is never shown as "nothing would be lost"', async () => {
  const { repo, paths } = await fixture(), m = await manager(paths);
  const agent = await m.create({ engine: 'codex', model: null, auth: { kind: 'account' }, cwd: repo, permission: 'ask', title: 'precious' });
  await expect.poll(() => m.get(agent.id).status).toMatch(/exited|error/);
  const tree = agent.worktree ?? ''; await writeFile(join(tree, 'precious.txt'), 'work'); await rm(join(tree, '.git'));
  const view = await m.checkWorktree(tree);
  expect(view.loss?.missing).not.toBe(true);
  expect(view.refusal).toBeDefined();
  await expect(m.deleteWorktree(tree, view.fingerprint ?? 'f'.repeat(64))).rejects.toThrow();
  expect(await readFile(join(tree, 'precious.txt'), 'utf8')).toBe('work');
});

it('M4: a worktree record that fails validation is kept in a moved-aside copy, not erased by the next save', async () => {
  const { home, paths } = await fixture(), now = new Date().toISOString();
  const good = { path: join(home, 'worktrees', 'r-0123456789', 'good'), branch: 'ai/good', createdAt: now };
  const odd = { path: join(home, 'worktrees', 'r-0123456789', 'odd'), branch: 'ai/odd', createdAt: now, newerField: 1 };
  const text = JSON.stringify({ sessions: [], worktrees: [good, odd] });
  await writeFile(paths.state, text, { mode: 0o600 });
  const m = await manager(paths);
  const copies = (await readdir(paths.root)).filter(n => n.startsWith('state.json.corrupt-'));
  expect(copies).toHaveLength(1);
  expect(await readFile(join(paths.root, copies[0] ?? ''), 'utf8')).toBe(text);
  expect(m.notice).toContain('saved it as');
  expect((await m.checkWorktree(good.path)).refusal).not.toBe("Not in AI Term's record");
});

it('M5: a git failure on a real repo is an error, not "not a git repo"; a plain folder is still not a repo', async () => {
  const { temp, repo } = await fixture();
  const odd = join(repo, 're‍po'); await mkdir(odd);
  await expect(repoTopLevel(odd)).rejects.toThrow('Git check failed');
  const plain = join(temp, 'plain'); await mkdir(plain);
  expect(await repoTopLevel(plain)).toBeNull();
});

it('L2: a codex login check that never ran is "status unavailable", not "logged in no"', () => {
  expect(codexAuth(null, '')).toBe('status unavailable');
  expect(codexAuth(1, 'Not logged in')).toBe('exit 1; logged in no');
});

it.skipIf(AS_ROOT)('L3: a folder /open cannot read is "unavailable", not "gone" (skipped as root: file modes do not stop root)', async () => {
  const { temp } = await fixture(), parent = join(temp, 'closed'), child = join(parent, 'inner');
  await mkdir(child, { recursive: true }); await chmod(parent, 0o000); locked.push(parent);
  await expect(openFolder(child, 'finder', async () => {})).rejects.toThrow('folder is unavailable');
});
