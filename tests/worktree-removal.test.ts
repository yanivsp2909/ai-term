import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink, lstat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareWorktree, repoDirectory } from '../src/daemon/worktrees.js';
import { listWorktrees, branchNames } from '../src/daemon/git.js';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { Logger } from '../src/daemon/log.js';
import type { SessionInfo } from '../src/shared/protocol.js';
const engine = vi.hoisted(() => ({ path: process.execPath }));
vi.mock('../src/daemon/engines.js', () => ({ checkEngine: async () => ({ installed:true, path:engine.path, loggedIn:true, authMethod:'subscription' }) }));
const run = promisify(execFile), roots: string[] = [], managers: SessionManager[] = [];
afterEach(async () => { engine.path = process.execPath; for (const manager of managers.splice(0)) await manager.shutdown(); for (const root of roots.splice(0)) await rm(root, { recursive:true, force:true }); });
const git = (cwd: string, ...args: string[]) => run('/usr/bin/git', ['-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false',...args], { cwd });
async function fixture() {
 const temp = await realpath(await mkdtemp(join(tmpdir(), 'ai-remove-'))); roots.push(temp);
 const repo = join(temp, 'repo spaces'), home = join(temp, 'home'); await mkdir(repo); await mkdir(home, { mode:0o700 });
 await git(temp, 'init', '-q', '-b', 'main', '--', repo); await writeFile(join(repo, 'tracked.txt'), 'committed'); await writeFile(join(repo, '.gitignore'), 'ignored*\n');
 await git(repo, 'add', '--', 'tracked.txt', '.gitignore'); await git(repo, 'commit', '-q', '-m', 'initial', '--');
 const paths = getPaths(home); await preparePaths(paths);
 return { temp, repo, home, paths };
}
async function manager(paths: ReturnType<typeof getPaths>) { const made = new SessionManager(paths, new Logger(paths.log)); managers.push(made); await made.load(); return made; }
// A finished agent in its own worktree, made through the real start path.
async function finishedAgent(sessions: SessionManager, repo: string, title = 'agent'): Promise<SessionInfo & { worktree: string; branch: string }> {
 const started = await sessions.create({ engine:'codex', model:null, auth:{ kind:'account' }, cwd:repo, permission:'ask', title });
 await expect.poll(() => sessions.get(started.id).status).toMatch(/exited|error/);
 if (!started.worktree || !started.branch) throw new Error('worktree expected');
 return { ...started, worktree:started.worktree, branch:started.branch };
}
// The user's checkout: HEAD, branch, status and tracked content must be exactly as before every operation.
async function checkout(repo: string) { return [(await git(repo, 'status', '--porcelain', '--untracked-files=all', '--ignored', '--')).stdout, (await git(repo, 'show', '--no-patch', '--format=%H', '--')).stdout, (await git(repo, 'branch', '--show-current')).stdout, await readFile(join(repo, 'tracked.txt'), 'utf8')].join('|'); }
const listed = async (repo: string, path: string) => (await listWorktrees(repo)).some(entry => entry.path === path);
async function writeState(paths: ReturnType<typeof getPaths>, worktrees: unknown[], sessions: unknown[] = []) { await writeFile(paths.state, JSON.stringify({ sessions, worktrees }), { mode:0o600 }); }

