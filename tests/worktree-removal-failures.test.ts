import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { Logger } from '../src/daemon/log.js';
import { branchNames, listWorktrees, GitError } from '../src/daemon/git.js';
vi.mock('../src/daemon/engines.js', () => ({ checkEngine: async () => ({ installed:true, path:process.execPath, loggedIn:true, authMethod:'subscription' }) }));
// Git errors in the worktree step: the real check runs, then the remove call itself fails.
vi.mock('../src/daemon/git.js', async original => {
 const real = await original<typeof import('../src/daemon/git.js')>();
 return { ...real, removeWorktree: vi.fn(async () => { throw new real.GitError('Worktree remove failed'); }), forceRemoveWorktree: vi.fn(async () => { throw new real.GitError('Worktree remove failed'); }), deleteBranch: vi.fn(real.deleteBranch), forceDeleteBranch: vi.fn(real.forceDeleteBranch) };
});
const run = promisify(execFile), roots: string[] = [], managers: SessionManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.shutdown(); for (const root of roots.splice(0)) await rm(root, { recursive:true, force:true }); });
const git = (cwd: string, ...args: string[]) => run('/usr/bin/git', ['-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false',...args], { cwd });
it('a git error in the worktree step stops before the branch step, keeps the record and the checkout', async () => {
 const temp = await realpath(await mkdtemp(join(tmpdir(), 'ai-remove-fail-'))); roots.push(temp);
 const repo = join(temp, 'repo'), home = join(temp, 'home'); await mkdir(repo); await mkdir(home, { mode:0o700 });
 await git(temp, 'init', '-q', '-b', 'main', '--', repo); await writeFile(join(repo, 'tracked.txt'), 'committed'); await git(repo, 'add', '--', 'tracked.txt'); await git(repo, 'commit', '-q', '-m', 'initial', '--');
 const paths = getPaths(home); await preparePaths(paths); const sessions = new SessionManager(paths, new Logger(paths.log)); managers.push(sessions); await sessions.load();
 const agent = await sessions.create({ engine:'codex', model:null, auth:{ kind:'account' }, cwd:repo, permission:'ask', title:'agent' }), path = agent.worktree ?? '';
 await expect.poll(() => sessions.get(agent.id).status).toMatch(/exited|error/);
 const git_ = await import('../src/daemon/git.js');
 const clean = await sessions.checkWorktree(path);
 await expect(sessions.deleteWorktree(path, clean.fingerprint ?? '')).rejects.toThrow('Worktree remove failed; branch kept');
 await writeFile(join(path, 'draft.txt'), 'work'); const lossy = await sessions.checkWorktree(path);
 await expect(sessions.deleteWorktree(path, lossy.fingerprint ?? '', 'ai/agent')).rejects.toThrow('Worktree remove failed; branch kept');
 expect(git_.deleteBranch).not.toHaveBeenCalled(); expect(git_.forceDeleteBranch).not.toHaveBeenCalled(); expect(GitError).toBeDefined();
 expect(await readFile(join(path, 'draft.txt'), 'utf8')).toBe('work'); expect(await lstat(join(path, 'tracked.txt'))).toBeDefined();
 expect((await listWorktrees(repo)).map(w => w.path)).toContain(path); expect(await branchNames(repo)).toContain('ai/agent');
 expect((await sessions.worktreeViews()).map(v => v.path)).toEqual([path]);
 expect((await git(repo, 'status', '--porcelain', '--')).stdout).toBe('');
});
