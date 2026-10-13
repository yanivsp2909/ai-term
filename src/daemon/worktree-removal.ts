import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { SessionInfo, WorktreeLoss, WorktreeRecord, WorktreeRefusal, WorktreeView } from '../shared/protocol.js';
import { isFsError } from '../shared/paths.js';
import { isSafeAbsolutePath, isWorktreeBranch } from '../shared/validate.js';
import { deleteBranch, forceDeleteBranch, forceRemoveWorktree, GitError, inspectWorktree, removeWorktree, repoCommonDir } from './git.js';
import { repoDirectory } from './worktrees.js';

export type WorktreeDeleteError = WorktreeRefusal | 'Type the branch name to confirm' | 'Changed since you confirmed; check again' |
    'Worktree remove failed; branch kept' | 'Worktree removed; branch delete failed';
export const WORKTREE_DELETE_ERRORS: readonly WorktreeDeleteError[] = ["Not in AI Term's record", 'Outside the worktrees folder', 'Path has a symlink', 'Original repo unknown',
    'Worktree does not match its repo', 'Main checkout is never deleted', 'Git does not list this worktree', 'Worktree is not on its ai/ branch', 'Worktree is locked',
    'Branch is checked out elsewhere', 'Stop the agent first', 'Worktree is busy', 'Git check failed', 'Type the branch name to confirm',
    'Changed since you confirmed; check again', 'Worktree remove failed; branch kept', 'Worktree removed; branch delete failed'];
export class WorktreeError extends Error { constructor(message: WorktreeDeleteError) { super(message); } }
type Agent = Pick<SessionInfo, 'id' | 'title' | 'status'>;
export function wouldLose(loss: WorktreeLoss): boolean { return loss.changed + loss.untracked + loss.commits > 0; }