it('new agents record repo, base branch and base commit; the record outlives the agent and reloads', async () => {
 const { repo, paths } = await fixture(), sessions = await manager(paths), agent = await finishedAgent(sessions, repo);
 const head = (await git(repo, 'show', '--no-patch', '--format=%H', '--')).stdout.trim();
 const state = JSON.parse(await readFile(paths.state, 'utf8')) as { worktrees: unknown[] };
 expect(state.worktrees).toEqual([{ path:agent.worktree, branch:'ai/agent', repo:await realpath(repo), baseBranch:'main', baseCommit:head, createdAt:expect.any(String) }]);
 await sessions.remove(agent.id);
 const reloaded = await manager(paths), views = await reloaded.worktreeViews();
 expect(views).toEqual([{ path:agent.worktree, branch:'ai/agent', loss:{ changed:0, untracked:0, ignored:0, repos:0, commits:0, base:'main', baseSource:'recorded', missing:false }, fingerprint:expect.stringMatching(/^[0-9a-f]{64}$/) }]);
});
it('a v0.3.1 session record becomes a legacy record whose repo is found through git and checked against the folder hash', async () => {
 const { repo, home, paths } = await fixture(), started = await prepareWorktree(home, repo, 'old agent'), now = new Date().toISOString();
 const old = { id:'0b5c6a3e-5a8f-4d36-9a0c-6d2f1f4f2a11', title:'old agent', engine:'codex', model:null, auth:{ kind:'account' }, cwd:started.cwd, worktree:started.worktree, branch:started.branch, permission:'ask', status:'exited', statusDetail:'exit 0', statusSince:now, exitCode:0, createdAt:now, lastOutputAt:null, ctxPercent:null, lastActivity:null };
 await writeFile(paths.state, JSON.stringify({ sessions:[old] }), { mode:0o600 });
 const sessions = await manager(paths), view = await sessions.checkWorktree(started.worktree ?? '');
 expect(view).toMatchObject({ branch:'ai/old-agent', agent:{ title:'old agent', status:'exited' }, loss:{ base:'main', baseSource:'checkout' } });
 const before = await checkout(repo); await sessions.deleteWorktree(started.worktree ?? '', view.fingerprint ?? '');
 expect(await listed(repo, started.worktree ?? '')).toBe(false); expect(await branchNames(repo)).toEqual(['main']); expect(await checkout(repo)).toBe(before);
});
it('refuses a recorded path outside the worktrees root and never touches it', async () => {
 const { temp, repo, paths } = await fixture(), outside = join(temp, 'outside'), before = await checkout(repo);
 await git(repo, 'worktree', 'add', '-q', '-bai/outside', '--', outside, 'HEAD');
 await writeState(paths, [{ path:outside, branch:'ai/outside', repo, createdAt:new Date().toISOString() }]);
 const sessions = await manager(paths);
 expect(await sessions.checkWorktree(outside)).toMatchObject({ refusal:'Outside the worktrees folder' });
 await expect(sessions.deleteWorktree(outside, 'f'.repeat(64), 'ai/outside')).rejects.toThrow('Outside the worktrees folder');
 expect(await listed(repo, outside)).toBe(true); expect(await lstat(join(outside, 'tracked.txt'))).toBeDefined(); expect(await checkout(repo)).toBe(before);
});
it('refuses a symlinked worktree folder or repo folder inside the root', async () => {
 const { temp, repo, home, paths } = await fixture(), real = join(temp, 'real tree'), top = await realpath(repo);
 await git(repo, 'worktree', 'add', '-q', '-bai/linked', '--', real, 'HEAD');
 const repoDir = join(await realpath(home), 'worktrees', repoDirectory(top)); await mkdir(repoDir, { recursive:true, mode:0o700 });
 const linked = join(repoDir, 'linked'); await symlink(real, linked);
 await writeState(paths, [{ path:linked, branch:'ai/linked', repo:top, createdAt:new Date().toISOString() }]);
 let sessions = await manager(paths);
 expect(await sessions.checkWorktree(linked)).toMatchObject({ refusal:'Path has a symlink' });
 await expect(sessions.deleteWorktree(linked, 'f'.repeat(64), 'ai/linked')).rejects.toThrow('Path has a symlink');
 await rm(linked); await rm(repoDir, { recursive:true }); const elsewhere = join(temp, 'elsewhere'); await mkdir(join(elsewhere, 'linked'), { recursive:true }); await symlink(elsewhere, repoDir);
 sessions = await manager(paths);
 expect(await sessions.checkWorktree(join(repoDir, 'linked'))).toMatchObject({ refusal:'Path has a symlink' });
 expect(await listed(repo, real)).toBe(true); expect(await lstat(join(real, 'tracked.txt'))).toBeDefined();
});
it('refuses a worktree that is not in the record, and lists it read-only', async () => {
 const { repo, home, paths } = await fixture(), started = await prepareWorktree(home, repo, 'stray'), sessions = await manager(paths), path = started.worktree ?? '';
 expect(await sessions.checkWorktree(path)).toEqual({ path, refusal:"Not in AI Term's record" });
 await expect(sessions.deleteWorktree(path, 'f'.repeat(64), 'ai/stray')).rejects.toThrow("Not in AI Term's record");
 expect(await sessions.worktreeViews()).toEqual([{ path, refusal:"Not in AI Term's record" }]); expect(await listed(repo, path)).toBe(true);
});
it('refuses a record that points at the main checkout', async () => {
 const { repo, paths } = await fixture(), top = await realpath(repo), before = await checkout(repo);
 await writeState(paths, [{ path:top, branch:'ai/main', repo:top, createdAt:new Date().toISOString() }]);
 const sessions = await manager(paths);
 expect(await sessions.checkWorktree(top)).toMatchObject({ refusal:'Main checkout is never deleted' });
 await expect(sessions.deleteWorktree(top, 'f'.repeat(64), 'ai/main')).rejects.toThrow('Main checkout is never deleted');
 expect(await checkout(repo)).toBe(before);
});
it('refuses a recorded repo that does not hash to the worktree folder', async () => {
 const { temp, repo, home, paths } = await fixture(), started = await prepareWorktree(home, repo, 'agent'), other = join(temp, 'other');
 await mkdir(other); await git(temp, 'init', '-q', '-b', 'main', '--', other);
 await writeState(paths, [{ path:started.worktree, branch:started.branch, repo:other, createdAt:new Date().toISOString() }]);
 expect(await (await manager(paths)).checkWorktree(started.worktree ?? '')).toMatchObject({ refusal:'Worktree does not match its repo' });
});
it('a running agent must be stopped first; once stopped its worktree may go', async () => {
 const { temp, repo, paths } = await fixture(), cli = join(temp, 'cli.sh');
 await writeFile(cli, '#!/bin/sh\necho ready\nexec sleep 30\n'); await chmod(cli, 0o755); engine.path = cli;
 const sessions = await manager(paths), agent = await sessions.create({ engine:'codex', model:null, auth:{ kind:'account' }, cwd:repo, permission:'ask', title:'busy' }), path = agent.worktree ?? '';
 await expect.poll(() => sessions.get(agent.id).status).toBe('running');
 const view = await sessions.checkWorktree(path);
 expect(view).toMatchObject({ refusal:'Stop the agent first', agent:{ id:agent.id, status:'running' } });
 await expect(sessions.deleteWorktree(path, 'f'.repeat(64))).rejects.toThrow('Stop the agent first'); expect(await listed(repo, path)).toBe(true);
 await sessions.stop(agent.id); const stopped = await sessions.checkWorktree(path); expect(stopped.refusal).toBeUndefined();
 await sessions.deleteWorktree(path, stopped.fingerprint ?? ''); expect(await listed(repo, path)).toBe(false);
});
it('clean path: plain remove and -d delete exactly that worktree and branch', async () => {
 const { repo, paths } = await fixture(), sessions = await manager(paths), a = await finishedAgent(sessions, repo, 'a'), b = await finishedAgent(sessions, repo, 'b'), before = await checkout(repo);
 await writeFile(join(a.worktree, 'ignored-cache'), 'x');
 const view = await sessions.checkWorktree(a.worktree); expect(view.loss).toMatchObject({ changed:0, untracked:0, ignored:1, commits:0 });
 await sessions.deleteWorktree(a.worktree, view.fingerprint ?? '');
 await expect(lstat(a.worktree)).rejects.toMatchObject({ code:'ENOENT' }); expect(await branchNames(repo)).toEqual(['ai/b', 'main']);
 expect(await listed(repo, b.worktree)).toBe(true); expect(await checkout(repo)).toBe(before);
 expect((await sessions.worktreeViews()).map(v => v.path)).toEqual([b.worktree]);
 expect(sessions.get(a.id).worktree).toBe(a.worktree);
});
it('confirmed-loss path needs the typed branch and an unchanged fingerprint, then forces exactly that worktree and branch', async () => {
 const { repo, paths } = await fixture(), sessions = await manager(paths), agent = await finishedAgent(sessions, repo), before = await checkout(repo);
 await writeFile(join(agent.worktree, 'notes.txt'), 'draft'); await git(agent.worktree, 'commit', '-q', '--allow-empty', '-m', 'work', '--');
 const view = await sessions.checkWorktree(agent.worktree); expect(view.loss).toMatchObject({ untracked:1, commits:1 });
 await expect(sessions.deleteWorktree(agent.worktree, view.fingerprint ?? '')).rejects.toThrow('Type the branch name to confirm');
 await expect(sessions.deleteWorktree(agent.worktree, view.fingerprint ?? '', 'ai/other')).rejects.toThrow('Type the branch name to confirm');
 await writeFile(join(agent.worktree, 'more.txt'), 'later');
 await expect(sessions.deleteWorktree(agent.worktree, view.fingerprint ?? '', 'ai/agent')).rejects.toThrow('Changed since you confirmed; check again');
 expect(await readFile(join(agent.worktree, 'notes.txt'), 'utf8')).toBe('draft'); expect(await branchNames(repo)).toContain('ai/agent');
 const fresh = await sessions.checkWorktree(agent.worktree); await sessions.deleteWorktree(agent.worktree, fresh.fingerprint ?? '', 'ai/agent');
 await expect(lstat(agent.worktree)).rejects.toMatchObject({ code:'ENOENT' }); expect(await branchNames(repo)).toEqual(['main']); expect(await checkout(repo)).toBe(before);
});
it('a clean worktree that changed after it was shown is refused without a confirmation', async () => {
 const { repo, paths } = await fixture(), sessions = await manager(paths), agent = await finishedAgent(sessions, repo), view = await sessions.checkWorktree(agent.worktree);
 await writeFile(join(agent.worktree, 'late.txt'), 'new');
 await expect(sessions.deleteWorktree(agent.worktree, view.fingerprint ?? '')).rejects.toThrow('Changed since you confirmed; check again');
 expect(await readFile(join(agent.worktree, 'late.txt'), 'utf8')).toBe('new');
});
it('a worktree folder deleted by hand is cleaned up through git', async () => {
 const { repo, paths } = await fixture(), sessions = await manager(paths), agent = await finishedAgent(sessions, repo), before = await checkout(repo);
 await rm(agent.worktree, { recursive:true, force:true });
 const view = await sessions.checkWorktree(agent.worktree); expect(view.loss).toMatchObject({ missing:true, commits:0 });
 await sessions.deleteWorktree(agent.worktree, view.fingerprint ?? '');
 expect(await listed(repo, agent.worktree)).toBe(false); expect(await branchNames(repo)).toEqual(['main']); expect(await checkout(repo)).toBe(before);
});
it('refuses a locked worktree and a branch checked out elsewhere before touching anything', async () => {
 const { temp, repo, paths } = await fixture(), sessions = await manager(paths), agent = await finishedAgent(sessions, repo);
 await git(repo, 'worktree', 'lock', '--', agent.worktree);
 const locked = await sessions.checkWorktree(agent.worktree); expect(locked).toMatchObject({ refusal:'Worktree is locked', loss:{ commits:0 } });
 await expect(sessions.deleteWorktree(agent.worktree, locked.fingerprint ?? '', 'ai/agent')).rejects.toThrow('Worktree is locked');
 await git(repo, 'worktree', 'unlock', '--', agent.worktree);
 const second = join(temp, 'second'); await git(repo, 'worktree', 'add', '-q', '--detach', '--', second, 'HEAD'); await git(second, 'checkout', '-q', '--ignore-other-worktrees', 'ai/agent');
 const elsewhere = await sessions.checkWorktree(agent.worktree); expect(elsewhere.refusal).toBe('Branch is checked out elsewhere');
 await expect(sessions.deleteWorktree(agent.worktree, elsewhere.fingerprint ?? '', 'ai/agent')).rejects.toThrow('Branch is checked out elsewhere');
 expect(await listed(repo, agent.worktree)).toBe(true); expect(await branchNames(repo)).toContain('ai/agent');
});
it('a renamed branch is refused: AI Term deletes only the branch it made', async () => {
 const { repo, paths } = await fixture(), sessions = await manager(paths), agent = await finishedAgent(sessions, repo);
 await git(agent.worktree, 'branch', '-m', '--', 'ai/agent', 'keep-me');
 expect(await sessions.checkWorktree(agent.worktree)).toMatchObject({ refusal:'Worktree is not on its ai/ branch' });
 expect(await branchNames(repo)).toEqual(['keep-me', 'main']);
});
it('a failing branch step stops after the worktree step and reports which step failed', async () => {
 const { repo, paths } = await fixture(), sessions = await manager(paths), agent = await finishedAgent(sessions, repo), before = await checkout(repo);
 // A stale ref lock makes git refuse to update the branch; the check cannot see it.
 await writeFile(join(repo, '.git', 'refs', 'heads', 'ai', 'agent.lock'), '');
 const view = await sessions.checkWorktree(agent.worktree);
 await expect(sessions.deleteWorktree(agent.worktree, view.fingerprint ?? '')).rejects.toThrow('Worktree removed; branch delete failed');
 expect(await listed(repo, agent.worktree)).toBe(false); expect(await branchNames(repo)).toContain('ai/agent'); expect(await checkout(repo)).toBe(before);
 expect(await sessions.worktreeViews()).toEqual([]);
});
it('a resume and a delete of the same worktree never overlap', async () => {
 const { repo, paths } = await fixture(), sessions = await manager(paths), agent = await finishedAgent(sessions, repo), view = await sessions.checkWorktree(agent.worktree);
 const deleting = sessions.deleteWorktree(agent.worktree, view.fingerprint ?? '');
 await expect(sessions.resume(agent.id)).rejects.toThrow('Worktree is busy');
 await deleting; expect(await listed(repo, agent.worktree)).toBe(false);
});
it('an invalid stored record is skipped with a log line and its folder is kept', async () => {
 const { repo, home, paths } = await fixture(), started = await prepareWorktree(home, repo, 'agent');
 await writeState(paths, [{ path:'relative/path', branch:'main', createdAt:'x' }, { path:started.worktree, branch:started.branch, repo:await realpath(repo), createdAt:new Date().toISOString() }]);
 const sessions = await manager(paths);
 expect((await sessions.worktreeViews()).map(v => basename(v.path))).toEqual(['agent']);
 expect(await readFile(paths.log, 'utf8')).toContain('Invalid worktree record skipped; that worktree is kept');
});
it('hidden index changes and exclude-file tricks need the typed confirmation instead of one keypress', async () => {
 const { repo, paths } = await fixture(), sessions = await manager(paths), agent = await finishedAgent(sessions, repo);
 await writeFile(join(agent.worktree, 'tracked.txt'), 'edited'); await git(agent.worktree, 'update-index', '--assume-unchanged', '--', 'tracked.txt');
 await writeFile(join(agent.worktree, 'notes.md'), 'work'); await writeFile(join(repo, '.git', 'info', 'exclude'), '*\n');
 const view = await sessions.checkWorktree(agent.worktree); expect(view.loss).toMatchObject({ changed:1, untracked:1 });
 await expect(sessions.deleteWorktree(agent.worktree, view.fingerprint ?? '')).rejects.toThrow('Type the branch name to confirm');
 expect(await readFile(join(agent.worktree, 'tracked.txt'), 'utf8')).toBe('edited'); expect(await readFile(join(agent.worktree, 'notes.md'), 'utf8')).toBe('work');
});
