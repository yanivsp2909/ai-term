import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMIT_ID, GitError, runGit } from './git.js';

// A throwaway copy of a repository at one commit, for /bisect and /perf's A/B (v1.1). `git clone --shared` reads the
// repository's objects through an alternates file and writes nothing into it: your checkout, its index, its refs and its
// worktree list stay exactly as they were, whatever runs in the copy. Removing the copy is one rm of AI Term's own
// temporary folder; git's worktree commands (and their deletion rules) are never involved.
export interface TempClone { path: string; dispose(): Promise<void> }
export async function tempClone(repo: string, commit: string): Promise<TempClone> {
  if (!COMMIT_ID.test(commit)) throw new GitError('Git check failed');
  const folder = await mkdtemp(join(await realpath(tmpdir()), 'ai-term-clone-')), path = join(folder, 'repo');
  const dispose = () => rm(folder, { recursive: true, force: true });
  try {
    await runGit(folder, ['clone', '--quiet', '--shared', '--no-checkout', '--', repo, path], 'Git check failed', { timeout: 60_000 });
    await runGit(path, ['checkout', '--quiet', '--detach', '--end-of-options', commit], 'Git check failed', { timeout: 120_000 });
    return { path, dispose };
  } catch (error) { await dispose(); throw error; }
}