async function realDirectory(path: string): Promise<WorktreeRefusal | null> {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return 'Path has a symlink';
    return stat.isDirectory() && stat.uid === process.getuid?.() ? null : 'Outside the worktrees folder';
}
// The path must be exactly <canonical root>/worktrees/<repo folder>/<slug of its branch>, with no symlink in any part of it.
// A worktree folder deleted by hand may be absent; its parent folders may not.
async function placement(root: string, record: WorktreeRecord): Promise<WorktreeRefusal | null> {
    if (!isSafeAbsolutePath(record.path) || !isWorktreeBranch(record.branch)) return 'Outside the worktrees folder';
    let worktrees: string;
    try { worktrees = join(await realpath(root), 'worktrees'); }
    catch (error) { if (isFsError(error, 'ENOENT')) return 'Outside the worktrees folder'; throw error; }
    const repoFolder = dirname(record.path);
    if (dirname(repoFolder) !== worktrees || basename(record.path) !== record.branch.slice(3)) return 'Outside the worktrees folder';
    try {
        for (const folder of [worktrees, repoFolder]) { const refused = await realDirectory(folder); if (refused) return refused; }
        if (await realpath(repoFolder) !== repoFolder) return 'Path has a symlink';
    } catch (error) { if (isFsError(error, 'ENOENT')) return 'Outside the worktrees folder'; throw error; }
    try {
        const refused = await realDirectory(record.path); if (refused) return refused;
        if (await realpath(record.path) !== record.path) return 'Path has a symlink';
    } catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
    return null;
}
// The recorded repo must hash to the folder AI Term made for it. Older records ask the worktree itself, and git's answer
// must pass the same hash check, so a rewritten .git file cannot point the check at another repository.
async function originalRepo(record: WorktreeRecord): Promise<{ repo: string } | { refusal: WorktreeRefusal }> {
    const folder = basename(dirname(record.path));
    if (record.repo) return repoDirectory(record.repo) === folder ? { repo: record.repo } : { refusal: 'Worktree does not match its repo' };
    try {
        const common = await repoCommonDir(record.path);
        if (basename(common) !== '.git') return { refusal: 'Original repo unknown' };
        const top = await realpath(dirname(common));
        return repoDirectory(top) === folder ? { repo: top } : { refusal: 'Original repo unknown' };
    } catch (error) { if (error instanceof GitError || isFsError(error, 'ENOENT')) return { refusal: 'Original repo unknown' }; throw error; }
}
export interface WorktreeCheck { view: WorktreeView; repo?: string }
// Read-only. Anything that is not provably AI Term's own, finished, unlocked worktree on its own branch gets a fixed refusal.
export async function checkWorktree(root: string, record: WorktreeRecord, agent: Agent | undefined, busy: boolean): Promise<WorktreeCheck> {
    const view: WorktreeView = { path: record.path, branch: record.branch, ...(agent ? { agent: { id: agent.id, title: agent.title, status: agent.status } } : {}) };
    const refuse = (refusal: WorktreeRefusal, extra: Partial<WorktreeView> = {}): WorktreeCheck => ({ view: { ...view, ...extra, refusal } });
    if (record.repo && record.path === record.repo) return refuse('Main checkout is never deleted');
    const placed = await placement(root, record);
    if (placed) return refuse(placed);
    if (agent && !['exited', 'error'].includes(agent.status)) return refuse('Stop the agent first');
    if (busy) return refuse('Worktree is busy');
    const original = await originalRepo(record);
    if ('refusal' in original) return refuse(original.refusal);
    const { repo } = original;
    let found;
    try { found = await inspectWorktree(repo, record.path, record.branch, { ...(record.baseBranch ? { branch: record.baseBranch } : {}), ...(record.baseCommit ? { commit: record.baseCommit } : {}) }); }
    catch (error) { if (error instanceof GitError) return refuse('Git check failed'); throw error; }
    if (!found) return refuse('Git does not list this worktree');
    if (found.main) return refuse('Main checkout is never deleted');
    if (!found.matchesRepo) return refuse('Worktree does not match its repo');
    if (!found.onBranch) return refuse('Worktree is not on its ai/ branch');
    const loss: WorktreeLoss = { changed: found.changed, untracked: found.untracked, ignored: found.ignored, commits: found.commits, base: found.base, baseSource: found.baseSource, missing: found.missing };
    if (found.locked) return refuse('Worktree is locked', { loss });
    if (found.elsewhere) return refuse('Branch is checked out elsewhere', { loss });
    return { view: { ...view, loss, fingerprint: found.fingerprint }, repo };
}
// Rechecks right before acting. Clean: plain remove, then -d. Loss: --force and -D only with the typed branch name and the
// fingerprint of the loss the user was shown. A failing step stops; nothing outside this worktree and branch is touched.
export async function deleteWorktree(root: string, record: WorktreeRecord, agent: Agent | undefined, request: { fingerprint: string; confirm?: string }): Promise<void> {
    const { view, repo } = await checkWorktree(root, record, agent, false);
    if (view.refusal || !repo || !view.loss) throw new WorktreeError(view.refusal ?? 'Git check failed');
    const lossy = wouldLose(view.loss);
    if (request.fingerprint !== view.fingerprint) throw new WorktreeError('Changed since you confirmed; check again');
    if (lossy && request.confirm !== record.branch) throw new WorktreeError('Type the branch name to confirm');
    try { if (lossy) await forceRemoveWorktree(repo, record.path); else await removeWorktree(repo, record.path); }
    catch (error) { if (error instanceof GitError) throw new WorktreeError('Worktree remove failed; branch kept'); throw error; }
    try { if (lossy) await forceDeleteBranch(repo, record.branch); else await deleteBranch(repo, record.branch); }
    catch (error) { if (error instanceof GitError) throw new WorktreeError('Worktree removed; branch delete failed'); throw error; }
}
const MAX_LISTED = 500;
// Folders in the worktrees root that no record claims, such as those whose v0.3.1 agent was removed. Listed, never deleted.
export async function unrecordedFolders(root: string, recorded: ReadonlySet<string>): Promise<string[]> {
    const found: string[] = [];
    let worktrees: string;
    try { worktrees = join(await realpath(root), 'worktrees'); if (await realDirectory(worktrees)) return []; }
    catch (error) { if (isFsError(error, 'ENOENT')) return []; throw error; }
    for (const repoName of (await readdir(worktrees)).sort()) {
        const repoFolder = join(worktrees, repoName);
        if (await realDirectory(repoFolder)) continue;
        for (const name of (await readdir(repoFolder)).sort()) {
            const path = join(repoFolder, name);
            if (found.length >= MAX_LISTED) return found;
            if (!recorded.has(path) && isSafeAbsolutePath(path) && !await realDirectory(path)) found.push(path);
        }
    }
    return found;
}
