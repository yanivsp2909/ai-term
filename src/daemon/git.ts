import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isFsError } from '../shared/paths.js';
import { isPlainBranch, isSafeAbsolutePath, isWorktreeBranch } from '../shared/validate.js';
import { GIT, GIT_PATH, GIT_SYSTEM } from './git-path.js';
import { ownTempFolder } from './own-temp.js';

export class GitError extends Error {
    constructor(message: 'Git check failed' | 'Repo has no commits' | 'Worktree creation failed' | 'Worktree remove failed' | 'Branch delete failed' | 'Not a git repo' | 'Diff too large') { super(message); }
}
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// An explicit env prevents inherited GIT_DIR/GIT_WORK_TREE, hooks and routing from targeting a different checkout.
// notRepo: git's own "not a git repository" answer becomes GitError('Not a git repo'), so callers can tell it from a failure.
// env: extra variables for one call (v0.7.2 checkpoints: GIT_OBJECT_DIRECTORY and a fixed author), on top of the fixed env.
// signal: a stopped /bisect or A/B stops its copy's clone and checkout too (backlog F1 review).
interface RunOptions { maxBuffer?: number; timeout?: number; input?: string; literal?: boolean; notRepo?: boolean; env?: Record<string, string>; signal?: AbortSignal }
function run(cwd: string, args: string[], failure: ConstructorParameters<typeof GitError>[0] = 'Git check failed', { maxBuffer = 1024 * 1024, timeout = 10_000, input, literal = true, notRepo = false, env: extra = {}, signal }: RunOptions = {}): Promise<string> {
    // No git found (Windows without Git for Windows): fail plainly rather than run a bare name.
    const git = GIT;
    if (!isSafeAbsolutePath(cwd) || !git) return Promise.reject(new GitError(failure));
    return new Promise((resolve, reject) => {
        // log.showSignature off: with it a repo's config would make show run gpg.program.
        const child = execFile(git, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', '-c', 'log.showSignature=false', ...args], {
            // Optional locks off: a read-only status must not rewrite the agent's index while it is inspected.
            // Literal pathspecs: file names from a repo reach ls-files/check-ignore after --, and ":(...)" magic must stay a name.
            cwd, windowsHide: true, env: { PATH: GIT_PATH, ...GIT_SYSTEM, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', ...(literal ? { GIT_LITERAL_PATHSPECS: '1' } : {}), ...extra },
            timeout, maxBuffer, encoding: 'utf8', ...(signal ? { signal } : {}),
        // The env has no LANG, so git's messages are its fixed English ones; stderr is matched here and never logged.
        }, (error, stdout, stderr) => error ? reject(new GitError(notRepo && typeof error.code === 'number' && /not a git repository/.test(stderr) ? 'Not a git repo' : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'Diff too large' : failure)) : resolve(stdout));
        // A failed stdin write (git exited early) surfaces through the exit callback above.
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(input ?? '');
    });
}
export async function repoTopLevel(cwd: string): Promise<string | null> {
    // No positional refs or paths here: cwd is an execFile option, not a git argument.
    let top: string;
    // Only git's own "not a git repository" means none: a timeout, an unsafe path, a bare repo or an ownership refusal is
    // a failure, so the agent's card says the check failed instead of quietly running without a worktree.
    try { top = (await run(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel'], 'Git check failed', { notRepo: true })).replace(/\n$/, ''); }
    catch (error) { if (error instanceof GitError && error.message === 'Not a git repo') return null; throw error; }
    if (!isSafeAbsolutePath(top)) throw new GitError('Git check failed');
    return realpath(top);
}
// v1.0.2 /brain: the files git would show, tracked and untracked, without what .gitignore (and the like) leaves out.
export async function listFiles(top: string): Promise<string[]> {
    const out = await run(top, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], 'Git check failed', { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
    return [...new Set(out.split('\0').filter(Boolean))];
}
export async function headCommit(cwd: string): Promise<string> {
    // show defaults to HEAD; unlike rev-parse --verify it accepts -- without treating HEAD as a path.
    const head = (await run(cwd, ['show', '--no-patch', '--format=%H', '--'], 'Repo has no commits')).trim();
    if (!COMMIT.test(head)) throw new GitError('Git check failed');
    return head;
}
// v0.7.4: whether id names a commit in this repository (an id only: never a branch name or an expression).
export async function isCommit(cwd: string, id: string): Promise<boolean> {
    if (!COMMIT.test(id)) return false;
    try { return (await run(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${id}^{commit}`], 'Git check failed')).trim() === id; }
    catch (error) { if (error instanceof GitError) return false; throw error; }
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
    // Submodules are never entered: a populated one has its own config, whose filters status would run.
    return (await run(cwd, ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all', '--'])).length > 0;
}
// A worktree reports its own top level, admin dir and the repository it belongs to; an agent can rewrite its .git file, so all are compared.
async function identity(cwd: string): Promise<{ top: string; common: string; gitDir: string }> {
    const [top, common, gitDir, rest] = (await run(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--absolute-git-dir'])).split('\n');
    if (!isSafeAbsolutePath(top) || !isSafeAbsolutePath(common) || !isSafeAbsolutePath(gitDir) || rest !== '') throw new GitError('Git check failed');
    return { top, common, gitDir };
}
// git records each linked worktree's own .git path in <admin dir>/gitdir; a .git file borrowed from a sibling points back elsewhere.
async function ownsAdminDir(path: string, gitDir: string): Promise<boolean> {
    const recorded = await readFile(join(gitDir, 'gitdir'), 'utf8').catch((error: unknown) => { if (isFsError(error, 'ENOENT')) return ''; throw error; });
    return recorded.replace(/\n$/, '') === join(path, '.git');
}
export async function repoCommonDir(cwd: string): Promise<string> { return (await identity(cwd)).common; }
interface Changes { changed: number; untracked: number; ignored: number; repos: number; raw: string }
const BIG = 16 * 1024 * 1024, CHUNK = 200;
// Index entries flagged assume-unchanged (lowercase tag) or skip-worktree (S) are invisible to status, and plain
// git worktree remove trusts status too, so any such entry counts as changed.
async function hiddenEntries(path: string): Promise<{ count: number; raw: string }> {
    const raw = await run(path, ['ls-files', '-v', '-z', '--'], 'Git check failed', { maxBuffer: BIG });
    return { count: raw.split('\0').filter(entry => entry && (entry[0] === 'S' || /^[a-z]/.test(entry))).length, raw };
}
// Ignore rules in info/exclude, core.excludesFile or an uncommitted .gitignore can be written from inside the worktree,
// so they could turn any work into "ignored". Only a match from a .gitignore committed in the repo keeps a path ignored.
async function committedIgnores(path: string, ignored: string[]): Promise<number> {
    // Names go through stdin (-z needs --stdin); output is source, line, pattern, name per match. check-ignore refuses
    // literal pathspec mode, so each name is prefixed with ./ instead, which keeps a leading ":(...)" from being magic.
    const input = ignored.map(name => `./${name}\0`).join(''), sources = new Map<string, string>();
    const fields = (await run(path, ['check-ignore', '-v', '-z', '--stdin'], 'Git check failed', { maxBuffer: BIG, input, literal: false })).split('\0');
    for (let j = 0; j + 3 < fields.length; j += 4) sources.set((fields[j + 3] ?? '').replace(/^\.\//, ''), fields[j] ?? '');
    const candidates = [...new Set(sources.values())].filter(source => source && !isAbsolute(source) && basename(source) === '.gitignore'), tracked = new Set<string>();
    for (let i = 0; i < candidates.length; i += CHUNK)
        for (const name of (await run(path, ['ls-files', '-z', '--', ...candidates.slice(i, i + CHUNK)], 'Git check failed', { maxBuffer: BIG })).split('\0')) if (name) tracked.add(name);
    return ignored.filter(name => tracked.has(sources.get(name) ?? '')).length;
}
// Submodule folders (gitlinks). status no longer looks inside them: a populated one runs git with its own config, which
// the agent can write (filters run outside any sandbox), and files in an unpopulated one are invisible to git anyway and
// would go with a plain remove. So any gitlink folder holding something, or replaced by anything else, counts as changed:
// it goes with the worktree, which needs the typed branch name. An empty folder or a missing one loses nothing.
async function gitlinks(path: string): Promise<{ count: number; raw: string }> {
    let count = 0, raw = '';
    for (const entry of (await run(path, ['ls-files', '-s', '-z', '--'], 'Git check failed', { maxBuffer: BIG })).split('\0')) {
        if (!entry.startsWith('160000 ')) continue;
        const name = entry.slice(entry.indexOf('\t') + 1), folder = join(path, name);
        let info;
        try { info = await lstat(folder); } catch (error) { if (isFsError(error, 'ENOENT') || isFsError(error, 'ENOTDIR')) continue; throw error; }
        const inside = info.isDirectory() ? (await readdir(folder)).sort() : null;
        if (!inside || inside.length) { count++; raw += `\0${name}\0${inside?.join('/') ?? 'not a folder'}`; }
    }
    return { count, raw };
}
async function changes(path: string): Promise<Changes> {
    // -z keeps names with newlines intact; a rename or copy carries its old name as one extra field.
    const raw = await run(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=all', '--'], 'Git check failed', { maxBuffer: BIG });
    const fields = raw.split('\0'), counts = { changed: 0, untracked: 0, ignored: 0, repos: 0, raw }, ignored: string[] = [];
    for (let i = 0; i < fields.length; i++) {
        const entry = fields[i] ?? '';
        if (!entry) continue;
        if (entry.length < 4 || entry[2] !== ' ') throw new GitError('Git check failed');
        const code = entry.slice(0, 2);
        // With --untracked-files=all only a nested repository stays a folder entry; its whole history goes with it.
        if (code === '??') { counts.untracked++; if (entry.endsWith('/')) counts.repos++; }
        else if (code === '!!') ignored.push(entry.slice(3));
        else { counts.changed++; if (/[RC]/.test(code)) i++; }
    }
    const hidden = await hiddenEntries(path), links = await gitlinks(path), kept = ignored.length ? await committedIgnores(path, ignored) : 0;
    counts.changed += hidden.count + links.count; counts.ignored = kept; counts.untracked += ignored.length - kept; counts.raw += `\0\0${hidden.raw}\0\0${links.raw}`;
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
    changed: number; untracked: number; ignored: number; repos: number; commits: number;
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
    // Git also calls a worktree prunable when only its .git file is gone; the folder (and any work in it) may still be
    // there, so only the folder itself decides "missing". Without .git it then fails the identity check and is refused.
    const main = listed[0]?.path === path || path === repo, missing = await folderMissing(path);
    const result: WorktreeInspection = {
        main, locked: Boolean(entry.locked), missing, onBranch: entry.branch === branch, elsewhere: listed.some(item => item !== entry && item.branch === branch),
        matchesRepo: true, changed: 0, untracked: 0, ignored: 0, repos: 0, commits: 0, base: '', baseSource: 'recorded', fingerprint: '',
    };
    if (main) return result;
    let raw = '';
    if (!missing) {
        const [own, original] = await Promise.all([identity(path).catch(() => null), identity(repo)]);
        result.matchesRepo = own !== null && own.top === path && own.common === original.common && await ownsAdminDir(path, own.gitDir);
        if (!result.matchesRepo) return result;
        const found = await changes(path);
        result.changed = found.changed; result.untracked = found.untracked; result.ignored = found.ignored; result.repos = found.repos; raw = found.raw;
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
// A large tree takes a while to delete; a timeout part way through would leave it half removed.
const REMOVE_TIMEOUT = 300_000;
export async function removeWorktree(repo: string, path: string): Promise<void> { deletable(path); await run(repo, ['worktree', 'remove', '--', path], 'Worktree remove failed', { timeout: REMOVE_TIMEOUT }); }
export async function forceRemoveWorktree(repo: string, path: string): Promise<void> { deletable(path); await run(repo, ['worktree', 'remove', '--force', '--', path], 'Worktree remove failed', { timeout: REMOVE_TIMEOUT }); }
export async function deleteBranch(repo: string, branch: string): Promise<void> { if (!isWorktreeBranch(branch)) throw new GitError('Branch delete failed'); await run(repo, ['branch', '-d', '--', branch], 'Branch delete failed'); }
export async function forceDeleteBranch(repo: string, branch: string): Promise<void> { if (!isWorktreeBranch(branch)) throw new GitError('Branch delete failed'); await run(repo, ['branch', '-D', '--', branch], 'Branch delete failed'); }

// v0.7.1 diff (read-only). A repo's config could name an external diff or textconv command, so both are off; colour and
// submodules too. The base is a commit id checked here, and --end-of-options keeps it from ever reading as an option.
const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--ignore-submodules=all'];
// Comparing the working tree runs any clean filter its attributes name: a command from the repo's config, which an agent
// can write, even between two git calls (a check of the config, then the diff, is a race it can win). So the diff never
// reads the repo's config or info/ at all: each one runs against a private git dir of AI Term's (made by
// `isolatedGitDir`): a minimal config, the repo's objects through `alternates`, a copy of the worktree's index. No
// filter, driver or hook can be defined there; attributes come from the empty tree and no attributes file is read.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export { run as runGit, COMMIT as COMMIT_ID, EMPTY_TREE as EMPTY_TREE_ID };
// A blob's exact bytes (v0.7.2 restore): same fixed env and options as run(), output kept as bytes, never decoded.
export function blobBytes(cwd: string, args: string[], hash: string, env: Record<string, string>): Promise<Buffer> {
    const git = GIT;
    if (!isSafeAbsolutePath(cwd) || !COMMIT.test(hash) || !git) return Promise.reject(new GitError('Git check failed'));
    return new Promise((resolve, reject) => {
        execFile(git, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', '-c', 'log.showSignature=false', ...args, 'cat-file', 'blob', hash], {
            cwd, windowsHide: true, env: { PATH: GIT_PATH, ...GIT_SYSTEM, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', ...env },
            timeout: 60_000, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer',
        }, (error, stdout) => error ? reject(new GitError('Git check failed')) : resolve(stdout));
    });
}
// common: the repository's shared git folder (refs live there); env: what a call that writes objects needs (writes).
// A small regular file's text (64 KiB at most), or '' when it isn't one: a FIFO or a device would hang or flood a read.
async function smallText(path: string): Promise<string> {
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) { if (isFsError(error, 'ENOENT') || isFsError(error, 'ELOOP')) return ''; throw error; }
    try {
        if (!(await file.stat()).isFile()) return '';
        const buffer = Buffer.alloc(64 * 1024), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await file.close(); }
}
export interface IsolatedGit { args: string[]; common: string; env: Record<string, string>; dispose(): Promise<void> }
// base: a commit for HEAD and the hash format (diffs); none for a snapshot. writes: new objects go straight into the
// repository's own object store (checkpoints must outlive this folder), still without reading its config.
// repo: the repository AI Term recorded for this worktree. The worktree's own `.git` file and its admin dir's
// `commondir` are the agent's to write, so they must lead back to exactly that repository (v0.7.2 review), or nothing
// is read from or written to anywhere they point.
export async function isolatedGitDir(path: string, base?: string, options: { writes?: boolean; repo?: string } = {}): Promise<IsolatedGit> {
    if (!isSafeAbsolutePath(path) || base !== undefined && !COMMIT.test(base)) throw new GitError('Git check failed');
    // Where the worktree's git data is, read from its files (no git, so no config is read): `.git` is the main repo's
    // folder, or a file `gitdir: <admin dir>` whose `commondir` names the shared repository.
    const dotGit = join(path, '.git'), info = await lstat(dotGit);
    let gitDir: string;
    if (info.isDirectory()) gitDir = dotGit;
    else if (info.isFile()) { const target = (await readFile(dotGit, 'utf8')).match(/^gitdir: ([^\n]+)\n?$/)?.[1]; if (!target) throw new GitError('Git check failed'); gitDir = resolve(path, target); }
    else throw new GitError('Git check failed');
    const common = await readFile(join(gitDir, 'commondir'), 'utf8').then(text => resolve(gitDir, text.trim()), (error: unknown) => { if (isFsError(error, 'ENOENT')) return gitDir; throw error; });
    if (!isSafeAbsolutePath(gitDir) || !isSafeAbsolutePath(common)) throw new GitError('Git check failed');
    if (options.repo !== undefined) {
        // The worktree folder itself must be the real one: a symlink in its place could lead to a sibling worktree.
        if (await realpath(path) !== path) throw new GitError('Git check failed');
        const expected = await realpath(join(options.repo, '.git')), real = await realpath(common);
        if (real !== expected || gitDir !== dotGit && dirname(await realpath(gitDir)) !== join(expected, 'worktrees')) throw new GitError('Git check failed');
    }
    const temp = await ownTempFolder('diff', tmpdir());
    try {
        await mkdir(join(temp, 'objects', 'info'), { recursive: true }); await mkdir(join(temp, 'refs'));
        // The hash format: from the base, else from the repository's config, read as text (git never reads it here).
        const sha256 = base ? base.length === 64 : /objectformat\s*=\s*sha256/i.test(await smallText(join(common, 'config')));
        await writeFile(join(temp, 'config'), `[core]\n\trepositoryformatversion = ${sha256 ? 1 : 0}\n\tbare = false\n${sha256 ? '[extensions]\n\tobjectformat = sha256\n' : ''}`, { mode: 0o600 });
        await writeFile(join(temp, 'HEAD'), base ? `${base}\n` : 'ref: refs/heads/ai-term-snapshot\n', { mode: 0o600 });
        // The repository's own ignore list (info/exclude) is plain text, copied so a snapshot skips what git status skips.
        await mkdir(join(temp, 'info'));
        try { const exclude = join(common, 'info', 'exclude'); if ((await lstat(exclude)).isFile()) await copyFile(exclude, join(temp, 'info', 'exclude')); } catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
        // AI Term's own restore staging folder (v0.7.2) is never part of a snapshot or a diff.
        await writeFile(join(temp, 'info', 'exclude'), '\n/.ai-term-restore-*/\n', { flag: 'a', mode: 0o600 });
        await writeFile(join(temp, 'objects', 'info', 'alternates'), `${join(common, 'objects')}\n`, { mode: 0o600 });
        // The index tells git which files are tracked (and lets it skip unchanged ones); only a regular file is copied.
        // Its times are kept: git reads a file again when its entry is as new as the index file ("racily clean"), and a
        // copy with a fresh mtime would hide a same-size edit made in the second the index was written (B34).
        const copyIndex = async (from: string, to: string): Promise<void> => { const stat = await lstat(from); if (!stat.isFile()) return; await copyFile(from, to); await utimes(to, stat.atime, stat.mtime); };
        try { await copyIndex(join(gitDir, 'index'), join(temp, 'index')); } catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
        // A split index keeps most entries in sharedindex.<hash> beside it (core.splitIndex, feature.manyFiles).
        for (const name of await readdir(gitDir)) if (/^sharedindex\.[0-9a-f]{40,64}$/.test(name)) await copyIndex(join(gitDir, name), join(temp, name));
    } catch (error) { await rm(temp, { recursive: true, force: true }); throw error; }
    const objects = join(common, 'objects');
    return { args: [`--git-dir=${temp}`, `--work-tree=${path}`, `--attr-source=${EMPTY_TREE}`, '-c', 'core.attributesFile=/dev/null'], common, env: options.writes ? { GIT_OBJECT_DIRECTORY: objects } : {}, dispose: () => rm(temp, { recursive: true, force: true }) };
}
export interface NameStatus { code: string; path: string; from?: string }
// The agent can write its own index, and git doesn't check names when it loads one: an entry named ../x would make the
// diff show a file outside the worktree. Every name git lists must stay inside, or nothing is shown at all.
export function insideWorktree(name: string): boolean { return !!name && !isAbsolute(name) && !name.split('/').some(part => part === '..' || part.toLowerCase() === '.git'); }
export async function diffNameStatus(path: string, base: string, git: IsolatedGit): Promise<NameStatus[]> {
    if (!COMMIT.test(base)) throw new GitError('Git check failed');
    const fields = (await run(path, [...git.args, 'diff', ...DIFF_FLAGS, '--name-status', '-z', '--end-of-options', base, '--'], 'Git check failed', { maxBuffer: BIG })).split('\0'), out: NameStatus[] = [];
    // R and C carry a score and two names (old, then new); the rest one name.
    for (let i = 0; i < fields.length - 1;) {
        const code = fields[i] ?? '', two = /^[RC]/.test(code), first = fields[i + 1] ?? '', second = two ? fields[i + 2] ?? '' : '';
        if (!code) break;
        const entry = two ? { code: code[0] ?? 'M', path: second, from: first } : { code: code[0] ?? 'M', path: first };
        if (!insideWorktree(entry.path) || entry.from !== undefined && !insideWorktree(entry.from)) throw new GitError('Git check failed');
        out.push(entry);
        i += two ? 3 : 2;
    }
    return out;
}
// The unified diff itself, capped at 32 MiB of git output (larger: 'Diff too large', and only the file list is shown).
export async function diffPatch(path: string, base: string, git: IsolatedGit): Promise<string> {
    if (!COMMIT.test(base)) throw new GitError('Git check failed');
    return run(path, [...git.args, 'diff', ...DIFF_FLAGS, '--unified=3', '--end-of-options', base, '--'], 'Git check failed', { maxBuffer: 32 * 1024 * 1024, timeout: 30_000 });
}
export async function diffNumstat(path: string, base: string, git: IsolatedGit): Promise<{ added: number; removed: number; files: number }> {
    if (!COMMIT.test(base)) throw new GitError('Git check failed');
    const stat = { added: 0, removed: 0, files: 0 };
    for (const line of (await run(path, [...git.args, 'diff', ...DIFF_FLAGS, '--numstat', '--end-of-options', base, '--'], 'Git check failed', { maxBuffer: BIG })).split('\n')) {
        const match = line.match(/^(\d+|-)\t(\d+|-)\t/);
        if (!match) continue;
        stat.files++; stat.added += Number(match[1]) || 0; stat.removed += Number(match[2]) || 0;
    }
    return stat;
}
// Untracked files that aren't ignored (the repo's own ignore rules; no global ones, GIT_CONFIG_GLOBAL is /dev/null).
export async function untrackedFiles(path: string, git: IsolatedGit): Promise<string[]> {
    const names = (await run(path, [...git.args, 'ls-files', '--others', '--exclude-standard', '-z', '--'], 'Git check failed', { maxBuffer: BIG })).split('\0').filter(Boolean);
    if (names.some(name => !insideWorktree(name))) throw new GitError('Git check failed');
    return names;
}
export async function isWorktreeTop(path: string): Promise<boolean> { return (await identity(path).catch(() => null))?.top === path; }
