import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isSafeAbsolutePath, isWorktreeBranch } from '../shared/validate.js';

export class GitError extends Error {
    constructor(message: 'Git check failed' | 'Repo has no commits' | 'Worktree creation failed') { super(message); }
}
// An explicit env prevents inherited GIT_DIR/GIT_WORK_TREE, hooks and routing from targeting a different checkout.
function run(cwd: string, args: string[], failure: ConstructorParameters<typeof GitError>[0] = 'Git check failed'): Promise<string> {
    if (!isSafeAbsolutePath(cwd)) return Promise.reject(new GitError(failure));
    return new Promise((resolve, reject) => {
        execFile('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', ...args], {
            cwd, env: { PATH: '/usr/bin:/bin', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
            timeout: 10_000, maxBuffer: 1024 * 1024, encoding: 'utf8',
        }, (error, stdout) => error ? reject(new GitError(failure)) : resolve(stdout));
    });
}
export async function repoTopLevel(cwd: string): Promise<string | null> {
    // No positional refs or paths here: cwd is an execFile option, not a git argument.
    let top: string;
    try { top = (await run(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel'])).trimEnd(); }
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
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) throw new GitError('Git check failed');
    return head;
}
export async function addWorktree(cwd: string, path: string, branch: string, head: string): Promise<void> {
    if (!isSafeAbsolutePath(path) || !isWorktreeBranch(branch) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) throw new GitError('Worktree creation failed');
    // -b is an option value (git has no --branch spelling); all positional paths/revisions follow --.
    await run(cwd, ['worktree', 'add', `-b${branch}`, '--', path, head], 'Worktree creation failed');
}
export interface GitWorktree { path: string; head?: string; branch?: string }
export async function listWorktrees(cwd: string): Promise<GitWorktree[]> {
    const raw = await run(cwd, ['worktree', 'list', '--porcelain', '-z', '--']);
    return raw.split('\0\0').filter(Boolean).map(record => {
        const fields = record.split('\0'), path = fields.find(field => field.startsWith('worktree '))?.slice(9);
        if (!path || !isSafeAbsolutePath(path)) throw new GitError('Git check failed');
        const head = fields.find(field => field.startsWith('HEAD '))?.slice(5), branch = fields.find(field => field.startsWith('branch refs/heads/'))?.slice(18);
        return { path, ...(head ? { head } : {}), ...(branch ? { branch } : {}) };
    });
}
export async function branchNames(cwd: string): Promise<string[]> {
    return (await run(cwd, ['for-each-ref', '--format=%(refname)', '--', 'refs/heads/'])).trim().split('\n').filter(ref=>ref.startsWith('refs/heads/')).map(ref=>ref.slice(11));
}
export async function checkoutDirty(cwd: string): Promise<boolean> {
    return (await run(cwd, ['status', '--porcelain', '--untracked-files=normal', '--'])).length > 0;
}
