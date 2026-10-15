import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isFsError } from '../shared/paths.js';
import { isWorktreeBranch } from '../shared/validate.js';
import { UNDO_SHOWN, type UndoChange, type UndoPlan } from '../shared/checkpoints.js';
import { blobBytes, COMMIT_ID, GitError, insideWorktree, isolatedGitDir, runGit, type IsolatedGit } from './git.js';

// v0.7.2 checkpoints (D55, on): after each agent turn the worktree's files are saved as a commit of their own under
// refs/ai-term/checkpoints/<slug>/<n>. Every step runs through a private git dir (isolatedGitDir) with a temporary
// index, so the agent's index, branch and HEAD never change and nothing in the repo's config can run. The commits'
// objects go into the repository's store; only these refs keep them, and they go when the worktree goes.
export const MAX_CHECKPOINTS = 50;
export class CheckpointError extends Error {}
// The fixed words a client may see (the server passes only these on).
export const CHECKPOINT_ERRORS = ['Checkpoints are off · /settings u turns them on', 'Stop or wait for the agent first; it is running', 'Stop or wait for the agent first; it is asking',
  'This agent has no worktree; checkpoints need one', 'Undo unavailable; git could not read the worktree', 'Nothing to redo', 'No checkpoint to go back to', 'Nothing to change; the worktree already matches it',
  'Changed since you looked; run /undo again', 'Changed since you looked; run /redo again', 'A folder in the worktree is a symlink; nothing was restored', 'Invalid checkpoint name'];
const AUTHOR = { GIT_AUTHOR_NAME: 'AI Term', GIT_AUTHOR_EMAIL: 'checkpoint@ai-term.invalid', GIT_COMMITTER_NAME: 'AI Term', GIT_COMMITTER_EMAIL: 'checkpoint@ai-term.invalid' };
const BIG = 16 * 1024 * 1024;
function slugOk(slug: string): void { if (!isWorktreeBranch(`ai/${slug}`)) throw new CheckpointError('Invalid checkpoint name'); }
const prefix = (slug: string) => `refs/ai-term/checkpoints/${slug}/`, redoRef = (slug: string) => `refs/ai-term/redo/${slug}`;
// Refs live in the shared repository folder; git is pointed at it directly, without a work tree.
const refsGit = (common: string, args: string[], env: Record<string, string> = {}) => runGit(common, [`--git-dir=${common}`, ...args], 'Git check failed', { env, maxBuffer: BIG });

