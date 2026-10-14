import { createHash } from 'node:crypto';
import { basename, join, relative, resolve, sep } from 'node:path';
import { lstat, mkdir, realpath, readdir, chmod, rmdir } from 'node:fs/promises';
import { privateDirectory, isFsError } from '../shared/paths.js';
import { availableWorktreeSlug, isSafeAbsolutePath, worktreeSlug } from '../shared/validate.js';
import type { WorktreePreview } from '../shared/protocol.js';
import { addWorktree, branchNames, checkoutDirty, currentBranch, deleteBranch, GitError, headCommit, removeWorktree, repoTopLevel } from './git.js';

const queues = new Map<string, Promise<unknown>>();
export function repoDirectory(top: string): string {
    return `${worktreeSlug(basename(top))}-${createHash('sha256').update(top).digest('hex').slice(0, 10)}`;
}
function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep); }
async function occupied(root: string, top: string): Promise<Set<string>> {
    const names = new Set((await branchNames(top)).filter(b => b.startsWith('ai/')).map(b => b.slice(3)));
    try {
        for(const dir of [root,join(root,'worktrees'),join(root,'worktrees',repoDirectory(top))]){
            const stat=await lstat(dir);if(stat.isSymbolicLink()||!stat.isDirectory()||stat.uid!==process.getuid?.())throw new Error('Unsafe worktree directory');
        }
        for (const name of await readdir(join(root, 'worktrees', repoDirectory(top)))) names.add(name);
    }
    catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
    return names;
}
async function inspect(root: string, cwd: string, title: string): Promise<WorktreePreview & {top?: string}> {
    try {
        const top = await repoTopLevel(cwd);
        if (!top) return { note: 'worktree off: not a git repo' };
        const head = await headCommit(top), dirty = await checkoutDirty(top);
        const slug = availableWorktreeSlug(title, await occupied(root, top));
        return { top, head, dirty, branch: `ai/${slug}` };
    } catch (error) { return { note: error instanceof GitError && error.message === 'Repo has no commits' ? 'worktree off: repo has no commits' : 'worktree off: git check failed' }; }
}
export async function previewWorktree(root: string, cwd: string, title: string): Promise<WorktreePreview> {
    const { top: _top, ...preview } = await inspect(root, cwd, title); void _top; return preview;
}
// repo and base are for the daemon's worktree record only; they never become session fields.
export interface WorktreeStart {cwd: string; worktree?: string; branch?: string; worktreeNote?: import('../shared/protocol.js').WorktreeNote; repo?: string; baseBranch?: string; baseCommit?: string}
// Starts and deletions from different socket clients share one queue per home, so a slug is never reused mid-deletion.
export function serialize<T>(root: string, task: () => Promise<T>): Promise<T> {
    const next = (queues.get(root) ?? Promise.resolve()).then(task);
    const settled = next.then(() => undefined, () => undefined); queues.set(root, settled);
    void settled.then(() => { if (queues.get(root) === settled) queues.delete(root); });
    return next;
}
// `log` gets fixed lines only: a failed start, and anything a rollback had to leave behind.
export function prepareWorktree(root: string, cwd: string, title: string, log: (text: string) => void = () => {}): Promise<WorktreeStart> {
    return serialize(root, () => create(root, cwd, title, log));
}
// Undoes a start that failed part way: the plain remove and -d refuse anything with work in it, and the folder is
// removed only when empty. What can't be undone is logged, since it would show up in /worktrees unrecorded.
async function rollback(top: string, path: string, branch: string, added: boolean, log: (text: string) => void): Promise<void> {
    if (added) { try { await removeWorktree(top, path); } catch { log('Worktree start rollback: worktree left in place'); } }
    try { if ((await branchNames(top)).includes(branch)) await deleteBranch(top, branch); } catch { log('Worktree start rollback: branch left in place'); }
    try { await rmdir(path); } catch (error) { if (!isFsError(error, 'ENOENT')) log('Worktree start rollback: folder left in place'); }
}
async function create(root: string, cwd: string, title: string, log: (text: string) => void): Promise<WorktreeStart> {
    const plan = await inspect(root, cwd, title);
    if (!plan.top || !plan.head || !plan.branch) return {cwd, worktreeNote: plan.note ?? 'worktree off: git check failed'};
    try {
        if (!isSafeAbsolutePath(root)) throw new Error('Unsafe worktree root');
        await privateDirectory(root);
        const canonical = await realpath(root), worktrees = join(canonical, 'worktrees');
        await privateDirectory(worktrees);
        const repo = join(worktrees, repoDirectory(plan.top)); await privateDirectory(repo);
        const used = await occupied(canonical, plan.top), existing = new Set(await branchNames(plan.top));
        // Read before anything is created, so a failure here never leaves an unrecorded worktree behind.
        const baseBranch = await currentBranch(plan.top);
        // A concurrent external git process may reserve a branch too. Recheck only collisions; other failures fall back.
        for (let attempt = 0; attempt < 5; attempt++) {
            const slug = availableWorktreeSlug(title, used), branch = `ai/${slug}`, path = join(repo, slug);
            used.add(slug);
            try { await mkdir(path, {mode: 0o700}); }
            catch (error) { if (isFsError(error, 'EEXIST')) continue; throw error; }
            const stat = await lstat(path);
            if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || !inside(worktrees, await realpath(path))) throw new Error('Unsafe worktree path');
            try { await addWorktree(plan.top, path, branch, plan.head); }
            catch (error) {
                // A branch that existed before this attempt is a collision (another git process took the name): try the
                // next slug. One that didn't is git's own half-made branch from the failed add: undo it and stop. (-d refuses
                // a branch with unmerged commits or checked out anywhere, so even a name taken in that instant loses no work.)
                const now = new Set(await branchNames(plan.top));
                if (now.has(branch) && !existing.has(branch)) { await rollback(plan.top, path, branch, false, log); throw error; }
                await rmdir(path).catch((cause: unknown) => { if (!isFsError(cause, 'ENOENT')) log('Worktree start rollback: folder left in place'); });
                if (now.has(branch)) continue;
                throw error;
            }
            try { return await finish(path, branch, plan.top, cwd, worktrees, plan.head, baseBranch); }
            catch (error) { await rollback(plan.top, path, branch, true, log); throw error; }
        }
    } catch { log('Worktree start failed; agent starts in place'); return {cwd, worktreeNote: 'worktree off: creation failed'}; }
    return {cwd, worktreeNote: 'worktree off: creation failed'};
}
// The steps after git added the worktree; a failure here is rolled back by the caller.
async function finish(path: string, branch: string, top: string, cwd: string, worktrees: string, head: string, baseBranch: string | undefined): Promise<WorktreeStart> {
    await chmod(path, 0o700);
    const subfolder = relative(top, await realpath(cwd));
    const target = resolve(path, subfolder);
    if (!inside(path, target)) throw new Error('Unsafe worktree cwd');
    // Validate every selected subfolder without following a repository-controlled symlink.
    let current = path;
    for (const part of subfolder.split(sep).filter(Boolean)) {
        current = join(current, part);
        try{await mkdir(current,{mode:0o700});}catch(error){if(!isFsError(error,'EEXIST'))throw error;}
        const dir = await lstat(current);
        if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('Worktree subfolder unavailable');
        await chmod(current, 0o700);
    }
    if (!inside(path, await realpath(target)) || !inside(worktrees, path)) throw new Error('Unsafe worktree cwd');
    return {cwd: target, worktree: path, branch, repo: top, baseCommit: head, ...(baseBranch ? {baseBranch} : {})};
}
