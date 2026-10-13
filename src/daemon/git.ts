import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isFsError } from '../shared/paths.js';
import { isPlainBranch, isSafeAbsolutePath, isWorktreeBranch } from '../shared/validate.js';

export class GitError extends Error {
    constructor(message: 'Git check failed' | 'Repo has no commits' | 'Worktree creation failed' | 'Worktree remove failed' | 'Branch delete failed') { super(message); }
}
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// An explicit env prevents inherited GIT_DIR/GIT_WORK_TREE, hooks and routing from targeting a different checkout.
function run(cwd: string, args: string[], failure: ConstructorParameters<typeof GitError>[0] = 'Git check failed', maxBuffer = 1024 * 1024): Promise<string> {
    if (!isSafeAbsolutePath(cwd)) return Promise.reject(new GitError(failure));
    return new Promise((resolve, reject) => {
        execFile('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', ...args], {
            // Optional locks off: a read-only status must not rewrite the agent's index while it is inspected.
            cwd, env: { PATH: '/usr/bin:/bin', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
            timeout: 10_000, maxBuffer, encoding: 'utf8',
        }, (error, stdout) => error ? reject(new GitError(failure)) : resolve(stdout));
    });
}
export async function repoTopLevel(cwd: string): Promise<string | null> {
    // No positional refs or paths here: cwd is an execFile option, not a git argument.
    let top: string;
    try { top = (await run(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel'])).replace(/\n$/, ''); }
    catch (error) {
        // Both non-repositories and bare repos lack a working checkout; callers fall back in place.
        try { await run(cwd, ['rev-parse', '--is-inside-work-tree']); } catch { return null; }
        throw error;
    }
    if (!isSafeAbsolutePath(top)) throw new GitError('Git check failed');
    return realpath(top);
}
export async function headCommit(cwd: string): Promise<string> {
    // show defaults to HEAD; unlike rev-parse --verify it accepts -- without treating HEAD as a path.
    const head = (await run(cwd, ['show', '--no-patch', '--format=%H', '--'], 'Repo has no commits')).trim();
    if (!COMMIT.test(head)) throw new GitError('Git check failed');
    return head;
}
export async function addWorktree(cwd: string, path: string, branch: string, head: string): Promise<void> {
    if (!isSafeAbsolutePath(path) || !isWorktreeBranch(branch) || !COMMIT.test(head)) throw new GitError('Worktree creation failed');
    // -b is an option value (git has no --branch spelling); all positional paths/revisions follow --.
    await run(cwd, ['worktree', 'add', `-b${branch}`, '--', path, head], 'Worktree creation failed');
}
export interface GitWorktree { path: string; head?: string; branch?: string; locked?: boolean; prunable?: boolean }
export async function listWorktrees(cwd: string): Promise<GitWorktree[]> {
    const raw = await run(cwd, ['worktree', 'list', '--porcelain', '-z', '--']);
    return raw.split('\0\0').filter(Boolean).map(record => {
        const fields = record.split('\0'), path = fields.find(field => field.startsWith('worktree '))?.slice(9);
        if (!path || !isSafeAbsolutePath(path)) throw new GitError('Git check failed');
        const head = fields.find(field => field.startsWith('HEAD '))?.slice(5), branch = fields.find(field => field.startsWith('branch refs/heads/'))?.slice(18);
        // "locked" and "prunable" may carry a reason after a space; prunable means git found the folder gone.
        const flag = (name: string) => fields.some(field => field === name || field.startsWith(`${name} `));
        return { path, ...(head ? { head } : {}), ...(branch ? { branch } : {}), ...(flag('locked') ? { locked: true } : {}), ...(flag('prunable') ? { prunable: true } : {}) };
    });
}
// The branch the checkout at top has now, when it is a plain name; undefined for a detached HEAD.
export async function currentBranch(top: string): Promise<string | undefined> {
    const branch = (await listWorktrees(top)).find(entry => entry.path === top)?.branch;
    return isPlainBranch(branch) ? branch : undefined;
}
export async function branchNames(cwd: string): Promise<string[]> {
    return (await run(cwd, ['for-each-ref', '--format=%(refname)', '--', 'refs/heads/'])).trim().split('\n').filter(ref=>ref.startsWith('refs/heads/')).map(ref=>ref.slice(11));
}
export async function checkoutDirty(cwd: string): Promise<boolean> {
    return (await run(cwd, ['status', '--porcelain', '--untracked-files=normal', '--'])).length > 0;
}
// A worktree reports its own top level and the repository it belongs to; an agent can rewrite its .git file, so both are compared.
async function identity(cwd: string): Promise<{ top: string; common: string }> {
    const [top, common, rest] = (await run(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'])).split('\n');
    if (!isSafeAbsolutePath(top) || !isSafeAbsolutePath(common) || rest !== '') throw new GitError('Git check failed');
    return { top, common };
}
export async function repoCommonDir(cwd: string): Promise<string> { return (await identity(cwd)).common; }
interface Changes { changed: number; untracked: number; ignored: number; raw: string }
async function changes(path: string): Promise<Changes> {
    // -z keeps names with newlines intact; a rename or copy carries its old name as one extra field.
    const raw = await run(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--'], 'Git check failed', 16 * 1024 * 1024);
    const fields = raw.split('\0'), counts = { changed: 0, untracked: 0, ignored: 0, raw };
    for (let i = 0; i < fields.length; i++) {
        const entry = fields[i] ?? '';
        if (!entry) continue;
        if (entry.length < 4 || entry[2] !== ' ') throw new GitError('Git check failed');
        const code = entry.slice(0, 2);
        if (code === '??') counts.untracked++;
        else if (code === '!!') counts.ignored++;
        else { counts.changed++; if (/[RC]/.test(code)) i++; }
    }
    return counts;
}
// for-each-ref takes the branch as a pattern after --, and its ahead-behind atom counts commits on it that the base lacks.
async function commitsAhead(repo: string, branch: string, base: string): Promise<number> {
    const out = await run(repo, ['for-each-ref', `--format=%(ahead-behind:${base})`, '--', `refs/heads/${branch}`]);
    const match = out.match(/^(\d+) \d+\n$/);
    if (!match?.[1]) throw new GitError('Git check failed');
    return Number(match[1]);
}
export interface WorktreeBase { branch?: string; commit?: string }
export interface WorktreeInspection {
    main: boolean; locked: boolean; missing: boolean; onBranch: boolean; elsewhere: boolean; matchesRepo: boolean;
    changed: number; untracked: number; ignored: number; commits: number;
    base: string; baseSource: 'recorded' | 'start commit' | 'checkout'; fingerprint: string;
}
async function resolveBase(repo: string, listed: GitWorktree[], base: WorktreeBase): Promise<{ ref: string; label: string; source: WorktreeInspection['baseSource'] }> {
    const branches = await branchNames(repo), commit = base.commit && COMMIT.test(base.commit) ? base.commit : undefined;
    if (isPlainBranch(base.branch) && branches.includes(base.branch)) return { ref: `refs/heads/${base.branch}`, label: base.branch, source: 'recorded' };
    if (commit) return { ref: commit, label: commit.slice(0, 7), source: base.branch ? 'start commit' : 'recorded' };
    // Older records have no base: compare with what the original checkout has now.
    const current = listed.find(entry => entry.path === repo)?.branch;
    if (isPlainBranch(current) && branches.includes(current)) return { ref: `refs/heads/${current}`, label: current, source: 'checkout' };
    return { ref: 'HEAD', label: 'HEAD', source: 'checkout' };
}
async function folderMissing(path: string): Promise<boolean> {
    try { await lstat(path); return false; } catch (error) { if (isFsError(error, 'ENOENT')) return true; throw error; }
}
// Reports what deleting this worktree and its branch would lose. Read-only: null when the original repo does not list the path.
export async function inspectWorktree(repo: string, path: string, branch: string, base: WorktreeBase): Promise<WorktreeInspection | null> {
    if (!isSafeAbsolutePath(path) || !isWorktreeBranch(branch)) throw new GitError('Git check failed');
    const listed = await listWorktrees(repo), entry = listed.find(item => item.path === path);
    if (!entry) return null;
    const main = listed[0]?.path === path || path === repo, missing = Boolean(entry.prunable) || await folderMissing(path);
    const result: WorktreeInspection = {
        main, locked: Boolean(entry.locked), missing, onBranch: entry.branch === branch, elsewhere: listed.some(item => item !== entry && item.branch === branch),
        matchesRepo: true, changed: 0, untracked: 0, ignored: 0, commits: 0, base: '', baseSource: 'recorded', fingerprint: '',
    };
    if (main) return result;
    let raw = '';
    if (!missing) {
        const [own, original] = await Promise.all([identity(path).catch(() => null), identity(repo)]);
        result.matchesRepo = own !== null && own.top === path && own.common === original.common;
        if (!result.matchesRepo) return result;
        const found = await changes(path);
        result.changed = found.changed; result.untracked = found.untracked; result.ignored = found.ignored; raw = found.raw;
    }
    const resolved = await resolveBase(repo, listed, base);
    result.base = resolved.label; result.baseSource = resolved.source;
    if ((await branchNames(repo)).includes(branch)) result.commits = await commitsAhead(repo, branch, resolved.ref);
    result.fingerprint = createHash('sha256').update(JSON.stringify([entry.head ?? '', raw, result.commits, resolved.ref, result.locked, missing])).digest('hex');
    return result;
}
// Deletion argv (architecture S14). Plain remove and -d let git refuse dirty trees and unmerged branches by itself;
// the forced pair is called only after the user typed the branch name for the exact loss they were shown.
function deletable(path: string): void { if (!isSafeAbsolutePath(path)) throw new GitError('Worktree remove failed'); }
export async function removeWorktree(repo: string, path: string): Promise<void> { deletable(path); await run(repo, ['worktree', 'remove', '--', path], 'Worktree remove failed'); }
export async function forceRemoveWorktree(repo: string, path: string): Promise<void> { deletable(path); await run(repo, ['worktree', 'remove', '--force', '--', path], 'Worktree remove failed'); }
export async function deleteBranch(repo: string, branch: string): Promise<void> { if (!isWorktreeBranch(branch)) throw new GitError('Branch delete failed'); await run(repo, ['branch', '-d', '--', branch], 'Branch delete failed'); }
export async function forceDeleteBranch(repo: string, branch: string): Promise<void> { if (!isWorktreeBranch(branch)) throw new GitError('Branch delete failed'); await run(repo, ['branch', '-D', '--', branch], 'Branch delete failed'); }