export interface Checkpoint { n: number; commit: string; tree: string; at: string }
async function list(common: string, slug: string): Promise<Checkpoint[]> {
  const out = await refsGit(common, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(tree)%00%(committerdate:iso-strict)', '--', prefix(slug)]);
  return out.split('\n').filter(Boolean).flatMap(line => {
    const [ref, commit, tree, at] = line.split('\0'), n = Number(ref?.slice(prefix(slug).length));
    return Number.isSafeInteger(n) && n > 0 && COMMIT_ID.test(commit ?? '') && COMMIT_ID.test(tree ?? '') ? [{ n, commit: commit ?? '', tree: tree ?? '', at: at ?? '' }] : [];
  }).sort((a, b) => a.n - b.n);
}
// The worktree as it is now, as a tree in the repository's store: a private copy of the agent's index, `add -A`
// (untracked files included, ignored ones not), write-tree.
async function currentTree(path: string, git: IsolatedGit): Promise<string> {
  await runGit(path, [...git.args, 'add', '-A', '--', '.'], 'Git check failed', { env: git.env, maxBuffer: BIG, timeout: 120_000 });
  const tree = (await runGit(path, [...git.args, 'write-tree'], 'Git check failed', { env: git.env })).trim();
  if (!COMMIT_ID.test(tree)) throw new GitError('Git check failed');
  return tree;
}
async function commitTree(path: string, git: IsolatedGit, tree: string, message: string): Promise<string> {
  const commit = (await runGit(path, [...git.args, 'commit-tree', '-m', message, '--end-of-options', tree], 'Git check failed', { env: { ...git.env, ...AUTHOR } })).trim();
  if (!COMMIT_ID.test(commit)) throw new GitError('Git check failed');
  return commit;
}
async function withGit<T>(path: string, use: (git: IsolatedGit) => Promise<T>): Promise<T> {
  const git = await isolatedGitDir(path, undefined, { writes: true });
  try { return await use(git); } finally { await git.dispose(); }
}
export async function listCheckpoints(path: string, slug: string): Promise<Checkpoint[]> {
  slugOk(slug);
  return withGit(path, git => list(git.common, slug));
}
// A new checkpoint, unless nothing changed since the last one (then null). The oldest beyond 50 go; a new turn also
// ends what /redo could bring back.
export async function snapshot(path: string, slug: string): Promise<{ n: number; commit: string; tree: string } | null> {
  slugOk(slug);
  return withGit(path, async git => {
    const tree = await currentTree(path, git), existing = await list(git.common, slug), last = existing.at(-1);
    if (last?.tree === tree) return null;
    const n = (last?.n ?? 0) + 1, commit = await commitTree(path, git, tree, `AI Term checkpoint ${n}`);
    await refsGit(git.common, ['update-ref', '-m', 'AI Term checkpoint', `${prefix(slug)}${n}`, commit]);
    for (const old of existing.slice(0, Math.max(0, existing.length + 1 - MAX_CHECKPOINTS))) await refsGit(git.common, ['update-ref', '-d', `${prefix(slug)}${old.n}`]);
    await dropRedo(git.common, slug);
    return { n, commit, tree };
  });
}
async function redoTarget(common: string, slug: string): Promise<{ commit: string; tree: string; at: string } | null> {
  const out = (await refsGit(common, ['for-each-ref', '--format=%(objectname)%00%(tree)%00%(committerdate:iso-strict)', '--', redoRef(slug)])).trim();
  const [commit, tree, at] = out.split('\0');
  return commit && tree && COMMIT_ID.test(commit) && COMMIT_ID.test(tree) ? { commit, tree, at: at ?? '' } : null;
}
async function dropRedo(common: string, slug: string): Promise<void> { if (await redoTarget(common, slug)) await refsGit(common, ['update-ref', '-d', redoRef(slug)]); }
// What changes between the worktree now and the target, from the trees alone (no file is read here).
async function changes(path: string, git: IsolatedGit, from: string, to: string): Promise<UndoChange[]> {
  const fields = (await runGit(path, [...git.args, 'diff-tree', '-r', '--no-renames', '--no-ext-diff', '--no-textconv', '-z', '--name-status', '--end-of-options', from, to], 'Git check failed', { env: git.env, maxBuffer: BIG })).split('\0');
  const out: UndoChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const code = fields[i] ?? '', name = fields[i + 1] ?? '';
    if (!code) break;
    if (!insideWorktree(name)) throw new GitError('Git check failed');
    out.push({ path: name, change: code === 'A' ? 'restored' : code === 'D' ? 'removed' : 'modified' });
  }
  return out;
}
interface Resolved { tree: string; current: string; target: { commit: string; tree: string; at: string; n: number | null }; all: UndoChange[]; fingerprint: string }
async function resolve(path: string, slug: string, kind: 'undo' | 'redo', git: IsolatedGit): Promise<Resolved> {
  const current = await currentTree(path, git);
  let target: Resolved['target'];
  if (kind === 'redo') {
    const redo = await redoTarget(git.common, slug);
    if (!redo) throw new CheckpointError('Nothing to redo');
    target = { ...redo, n: null };
  } else {
    // Changed since the last checkpoint: back to it. Unchanged: back to the one before.
    const all = await list(git.common, slug), last = all.at(-1), pick = last && last.tree !== current ? last : all.at(-2);
    if (!pick) throw new CheckpointError('No checkpoint to go back to');
    target = pick;
  }
  if (target.tree === current) throw new CheckpointError('Nothing to change; the worktree already matches it');
  const all = await changes(path, git, current, target.tree);
  return { tree: target.tree, current, target, all, fingerprint: createHash('sha256').update(`${kind}\0${current}\0${target.commit}`).digest('hex') };
}
export async function undoPlan(path: string, slug: string, kind: 'undo' | 'redo', title = slug): Promise<UndoPlan> {
  slugOk(slug);
  return withGit(path, async git => {
    const r = await resolve(path, slug, kind, git);
    return { kind, title, target: r.target.n, targetAt: r.target.at, changes: r.all.slice(0, UNDO_SHOWN), more: Math.max(0, r.all.length - UNDO_SHOWN), fingerprint: r.fingerprint };
  });
}
// Every folder on the way to a path must be a real folder inside the worktree (or not exist yet): a symlinked folder
// would send a write or a delete outside it.
async function checkParents(root: string, name: string): Promise<void> {
  const parts = name.split('/');
  let at = root;
  for (const part of parts.slice(0, -1)) {
    at = join(at, part);
    try { const info = await lstat(at); if (info.isSymbolicLink() || !info.isDirectory()) throw new CheckpointError('A folder in the worktree is a symlink; nothing was restored'); }
    catch (error) { if (isFsError(error, 'ENOENT')) return; throw error; }
  }
}
async function removeFile(path: string): Promise<void> {
  try { const info = await lstat(path); if (!info.isDirectory()) await unlink(path); } catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
}
// Restores the target exactly as the plan showed (the fingerprint must match): first a fresh snapshot of now is kept
// for /redo (undo only), then removed files go, then changed and restored files are written from the target's blobs.
export async function applyUndo(path: string, slug: string, kind: 'undo' | 'redo', fingerprint: string): Promise<{ restored: number }> {
  slugOk(slug);
  return withGit(path, async git => {
    const r = await resolve(path, slug, kind, git).catch((error: unknown) => { throw error instanceof CheckpointError ? new CheckpointError(`Changed since you looked; run /${kind} again`) : error; });
    if (r.fingerprint !== fingerprint) throw new CheckpointError(`Changed since you looked; run /${kind} again`);
    for (const change of r.all) await checkParents(path, change.path);
    const entries = new Map<string, { mode: string; hash: string }>();
    for (const record of (await runGit(path, [...git.args, 'ls-tree', '-r', '-z', '--full-tree', '--end-of-options', r.tree], 'Git check failed', { env: git.env, maxBuffer: BIG })).split('\0')) {
      const match = record.match(/^(\d{6}) (blob|commit) ([0-9a-f]{40,64})\t(.+)$/s);
      if (match?.[1] && match[3] && match[4]) entries.set(match[4], { mode: match[1], hash: match[3] });
    }
    if (kind === 'undo') await refsGit(git.common, ['update-ref', '-m', 'AI Term undo', redoRef(slug), await commitTree(path, git, r.current, `AI Term before undo`)]);
    let restored = 0;
    for (const change of r.all.filter(c => c.change === 'removed')) { await removeFile(join(path, change.path)); restored++; }
    for (const change of r.all.filter(c => c.change !== 'removed')) {
      const entry = entries.get(change.path), target = join(path, change.path);
      // A gitlink (a nested repository) is never written into.
      if (!entry || entry.mode === '160000') continue;
      await mkdir(join(target, '..'), { recursive: true }); await checkParents(path, change.path);
      const content = await blobBytes(path, git.args, entry.hash, git.env);
      await removeFile(target);
      // A symlink is restored as the link it was (its blob is the target path); nothing is followed.
      if (entry.mode === '120000') await symlink(content.toString('utf8'), target);
      else { const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, entry.mode === '100755' ? 0o755 : 0o644); try { await file.writeFile(content); } finally { await file.close(); } }
      restored++;
    }
    if (kind === 'redo') await refsGit(git.common, ['update-ref', '-d', redoRef(slug)]);
    return { restored };
  });
}
// The worktree went away: its checkpoints and its redo go with it.
export async function dropCheckpoints(repo: string, slug: string): Promise<void> {
  slugOk(slug);
  await withGit(repo, async git => {
    for (const checkpoint of await list(git.common, slug)) await refsGit(git.common, ['update-ref', '-d', `${prefix(slug)}${checkpoint.n}`]);
    await dropRedo(git.common, slug);
  });
}
