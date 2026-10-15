import { diffPath } from '../shared/diff.js';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm, rmdir, symlink, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isFsError } from '../shared/paths.js';
import { isWorktreeBranch } from '../shared/validate.js';
import { UNDO_SHOWN, type UndoChange, type UndoPlan } from '../shared/checkpoints.js';
import { blobBytes, COMMIT_ID, GitError, insideWorktree, isolatedGitDir, runGit, untrackedFiles, type IsolatedGit } from './git.js';

// v0.7.2 checkpoints (D55, on): after each agent turn the worktree's files are saved as a commit of their own under
// refs/ai-term/checkpoints/<slug>/<n>. Every step runs through a private git dir (isolatedGitDir) bound to the
// repository AI Term recorded for the worktree, with a temporary index, so the agent's index, branch and HEAD never
// change and nothing in the repo's config can run. The commits' objects go into the repository's store.
// Refs are shared by every worktree of a repository, so another agent could write one: each commit AI Term makes carries
// an HMAC of (kind, slug, tree) under the daemon's own key, and any ref without a valid one is ignored.
export const MAX_CHECKPOINTS = 50, MAX_REDO = 50, MAX_UNTRACKED = 10_000;
export class CheckpointError extends Error {}
// The fixed words a client may see (the server passes only these on).
export const CHECKPOINT_ERRORS = ['Checkpoints are off · /settings u turns them on', 'Stop or wait for the agent first; it is running', 'Stop or wait for the agent first; it is asking',
  'This agent has no worktree; checkpoints need one', 'Tests are running in this worktree; /undo or /redo when they finish', "No checkpoint to go back to; the last checkpoint failed (AI Term's log says why)", 'Undo unavailable; git could not read the worktree', 'Nothing to redo', 'No checkpoint to go back to', 'Nothing to change; the worktree already matches it',
  'Changed since you looked; run /undo again', 'Changed since you looked; run /redo again', 'A folder in the worktree is a symlink; nothing was restored', 'Invalid checkpoint name',
  'Something in the worktree is in the way; nothing was restored', 'Nothing was restored; a checkpoint file could not be read', 'The restore stopped part way; /redo or /undo brings back a saved state',
  'Nothing was restored; the worktree could not be written', 'An ignored file is where the checkpoint has one; nothing was restored'] as const;
// scope: what makes this worktree's checkpoints its own (its record's creation time): a later worktree that reuses the
// name never inherits an earlier one's refs, even if removing them failed.
export interface CheckpointContext { repo: string; key: Buffer; scope?: string }
const AUTHOR = { GIT_AUTHOR_NAME: 'AI Term', GIT_AUTHOR_EMAIL: 'checkpoint@ai-term.invalid', GIT_COMMITTER_NAME: 'AI Term', GIT_COMMITTER_EMAIL: 'checkpoint@ai-term.invalid' };
const BIG = 16 * 1024 * 1024;
type Kind = 'checkpoint' | 'redo';
function slugOk(slug: string): void { if (!isWorktreeBranch(`ai/${slug}`)) throw new CheckpointError('Invalid checkpoint name'); }
const refs = { checkpoint: (slug: string) => `refs/ai-term/checkpoints/${slug}/`, redo: (slug: string) => `refs/ai-term/redo/${slug}/`, at: (slug: string) => `refs/ai-term/at/${slug}` };
const mac = (kind: Kind, slug: string, tree: string, key: Buffer, scope = '') => createHmac('sha256', key).update(`${kind}\0${slug}\0${scope}\0${tree}`).digest('hex');
export function checkpointMessage(kind: Kind, slug: string, tree: string, key: Buffer, scope = ''): string { return `AI Term ${kind}\n\nAI-Term-Check: ${mac(kind, slug, tree, key, scope)}\n`; }
function signed(kind: Kind, slug: string, tree: string, body: string, key: Buffer, scope = ''): boolean {
  const found = body.match(/^AI-Term-Check: ([0-9a-f]{64})$/m)?.[1];
  return !!found && timingSafeEqual(Buffer.from(found), Buffer.from(mac(kind, slug, tree, key, scope)));
}
// Refs live in the shared repository folder; git is pointed at it directly, without a work tree. Nothing these commands
// do reads attributes or runs a filter; hooks are off in run().
const refsGit = (common: string, args: string[]) => runGit(common, [`--git-dir=${common}`, ...args], 'Git check failed', { maxBuffer: BIG });

