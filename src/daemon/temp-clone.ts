import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { COMMIT_ID, GitError, runGit } from './git.js';
import { isFsError } from '../shared/paths.js';
import { ownTempFolder } from './own-temp.js';

// A throwaway copy of a repository at one commit, for /bisect and /perf's A/B (v1.1). `git clone --shared` reads the
// repository's objects through an alternates file and writes nothing into it: your checkout, its index, its refs and its
// worktree list stay exactly as they were, whatever runs in the copy. Removing the copy is one rm of AI Term's own
// temporary folder; git's worktree commands (and their deletion rules) are never involved.
export interface TempClone { path: string; dispose(): Promise<void> }
export async function tempClone(repo: string, commit: string, signal?: AbortSignal): Promise<TempClone> {
  if (!COMMIT_ID.test(commit)) throw new GitError('Git check failed');
  const folder = await ownTempFolder('clone'), path = join(folder, 'repo');
  const dispose = () => removeTree(folder);
  try {
    await runGit(folder, ['clone', '--quiet', '--shared', '--no-checkout', '--', repo, path], 'Git check failed', { timeout: 60_000, ...(signal ? { signal } : {}) });
    // switch, not checkout: git 2.43's checkout takes --end-of-options after --detach for a path and refuses (B34).
    await runGit(path, ['switch', '--quiet', '--detach', '--end-of-options', commit], 'Git check failed', { timeout: 120_000, ...(signal ? { signal } : {}) });
    return { path, dispose };
  } catch (error) { await dispose(); throw error; }
}

// B33 review: a read-only folder inside the copy (a clone keeps a dependency folder's modes, and a test may make one)
// can't be emptied, so rm stops with EACCES and the copy stays behind. Then the tree is made yours to write once
// (chmod -R never follows a link it meets inside the tree, and the path is AI Term's own temp folder, never a link) and
// removed again. No chmod (NixOS, Windows): the first error stands.
const CHMOD = ['/bin/chmod', '/usr/bin/chmod'].find(path => { try { return statSync(path).isFile(); } catch (error) { if (isFsError(error, 'ENOENT') || isFsError(error, 'ENOTDIR')) return false; throw error; } });
export async function removeTree(path: string): Promise<void> {
  try { await rm(path, { recursive: true, force: true }); return; }
  catch (error) { if (!CHMOD || !isAbsolute(path) || !(isFsError(error, 'EACCES') || isFsError(error, 'EPERM'))) throw error; }
  // The mode comes before the path, so BSD chmod takes no `--`; an absolute path can't read as an option. chmod's own
  // exit doesn't decide (a file a test removed meanwhile makes it exit 1): the second rm does, and throws if it fails.
  await new Promise<void>(done => { execFile(CHMOD, ['-R', 'u+rwX', path], { timeout: 60_000, env: { PATH: '/usr/bin:/bin' } }, () => done()); });
  await rm(path, { recursive: true, force: true });
}
