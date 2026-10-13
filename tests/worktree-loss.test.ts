import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectWorktree } from '../src/daemon/git.js';
const run = promisify(execFile), roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, {recursive:true,force:true}); });
const git = (cwd: string, ...args: string[]) => run('/usr/bin/git', ['-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false',...args], {cwd});
const commit = (cwd: string, message: string) => git(cwd, 'commit', '--allow-empty', '-q', '-m', message, '--');
// A repo on main with tracked a.txt and c.txt, an ignore rule, and one linked worktree on ai/agent made from HEAD.
async function fixture() {
 const temp = await realpath(await mkdtemp(join(tmpdir(), 'ai-loss-'))); roots.push(temp);
 const repo = join(temp, 'repo spaces'), wt = join(temp, 'tree spaces');
 await mkdir(repo); await git(temp, 'init', '-q', '-b', 'main', '--', repo);
 await writeFile(join(repo, 'a.txt'), 'a'); await writeFile(join(repo, 'c.txt'), 'c'); await writeFile(join(repo, '.gitignore'), 'ignored*\n');
 await git(repo, 'add', '--', 'a.txt', 'c.txt', '.gitignore'); await commit(repo, 'initial');
 const head = (await git(repo, 'show', '--no-patch', '--format=%H', '--')).stdout.trim();
 await git(repo, 'worktree', 'add', '-q', '-bai/agent', '--', wt, head);
 return { temp, repo, wt, head, base: { branch: 'main', commit: head } };
}
const status = async (repo: string) => (await git(repo, 'status', '--porcelain', '--untracked-files=all', '--ignored', '--')).stdout;

