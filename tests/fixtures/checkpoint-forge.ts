import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkpointMessage, type CheckpointContext } from '../../src/daemon/checkpoints.js';
const run = promisify(execFile);
// A checkpoint signed with the test's own key whose tree names a blob that doesn't exist: only reading it can fail.
export async function forgeCheckpoint(tree: string, slug: string, ctx: CheckpointContext, missingBlob: string): Promise<void> {
  const mk = await new Promise<string>((resolve, reject) => { const child = execFile('/usr/bin/git', ['mktree', '--missing'], { cwd: tree }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())); child.stdin?.end(`100644 blob ${missingBlob}\tkeep.txt\n`); });
  const env = { ...process.env, GIT_AUTHOR_NAME: 'AI Term', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'AI Term', GIT_COMMITTER_EMAIL: 'a@b' };
  const commit = (await run('/usr/bin/git', ['commit-tree', '-m', checkpointMessage('checkpoint', slug, mk, ctx.key), mk], { cwd: tree, env })).stdout.trim();
  await run('/usr/bin/git', ['update-ref', `refs/ai-term/checkpoints/${slug}/50`, commit], { cwd: tree });
}
