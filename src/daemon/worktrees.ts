import { createHash } from 'node:crypto';
import { basename, join, relative, resolve, sep } from 'node:path';
import { lstat, mkdir, realpath, readdir, chmod } from 'node:fs/promises';
import { privateDirectory, isFsError } from '../shared/paths.js';
import { availableWorktreeSlug, isSafeAbsolutePath, worktreeSlug } from '../shared/validate.js';
import type { WorktreePreview } from '../shared/protocol.js';
import { addWorktree, branchNames, checkoutDirty, currentBranch, GitError, headCommit, repoTopLevel } from './git.js';

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
export function prepareWorktree(root: string, cwd: string, title: string): Promise<WorktreeStart> {
    return serialize(root, () => create(root, cwd, title));
}
async function create(root: string, cwd: string, title: string): Promise<WorktreeStart> {
    const plan = await inspect(root, cwd, title);
    if (!plan.top || !plan.head || !plan.branch) return {cwd, worktreeNote: plan.note ?? 'worktree off: git check failed'};
    try {
        if (!isSafeAbsolutePath(root)) throw new Error('Unsafe worktree root');
        await privateDirectory(root);
        const canonical = await realpath(root), worktrees = join(canonical, 'worktrees');
        await privateDirectory(worktrees);
        const repo = join(worktrees, repoDirectory(plan.top)); await privateDirectory(repo);
        const used = await occupied(canonical, plan.top);
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
            catch (error) { if ((await branchNames(plan.top)).includes(branch)) continue; throw error; }
            await chmod(path, 0o700);
            const subfolder = relative(plan.top, await realpath(cwd));
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
            if (!inside(path, await realpath(target))) throw new Error('Unsafe worktree cwd');
            return {cwd: target, worktree: path, branch, repo: plan.top, baseCommit: plan.head, ...(baseBranch ? {baseBranch} : {})};
        }
    } catch { return {cwd, worktreeNote: 'worktree off: creation failed'}; }
    return {cwd, worktreeNote: 'worktree off: creation failed'};
}