it('a fresh worktree loses nothing and counts against the recorded base branch', async () => {
 const { repo, wt, base } = await fixture();
 expect(await inspectWorktree(repo, wt, 'ai/agent', base)).toMatchObject({ main:false, locked:false, missing:false, onBranch:true, elsewhere:false, matchesRepo:true, changed:0, untracked:0, ignored:0, commits:0, base:'main', baseSource:'recorded' });
});
it('counts modified, staged and deleted files as changed', async () => {
 const { repo, wt, base } = await fixture();
 await writeFile(join(wt, 'a.txt'), 'edited'); await writeFile(join(wt, 'b.txt'), 'new'); await git(wt, 'add', '--', 'b.txt'); await unlink(join(wt, 'c.txt'));
 expect(await inspectWorktree(repo, wt, 'ai/agent', base)).toMatchObject({ changed:3, untracked:0, commits:0 });
});
it('counts each untracked file; ignored files are reported but are not untracked', async () => {
 const { repo, wt, base } = await fixture();
 await mkdir(join(wt, 'new dir')); await writeFile(join(wt, 'new dir', 'one'), '1'); await writeFile(join(wt, 'new dir', 'two\nlines'), '2'); await writeFile(join(wt, 'ignored-local'), 'secret');
 expect(await inspectWorktree(repo, wt, 'ai/agent', base)).toMatchObject({ changed:0, untracked:2, ignored:1, commits:0 });
});
it('counts commits on the branch that are not in the base', async () => {
 const { repo, wt, base } = await fixture();
 await commit(wt, 'one'); await commit(wt, 'two');
 expect(await inspectWorktree(repo, wt, 'ai/agent', base)).toMatchObject({ changed:0, untracked:0, commits:2, base:'main' });
});
it('reports every kind of loss at once, with a renamed staged file counted once', async () => {
 const { repo, wt, base } = await fixture();
 await commit(wt, 'one'); await git(wt, 'mv', '--', 'a.txt', 'renamed.txt'); await writeFile(join(wt, 'c.txt'), 'edited'); await writeFile(join(wt, 'loose'), 'x'); await writeFile(join(wt, 'ignored-1'), 'x');
 expect(await inspectWorktree(repo, wt, 'ai/agent', base)).toMatchObject({ changed:2, untracked:1, ignored:1, commits:1 });
});
it('a branch merged into its base is safe, and a base that moved forward does not count its own commits', async () => {
 const { repo, wt, base } = await fixture();
 await commit(wt, 'agent work'); await git(repo, 'merge', '-q', '--ff-only', 'ai/agent');
 expect(await inspectWorktree(repo, wt, 'ai/agent', base)).toMatchObject({ commits:0 });
 await commit(repo, 'main moves on'); await commit(repo, 'and again');
 expect(await inspectWorktree(repo, wt, 'ai/agent', base)).toMatchObject({ commits:0, base:'main' });
 await commit(wt, 'unmerged'); expect(await inspectWorktree(repo, wt, 'ai/agent', base)).toMatchObject({ commits:1 });
});
it('a deleted base branch falls back to the start commit and says so', async () => {
 const { repo, wt, head } = await fixture();
 await git(repo, 'branch', '-q', '--', 'feature'); await commit(wt, 'work'); await git(repo, 'branch', '-q', '-D', '--', 'feature');
 expect(await inspectWorktree(repo, wt, 'ai/agent', { branch:'feature', commit:head })).toMatchObject({ commits:1, base:head.slice(0, 7), baseSource:'start commit' });
});
it('an older record without a base uses the checkout current branch and says so', async () => {
 const { repo, wt } = await fixture();
 await commit(wt, 'work'); await git(repo, 'switch', '-q', '-c', 'other');
 expect(await inspectWorktree(repo, wt, 'ai/agent', {})).toMatchObject({ commits:1, base:'other', baseSource:'checkout' });
});
it('a worktree folder deleted by hand is missing, with no files to lose but its commits still counted', async () => {
 const { repo, wt, base } = await fixture();
 await commit(wt, 'work'); await rm(wt, { recursive:true, force:true });
 expect(await inspectWorktree(repo, wt, 'ai/agent', base)).toMatchObject({ missing:true, changed:0, untracked:0, ignored:0, commits:1 });
});
it('reports a locked worktree and a branch checked out somewhere else', async () => {
 const { repo, wt, base } = await fixture();
 await git(repo, 'worktree', 'lock', '--', wt);
 expect(await inspectWorktree(repo, wt, 'ai/agent', base)).toMatchObject({ locked:true, elsewhere:false });
 await git(repo, 'worktree', 'unlock', '--', wt); await git(repo, 'checkout', '-q', '--ignore-other-worktrees', 'ai/agent');
 expect(await inspectWorktree(repo, wt, 'ai/agent', base)).toMatchObject({ locked:false, elsewhere:true, onBranch:true });
});
it('a renamed or switched branch is no longer on ai/<slug>', async () => {
 const { repo, wt, base } = await fixture();
 await git(wt, 'branch', '-m', '--', 'ai/agent', 'renamed');
 expect(await inspectWorktree(repo, wt, 'ai/agent', base)).toMatchObject({ onBranch:false });
});
it('a path git does not list and the main checkout are told apart', async () => {
 const { temp, repo, base } = await fixture();
 expect(await inspectWorktree(repo, join(temp, 'elsewhere'), 'ai/agent', base)).toBeNull();
 expect(await inspectWorktree(repo, repo, 'ai/agent', base)).toMatchObject({ main:true });
});
it('a .git file rewritten to point at another repo does not match', async () => {
 const { temp, repo, wt, base } = await fixture(), other = join(temp, 'other');
 await mkdir(other); await git(temp, 'init', '-q', '-b', 'main', '--', other); await commit(other, 'other');
 await writeFile(join(wt, '.git'), `gitdir: ${join(other, '.git')}\n`);
 expect(await inspectWorktree(repo, wt, 'ai/agent', base)).toMatchObject({ matchesRepo:false });
});
it('the fingerprint changes when what would be lost changes, and inspection never changes the checkout', async () => {
 const { repo, wt, base } = await fixture(), before = await status(repo);
 const first = await inspectWorktree(repo, wt, 'ai/agent', base); await writeFile(join(wt, 'loose'), 'x');
 const second = await inspectWorktree(repo, wt, 'ai/agent', base); await commit(wt, 'c');
 const third = await inspectWorktree(repo, wt, 'ai/agent', base);
 expect(new Set([first?.fingerprint, second?.fingerprint, third?.fingerprint]).size).toBe(3);
 expect(await inspectWorktree(repo, wt, 'ai/agent', base)).toMatchObject({ fingerprint:third?.fingerprint });
 expect(await status(repo)).toBe(before);
});
