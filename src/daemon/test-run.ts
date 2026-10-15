import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isFsError } from '../shared/paths.js';
import { failingCount, isTestCommand, isTestConfig } from '../shared/test-run.js';
import { diffNameStatus, isolatedGitDir, repoCommonDir, repoTopLevel, untrackedFiles } from './git.js';

// v0.7.4: one test run in an agent's worktree. argv only (spawn, no shell), stdin closed, its own process group so a
// timeout or a cancel ends everything it started (npm starts node, node starts workers). Output is read to the end but
// only its last TAIL_BYTES are kept (for the failing count); past OUTPUT_CAP the run is stopped as failed.
export const TEST_TIMEOUT_MS = 10 * 60_000, TEST_OUTPUT_CAP = 16 * 1024 * 1024;
const TAIL_BYTES = 64 * 1024, KILL_GRACE_MS = 2_000;
export type TestOutcome = { state: 'pass' } | { state: 'fail'; failing: number | null } | { state: 'timeout' } | { state: 'error' } | { state: 'cancelled' };
export interface TestRunOptions { timeoutMs?: number; outputCap?: number; signal?: AbortSignal; log?: (text: string) => void }

export function runTests(command: readonly string[], cwd: string, env: Record<string, string>, options: TestRunOptions = {}): Promise<TestOutcome> {
  if (!isTestCommand(command)) return Promise.resolve({ state: 'error' });
  const [program, ...args] = command;
  return new Promise(resolve => {
    let tail = Buffer.alloc(0), total = 0, ended: 'timeout' | 'cancelled' | 'capped' | null = null, settled = false;
    const child = spawn(program ?? '', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const group = (signal: NodeJS.Signals) => {
      // A negative pid signals the whole group; the child may already be gone (ESRCH), which is what we wanted.
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, signal); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) options.log?.(`Test run: stopping its processes failed (${error instanceof Error && 'code' in error ? String(error.code) : 'unknown'})`); }
    };
    const stop = (why: 'timeout' | 'cancelled' | 'capped') => {
      if (ended) return;
      ended = why; group('SIGTERM');
      setTimeout(() => group('SIGKILL'), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? TEST_TIMEOUT_MS);
    const onAbort = () => stop('cancelled');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const finish = (outcome: TestOutcome) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort);
      // Whatever is left of the group goes too: a test runner's background server must not outlive its run.
      if (outcome.state !== 'error') group('SIGKILL');
      resolve(outcome);
    };
    const read = (chunk: Buffer) => {
      total += chunk.length;
      if (total > (options.outputCap ?? TEST_OUTPUT_CAP)) stop('capped');
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.on('error', () => finish({ state: 'error' }));
    // The command ended: anything it left in the background (holding the output pipes open) is stopped, so 'close' comes.
    let code: number | null = null;
    child.on('exit', exitCode => { code = exitCode; group('SIGKILL'); });
    child.on('close', () => {
      if (ended === 'timeout') finish({ state: 'timeout' });
      else if (ended === 'cancelled') finish({ state: 'cancelled' });
      else if (ended === 'capped') finish({ state: 'fail', failing: failingCount(tail.toString('utf8')) });
      else finish(code === 0 ? { state: 'pass' } : { state: 'fail', failing: failingCount(tail.toString('utf8')) });
    });
  });
}

// The test setup files this agent's work changed since it started (committed, uncommitted or new), from git's own lists in
// a private git dir (git.ts), so the agent's repository config can't run anything while they are read.
export async function changedTestConfig(path: string, base: string, repo: string | undefined, command: readonly string[]): Promise<string[]> {
  const git = await isolatedGitDir(path, base, repo ? { repo } : {});
  try {
    const names = [...(await diffNameStatus(path, base, git)).flatMap(entry => entry.from ? [entry.from, entry.path] : [entry.path]), ...await untrackedFiles(path, git)];
    return [...new Set(names.filter(name => isTestConfig(name, command)))].sort();
  } finally { await git.dispose(); }
}
// What /test showed: the command, the folder, and each changed setup file's name and content (a file the agent edits after
// you saw the plan changes the fingerprint, so y never runs a setup you didn't see).
export async function testFingerprint(command: readonly string[], cwd: string, changed: readonly string[]): Promise<string> {
  const hash = createHash('sha256').update(JSON.stringify([command, cwd, changed]));
  for (const name of changed) hash.update('\0').update(name).update('\0').update(await contentHash(join(cwd, name)));
  return hash.digest('hex');
}
async function contentHash(path: string): Promise<string> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (isFsError(error, 'ENOENT') || isFsError(error, 'ELOOP')) return 'gone or a link'; throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile()) return 'not a file';
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } finally { await file.close(); }
}
export class TestRunError extends Error {}
export const TEST_ERRORS = ['This agent has no worktree to test', 'Tests unavailable; git could not read the worktree', 'No test command for this project · /test-cmd <command>',
  'The test setup changed since it was shown; run /test again', "This folder isn't in a git repository; /test-cmd is per project"] as const;
// A project is a repository: its main checkout's folder (a linked worktree's common git dir leads back to it), real path.
export async function projectRepo(cwd: string): Promise<string> {
  const top = await repoTopLevel(cwd);
  if (!top) throw new TestRunError("This folder isn't in a git repository; /test-cmd is per project");
  const common = await repoCommonDir(top);
  return realpath(common.endsWith('/.git') ? dirname(common) : top);
}
