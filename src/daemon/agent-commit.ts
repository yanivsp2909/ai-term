import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { EMPTY_TREE_ID, GitError, runGit } from './git.js';
import { addonFile } from '../agent/addon-bundle.js';
import { isFsError } from '../shared/paths.js';
import { SECRET_FILE } from '../shared/review.js';
import { factText, fitEscaped } from './addon-text.js';

// v1.1 /commit y: the agent's uncommitted work, committed in its own worktree. The worktree's .git file, its admin dir
// and the repository config are within an agent's reach, so (security reviews):
// - the admin dir and the shared git dir are worked out once, checked to lead back to the recorded repository, and
//   passed to every git call (--git-dir, --work-tree, GIT_COMMON_DIR): a .git rewritten mid-way changes nothing;
// - a repository whose config defines filters (or includes other config) or whose info/attributes names one is refused
//   before git reads the worktree: a clean filter runs on status, diff and add;
// - HEAD must be the agent's own branch, and y commits only the exact state the message was written for.
export interface AgentWork { path: string; base: string; repo: string; branch: string }
interface Dirs { args: string[]; env: Record<string, string> }
export const COMMIT_DATA_BYTES = 9000, NEW_FILES_SHOWN = 20, NEW_FILE_BYTES = 4000, NEW_FILE_HASHED = 4 * 1024 * 1024;
const REFUSED = 'This repository uses git filters (or config includes); commit it yourself';
const text = (root: string, file: string) => addonFile(root, file, 256 * 1024).catch((error: unknown) => { if (isFsError(error, 'ENOENT')) return ''; throw error; });
async function bound(work: AgentWork): Promise<Dirs> {
  if (await realpath(work.path) !== work.path) throw new GitError('Git check failed');
  const dotGit = join(work.path, '.git'), info = await lstat(dotGit);
  if (!info.isFile()) throw new GitError('Git check failed');
  const target = (await readFile(dotGit, 'utf8')).match(/^gitdir: ([^\n]+)\n?$/)?.[1]; if (!target) throw new GitError('Git check failed');
  const gitDir = await realpath(resolve(work.path, target)), common = await realpath(join(work.repo, '.git'));
  if (dirname(gitDir) !== join(common, 'worktrees')) throw new GitError('Git check failed');
  if (/^\s*\[\s*(?:filter|include|includeif)\b/im.test(`${await text(common, 'config')}\n${await text(gitDir, 'config.worktree')}`) || /\bfilter=/.test(await text(join(common, 'info'), 'attributes'))) throw new Error(REFUSED);
  return { args: [`--git-dir=${gitDir}`, `--work-tree=${work.path}`, '-c', 'core.attributesFile=/dev/null', `--attr-source=${EMPTY_TREE_ID}`], env: { GIT_COMMON_DIR: common } };
}
const git = (work: AgentWork, dirs: Dirs, args: string[], options: { maxBuffer?: number; input?: string; env?: Record<string, string> } = {}) =>
  runGit(work.path, [...dirs.args, ...args], 'Git check failed', { maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024, timeout: 60_000, ...options.input !== undefined ? { input: options.input } : {}, env: { ...dirs.env, ...options.env } });
// `git status -z` entries: "XY path", a rename followed by its old path as its own entry.
function statusNames(raw: string): { code: string; path: string }[] {
  const parts = raw.split('\0'), out: { code: string; path: string }[] = [];
  for (let n = 0; n < parts.length; n++) { const entry = parts[n] ?? ''; if (entry.length < 4) continue; out.push({ code: entry.slice(0, 2), path: entry.slice(3) }); if (entry[0] === 'R' || entry[0] === 'C') n++; }
  return out;
}
// A new file's content, hashed (size and time alone miss a same-size rewrite); a very large one by size and time.
async function fingerprint(path: string): Promise<string> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) { if (isFsError(error, 'ENOENT') || isFsError(error, 'ELOOP')) return 'missing-or-link'; throw error; }
  try { const info = await file.stat(); return info.isFile() && info.size <= NEW_FILE_HASHED ? createHash('sha256').update(await file.readFile()).digest('hex') : `${info.size}:${info.mtimeMs}`; } finally { await file.close(); }
}
async function state(work: AgentWork, dirs: Dirs): Promise<{ hash: string; status: string; names: { code: string; path: string }[]; diff: string }> {
  const head = (await git(work, dirs, ['symbolic-ref', '-q', 'HEAD'])).trim();
  if (head !== `refs/heads/${work.branch}`) throw new Error(`The agent's worktree isn't on its own branch (${factText(work.branch, 80)}); commit it yourself`);
  const status = await git(work, dirs, ['status', '--porcelain=v1', '-z', '-uall', '--']), names = statusNames(status);
  const commit = (await git(work, dirs, ['rev-parse', '--verify', '--end-of-options', 'HEAD'])).trim();
  const diff = await git(work, dirs, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--end-of-options', 'HEAD', '--'], { maxBuffer: 32 * 1024 * 1024 });
  const prints: string[] = [];
  for (const file of names.filter(n => n.code === '??')) prints.push(`${file.path}\0${await fingerprint(join(work.path, file.path))}`);
  return { hash: createHash('sha256').update(JSON.stringify([commit, status, diff, prints])).digest('hex'), status, names, diff };
}
export async function agentWork(work: AgentWork): Promise<{ state: string; data: string; facts: string[] }> {
  const dirs = await bound(work), now = await state(work, dirs);
  if (!now.names.length) throw new Error("Nothing to commit in this agent's worktree");
  // A credential file would be swept in by `git add -A` and published by /pr: never committed by AI Term.
  const secret = now.names.find(n => SECRET_FILE.test(n.path));
  if (secret) throw new Error(`The agent's worktree holds ${factText(secret.path, 120)}, a file that usually holds secrets; commit it yourself if you mean to`);
  const shown: string[] = [];
  // A new file's text goes to the model like the diff (the add-on core redacts secrets); one it can't read is named.
  for (const file of now.names.filter(n => n.code === '??').slice(0, NEW_FILES_SHOWN)) shown.push(`New file ${file.path}:\n${await addonFile(work.path, file.path, NEW_FILE_BYTES).catch(() => '(not shown: not a small text file)')}`);
  return { state: now.hash, data: fitEscaped(`Uncommitted changes (exactly what y commits):\n${now.diff}\n${shown.join('\n')}`, COMMIT_DATA_BYTES), facts: [`uncommitted: ${now.names.length} file${now.names.length === 1 ? '' : 's'}`] };
}
export async function commitWork(work: AgentWork, message: string, expected: string, identity: { name: string; email: string }): Promise<string> {
  const dirs = await bound(work), now = await state(work, dirs);
  if (now.hash !== expected) throw new Error("The agent's work changed since the message was written; run /commit again");
  if (now.names.some(n => SECRET_FILE.test(n.path))) throw new Error("The agent's worktree holds a file that usually holds secrets; commit it yourself if you mean to");
  // .gitattributes filters (LFS and the like) change what is committed; with attributes off they'd be skipped: yours.
  const files = (await git(work, dirs, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--'])).split('\0').filter(name => name === '.gitattributes' || name.endsWith('/.gitattributes'));
  for (const file of files) if (/\bfilter=/.test(await addonFile(work.path, file, 64 * 1024).catch(() => 'filter='))) throw new Error(REFUSED);
  const env = { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email };
  await git(work, dirs, ['add', '-A', '--', '.']);
  await git(work, dirs, ['commit', '--quiet', '--no-verify', '--no-gpg-sign', '-F', '-', '--'], { input: message, env });
  return (await git(work, dirs, ['rev-parse', '--short', '--verify', '--end-of-options', 'HEAD'])).trim();
}