export interface Checkpoint { n: number; commit: string; tree: string; at: string }
async function listSigned(common: string, slug: string, kind: Kind, key: Buffer, scope = ''): Promise<Checkpoint[]> {
  const prefix = refs[kind](slug);
  // Records end in \0\0\n (a commit body can hold new lines, never NUL).
  const out = await refsGit(common, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(tree)%00%(committerdate:iso-strict)%00%(contents)%00%00', '--', prefix]);
  return out.split('\0\0\n').filter(Boolean).flatMap(record => {
    const [ref, commit, tree, at, body] = record.split('\0'), n = Number(ref?.slice(prefix.length));
    return Number.isSafeInteger(n) && n > 0 && COMMIT_ID.test(commit ?? '') && COMMIT_ID.test(tree ?? '') && signed(kind, slug, tree ?? '', body ?? '', key, scope) ? [{ n, commit: commit ?? '', tree: tree ?? '', at: at ?? '' }] : [];
  }).sort((a, b) => a.n - b.n);
}
async function cursor(common: string, slug: string): Promise<string | null> {
  const out = (await refsGit(common, ['for-each-ref', '--format=%(objectname)', '--', refs.at(slug)])).trim();
  return COMMIT_ID.test(out) ? out : null;
}
async function setRef(common: string, ref: string, commit: string): Promise<void> { await refsGit(common, ['update-ref', '-m', 'AI Term', ref, commit]); }
async function dropRef(common: string, ref: string): Promise<void> { await refsGit(common, ['update-ref', '-d', ref]); }
async function dropAll(common: string, prefix: string): Promise<void> {
  for (const ref of (await refsGit(common, ['for-each-ref', '--format=%(refname)', '--', prefix])).split('\n').filter(Boolean)) await dropRef(common, ref);
}
// The worktree as it is now, as a tree in the repository's store: a private copy of the agent's index, `add -A`
// (untracked files included, ignored ones not), write-tree. Too many untracked files (an unignored build folder): no
// checkpoint, rather than hashing it all on every turn.
async function currentTree(path: string, git: IsolatedGit): Promise<string> {
  if ((await untrackedFiles(path, git)).length > MAX_UNTRACKED) throw new GitError('Git check failed');
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
async function withGit<T>(path: string, ctx: CheckpointContext, use: (git: IsolatedGit) => Promise<T>): Promise<T> {
  const git = await isolatedGitDir(path, undefined, { writes: true, repo: ctx.repo });
  try { return await use(git); } finally { await git.dispose(); }
}
export async function listCheckpoints(path: string, slug: string, ctx: CheckpointContext): Promise<Checkpoint[]> {
  slugOk(slug);
  return withGit(path, ctx, git => listSigned(git.common, slug, 'checkpoint', ctx.key, ctx.scope));
}
// A new checkpoint, unless nothing changed since the last one (then null). The oldest beyond 50 go; a new turn also
// ends what /redo could bring back and where /undo had gone.
export async function snapshot(path: string, slug: string, ctx: CheckpointContext): Promise<{ n: number; commit: string; tree: string } | null> {
  slugOk(slug);
  return withGit(path, ctx, async git => {
    const tree = await currentTree(path, git), existing = await listSigned(git.common, slug, 'checkpoint', ctx.key, ctx.scope), last = existing.at(-1);
    if (last?.tree === tree) return null;
    const n = (last?.n ?? 0) + 1, commit = await commitTree(path, git, tree, checkpointMessage('checkpoint', slug, tree, ctx.key, ctx.scope));
    await setRef(git.common, `${refs.checkpoint(slug)}${n}`, commit);
    for (const old of existing.slice(0, Math.max(0, existing.length + 1 - MAX_CHECKPOINTS))) await dropRef(git.common, `${refs.checkpoint(slug)}${old.n}`);
    await dropAll(git.common, refs.redo(slug)); if (await cursor(git.common, slug)) await dropRef(git.common, refs.at(slug));
    return { n, commit, tree };
  });
}
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
interface Resolved { current: string; target: { commit: string; tree: string; at: string; n: number | null }; redoN: number | null; all: UndoChange[]; fingerprint: string }
// Undo goes back from where the worktree is: from the checkpoint the last /undo went to (the cursor), else from the
// last checkpoint (or to it, if the worktree changed since). Redo: the newest state an /undo saved.
async function resolve(path: string, slug: string, kind: 'undo' | 'redo', git: IsolatedGit, ctx: CheckpointContext): Promise<Resolved> {
  const current = await currentTree(path, git);
  let target: Resolved['target'], redoN: number | null = null;
  if (kind === 'redo') {
    const top = (await listSigned(git.common, slug, 'redo', ctx.key, ctx.scope)).at(-1);
    if (!top) throw new CheckpointError('Nothing to redo');
    target = { ...top, n: null }; redoN = top.n;
  } else {
    // At the cursor: one further back. Moved off it (edited after an /undo): back to it, never forward to newer work.
    const all = await listSigned(git.common, slug, 'checkpoint', ctx.key, ctx.scope), at = await cursor(git.common, slug), here = all.findIndex(c => c.commit === at);
    const last = all.at(-1), pick = here >= 0 ? (all[here]?.tree === current ? all[here - 1] : all[here]) : last && last.tree !== current ? last : all.at(-2);
    if (!pick) throw new CheckpointError('No checkpoint to go back to');
    target = pick;
  }
  if (target.tree === current) throw new CheckpointError('Nothing to change; the worktree already matches it');
  const all = await changes(path, git, current, target.tree);
  // A path the target restores where an ignored file is now: that file isn't in any snapshot, so replacing it would
  // lose it for good. Refused, said plainly.
  for (const change of all) {
    if (change.change !== 'restored') continue;
    try { if (!(await lstat(join(path, change.path))).isDirectory()) throw new CheckpointError('An ignored file is where the checkpoint has one; nothing was restored'); }
    catch (error) { if (error instanceof CheckpointError) throw error; if (!isFsError(error, 'ENOENT') && !isFsError(error, 'ENOTDIR')) throw error; }
  }
  return { current, target, redoN, all, fingerprint: createHash('sha256').update(`${kind}\0${current}\0${target.commit}`).digest('hex') };
}
export async function undoPlan(path: string, slug: string, kind: 'undo' | 'redo', ctx: CheckpointContext, title = slug): Promise<UndoPlan> {
  slugOk(slug);
  return withGit(path, ctx, async git => {
    const r = await resolve(path, slug, kind, git, ctx);
    return { kind, title, target: r.target.n, targetAt: r.target.at, changes: r.all.slice(0, UNDO_SHOWN).map(change => ({ ...change, path: diffPath(change.path) })), more: Math.max(0, r.all.length - UNDO_SHOWN), fingerprint: r.fingerprint };
  });
}
// Every existing folder on the way to a path must be a real folder (not a symlink) inside the worktree; a file on the
// way is in the way unless the restore removes it first.
async function parentsClear(root: string, name: string, removed: ReadonlySet<string>): Promise<void> {
  const parts = name.split('/');
  for (let i = 1; i < parts.length; i++) {
    const rel = parts.slice(0, i).join('/');
    let info;
    try { info = await lstat(join(root, rel)); } catch (error) { if (isFsError(error, 'ENOENT')) return; throw error; }
    if (info.isSymbolicLink()) throw new CheckpointError('A folder in the worktree is a symlink; nothing was restored');
    if (!info.isDirectory()) { if (removed.has(rel)) return; throw new CheckpointError('Something in the worktree is in the way; nothing was restored'); }
  }
}
// Files under a folder, relative to the root (for "does the restore empty this folder?"); capped, never followed.
async function filesUnder(root: string, rel: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    // Past the cap the folder can't be checked whole, so it counts as in the way.
    if (out.length > 10_000) throw new CheckpointError('Something in the worktree is in the way; nothing was restored');
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) await filesUnder(root, child, out); else out.push(child);
  }
  return out;
}
// Folders the restore emptied go too (never one that still holds anything, never a symlink).
async function pruneEmpty(root: string, rel: string): Promise<void> {
  for (let dir = dirname(rel); dir !== '.' && dir !== ''; dir = dirname(dir)) {
    let info;
    try { info = await lstat(join(root, dir)); } catch (error) { if (isFsError(error, 'ENOENT')) continue; throw error; }
    if (!info.isDirectory() || (await readdir(join(root, dir))).length) return;
    await rmdir(join(root, dir));
  }
}
async function makeFolders(root: string, rel: string): Promise<void> {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const at = join(root, parts.slice(0, i).join('/'));
    let info;
    try { info = await lstat(at); } catch (error) { if (!isFsError(error, 'ENOENT')) throw error; await mkdir(at, { mode: 0o755 }); continue; }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new CheckpointError('A folder in the worktree is a symlink; nothing was restored');
  }
}
// Restores the target exactly as the plan showed (the fingerprint must match). Nothing is touched until every file to
// write has been read and staged in a private folder inside the worktree and every path checked; then removed files go,
// then each staged file is renamed into place (whole, never half written), its mode already set. Undo first keeps the
// state before it for /redo and moves the cursor; a failure part way says so and names that saved state.
export async function applyUndo(path: string, slug: string, kind: 'undo' | 'redo', fingerprint: string, ctx: CheckpointContext): Promise<{ restored: number }> {
  slugOk(slug);
  return withGit(path, ctx, async git => {
    const r = await resolve(path, slug, kind, git, ctx).catch((error: unknown) => { throw error instanceof CheckpointError ? new CheckpointError(`Changed since you looked; run /${kind} again`) : error; });
    if (r.fingerprint !== fingerprint) throw new CheckpointError(`Changed since you looked; run /${kind} again`);
    const removed = new Set(r.all.filter(c => c.change === 'removed').map(c => c.path)), writes = r.all.filter(c => c.change !== 'removed');
    for (const change of r.all) await parentsClear(path, change.path, removed);
    // A file to write where a folder is now: only if the restore empties that folder.
    for (const change of writes) {
      let info;
      // ENOTDIR: a file on the way, which parentsClear already found the restore removes.
      try { info = await lstat(join(path, change.path)); } catch (error) { if (isFsError(error, 'ENOENT') || isFsError(error, 'ENOTDIR')) continue; throw error; }
      if (info.isDirectory() && !(await filesUnder(path, change.path)).every(file => removed.has(file))) throw new CheckpointError('Something in the worktree is in the way; nothing was restored');
    }
    const entries = new Map<string, { mode: string; hash: string }>();
    for (const record of (await runGit(path, [...git.args, 'ls-tree', '-r', '-z', '--full-tree', '--end-of-options', r.target.tree], 'Git check failed', { env: git.env, maxBuffer: BIG })).split('\0')) {
      const match = record.match(/^(\d{6}) (blob|commit) ([0-9a-f]{40,64})\t(.+)$/s);
      if (match?.[1] && match[3] && match[4]) entries.set(match[4], { mode: match[1], hash: match[3] });
    }
    // A staging folder a crash left behind goes first (only ours: that name, a real folder at the top).
    for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory() && /^\.ai-term-restore-[0-9a-f]{12}$/.test(entry.name)) await rm(join(path, entry.name), { recursive: true, force: true });
    const staging = join(path, `.ai-term-restore-${randomBytes(6).toString('hex')}`);
    await mkdir(staging, { mode: 0o700 });
    try {
      // Read and stage everything first: a blob that can't be read stops the restore before anything changed.
      const staged: { change: UndoChange; file: string }[] = [];
      for (const [i, change] of writes.entries()) {
        const entry = entries.get(change.path);
        if (!entry || entry.mode === '160000') continue; // a nested repository is never written into
        let content: Buffer;
        try { content = await blobBytes(path, git.args, entry.hash, git.env); } catch { throw new CheckpointError('Nothing was restored; a checkpoint file could not be read'); }
        const file = join(staging, String(i));
        if (entry.mode === '120000') await symlink(content.toString('utf8'), file);
        else {
          const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await handle.writeFile(content); } finally { await handle.close(); }
          // Pinned after writing: the umask can't change an executable bit.
          await chmod(file, entry.mode === '100755' ? 0o755 : 0o644);
        }
        staged.push({ change, file });
      }
      // The state before the undo is saved now (its commit exists before anything changes); its refs are set once the
      // first change has landed, so a restore that changes nothing leaves the redo stack and cursor as they were.
      const redoCommit = kind === 'undo' ? await commitTree(path, git, r.current, checkpointMessage('redo', slug, r.current, ctx.key, ctx.scope)) : null;
      let saved = false;
      const save = async () => {
        if (saved) return; saved = true;
        if (!redoCommit) return;
        const redo = await listSigned(git.common, slug, 'redo', ctx.key, ctx.scope), n = (redo.at(-1)?.n ?? 0) + 1;
        await setRef(git.common, `${refs.redo(slug)}${n}`, redoCommit);
        for (const old of redo.slice(0, Math.max(0, redo.length + 1 - MAX_REDO))) await dropRef(git.common, `${refs.redo(slug)}${old.n}`);
        await setRef(git.common, refs.at(slug), r.target.commit);
      };
      let restored = 0;
      try {
        for (const name of removed) {
          await parentsClear(path, name, removed);
          try { const info = await lstat(join(path, name)); if (!info.isDirectory()) { await unlink(join(path, name)); await save(); } } catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
          await pruneEmpty(path, name); restored++;
        }
        for (const { change, file } of staged) {
          const target = join(path, change.path);
          await makeFolders(path, change.path);
          // A folder still here was emptied by the removals above (checked before anything changed).
          try { const info = await lstat(target); if (info.isDirectory()) await rm(target, { recursive: true }); } catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
          await rename(file, target); await save(); restored++;
        }
      } catch (error) {
        if (!saved) throw error instanceof CheckpointError ? error : new CheckpointError('Nothing was restored; the worktree could not be written', { cause: error });
        throw new CheckpointError('The restore stopped part way; /redo or /undo brings back a saved state', { cause: error });
      }
      if (kind === 'redo' && r.redoN !== null) {
        await dropRef(git.common, `${refs.redo(slug)}${r.redoN}`);
        // Where the worktree now is among the checkpoints, for the next /undo; none matching: no cursor.
        const match = [...await listSigned(git.common, slug, 'checkpoint', ctx.key, ctx.scope)].reverse().find(c => c.tree === r.target.tree);
        if (match) await setRef(git.common, refs.at(slug), match.commit); else if (await cursor(git.common, slug)) await dropRef(git.common, refs.at(slug));
      }
      return { restored };
    } finally { await rm(staging, { recursive: true, force: true }); }
  });
}
// The worktree went away: its checkpoints, redo states and cursor go with it.
export async function dropCheckpoints(repo: string, slug: string, ctx: CheckpointContext): Promise<void> {
  slugOk(slug);
  await withGit(repo, ctx, async git => { await dropAll(git.common, refs.checkpoint(slug)); await dropAll(git.common, refs.redo(slug)); if (await cursor(git.common, slug)) await dropRef(git.common, refs.at(slug)); });
}
