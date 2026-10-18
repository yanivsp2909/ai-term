import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { EMPTY_TREE_ID, isolatedGitDir, runGit } from './git.js';
import { addonFile } from '../agent/addon-bundle.js';
import { isFsError } from '../shared/paths.js';
import { SECRET_FILE } from '../shared/review.js';
import { fitEscaped } from './addon-text.js';

// v1.1 /commit y: the agent's uncommitted work, committed in its own worktree. Review (security): the worktree's .git
// file and admin dir are the agent's to write, so before git reads anything there they must lead back to the recorded
// repository (isolatedGitDir's check), and attributes come from no file (an attribute could name a planted filter).
// The message is written for one exact state (HEAD, status, the uncommitted diff); y commits only that state.
export interface AgentWork { path: string; base: string; repo: string }
export const COMMIT_DATA_BYTES = 9000, NEW_FILES_SHOWN = 20, NEW_FILE_BYTES = 4000;
const NO_ATTRIBUTES = ['-c', 'core.attributesFile=/dev/null', `--attr-source=${EMPTY_TREE_ID}`];
async function bound(work: AgentWork): Promise<void> { const git = await isolatedGitDir(work.path, work.base, { repo: work.repo }); await git.dispose(); }
// `git status -z` entries: "XY path", a rename followed by its old path as its own entry.
function statusNames(raw: string): { code: string; path: string }[] {
  const parts = raw.split('\0'), out: { code: string; path: string }[] = [];
  for (let n = 0; n < parts.length; n++) { const entry = parts[n] ?? ''; if (entry.length < 4) continue; out.push({ code: entry.slice(0, 2), path: entry.slice(3) }); if (entry[0] === 'R' || entry[0] === 'C') n++; }
  return out;
}
export async function agentWork(work: AgentWork): Promise<{ state: string; data: string; facts: string[] }> {
  await bound(work);
  const status = await runGit(work.path, [...NO_ATTRIBUTES, 'status', '--porcelain=v1', '-z', '-uall', '--'], 'Git check failed', { maxBuffer: 16 * 1024 * 1024 }), names = statusNames(status);
  if (!names.length) throw new Error("Nothing to commit in this agent's worktree");
  // A credential file would be swept in by `git add -A` and published by /pr: never committed by AI Term.
  const secret = names.find(n => SECRET_FILE.test(n.path));
  if (secret) throw new Error(`The agent's worktree holds ${secret.path.replace(/[\p{C}]/gu, '?').slice(0, 120)}, a file that usually holds secrets; commit it yourself if you mean to`);
  const head = (await runGit(work.path, ['rev-parse', '--verify', '--end-of-options', 'HEAD'])).trim();
  const diff = await runGit(work.path, [...NO_ATTRIBUTES, 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--end-of-options', 'HEAD', '--'], 'Git check failed', { maxBuffer: 32 * 1024 * 1024 });
  const untracked = names.filter(n => n.code === '??'), stats: string[] = [], shown: string[] = [];
  for (const file of untracked) {
    try { const info = await lstat(join(work.path, file.path)); stats.push(`${file.path}\0${info.size}\0${info.mtimeMs}`); }
    catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
    // A new file's text goes to the model like the diff (the add-on core redacts secrets); one it can't read is named.
    if (shown.length < NEW_FILES_SHOWN) shown.push(`New file ${file.path}:\n${await addonFile(work.path, file.path, NEW_FILE_BYTES).catch(() => '(not shown: not a small text file)')}`);
  }
  const state = createHash('sha256').update(JSON.stringify([head, status, diff, stats])).digest('hex');
  return { state, data: fitEscaped(`Uncommitted changes (exactly what y commits):\n${diff}\n${shown.join('\n')}`, COMMIT_DATA_BYTES), facts: [`uncommitted: ${names.length} file${names.length === 1 ? '' : 's'}`] };
}
export async function commitWork(work: AgentWork, message: string, expected: string, identity: { name: string; email: string }): Promise<string> {
  const now = await agentWork(work);
  if (now.state !== expected) throw new Error("The agent's work changed since the message was written; run /commit again");
  // Filters (LFS and the like) change what is committed; with attributes off they would be skipped, so it's yours.
  const files = (await runGit(work.path, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--'], 'Git check failed', { maxBuffer: 16 * 1024 * 1024 })).split('\0').filter(name => name === '.gitattributes' || name.endsWith('/.gitattributes'));
  for (const file of files) if (/\bfilter=/.test(await addonFile(work.path, file, 64 * 1024).catch(() => 'filter='))) throw new Error('This repository uses git filters; commit it yourself');
  const env = { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email };
  await runGit(work.path, [...NO_ATTRIBUTES, 'add', '-A', '--', '.'], 'Git check failed', { timeout: 60_000 });
  await runGit(work.path, [...NO_ATTRIBUTES, 'commit', '--quiet', '--no-verify', '--no-gpg-sign', '-F', '-', '--'], 'Git check failed', { input: message, timeout: 60_000, env });
  return (await runGit(work.path, ['rev-parse', '--short', '--verify', '--end-of-options', 'HEAD'])).trim();
}
