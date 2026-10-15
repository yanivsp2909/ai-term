import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isFsError } from '../shared/paths.js';
import { diffPath } from '../shared/diff.js';
import { failingCount, isDependencyPath, isTestCommand, isTestConfig } from '../shared/test-run.js';
import { ProcessTree } from './process-tree.js';
import { sandboxDenial, type PreparedSandbox } from './test-sandbox.js';
import { diffNameStatus, GitError, insideWorktree, isolatedGitDir, repoCommonDir, repoTopLevel, runGit, untrackedFiles } from './git.js';

// v0.7.4: one test run in an agent's worktree. argv only (spawn, no shell), stdin closed, its own process group so a
// timeout or a cancel ends everything it started (npm starts node, node starts workers). Output is read to the end but
// only its last TAIL_BYTES are kept (for the failing count); past OUTPUT_CAP the run is stopped as failed.
// B26: with a sandbox (test-sandbox.ts) the whole tree runs under sandbox-exec; what the sandbox stopped reads as
// `blocked`, never as a failure count. Processes the run detached are followed and stopped with it (process-tree.ts).
export const TEST_TIMEOUT_MS = 10 * 60_000, TEST_OUTPUT_CAP = 16 * 1024 * 1024;
const TAIL_BYTES = 64 * 1024, KILL_GRACE_MS = 2_000;
export type TestOutcome = { state: 'pass' } | { state: 'fail'; failing: number | null } | { state: 'timeout' } | { state: 'error' } | { state: 'cancelled' } | { state: 'blocked'; what: string } | { state: 'nosandbox' };
export interface TestRunOptions { timeoutMs?: number; outputCap?: number; signal?: AbortSignal; log?: (text: string) => void; sandbox?: Pick<PreparedSandbox, 'program' | 'profile' | 'spec'> }
// sandbox-exec's own refusal (a profile the system rejects): EX_DATAERR or EX_OSERR, and its name on stderr.
const SANDBOX_REFUSED = /^sandbox-exec: /m;

export function runTests(command: readonly string[], cwd: string, env: Record<string, string>, options: TestRunOptions = {}): Promise<TestOutcome> {
  if (!isTestCommand(command)) return Promise.resolve({ state: 'error' });
  const box = options.sandbox, argv = box ? [box.program, '-p', box.profile, '--', ...command] : [...command];
  const [program, ...args] = argv;
  return new Promise(resolve => {
    let tail = Buffer.alloc(0), total = 0, ended: 'timeout' | 'cancelled' | 'capped' | null = null, settled = false;
    const child = spawn(program ?? '', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const tree = child.pid === undefined ? null : new ProcessTree(child.pid, options.log);
    tree?.start();
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
      void (tree ? tree.stop().catch(() => { options.log?.('Test run: leftover processes were not checked'); return 0; }) : Promise.resolve(0)).then(() => resolve(outcome));
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
    child.on('exit', exitCode => {
      code = exitCode; group('SIGKILL');
      // A process that left the group (setsid) can hold the pipes open forever: past a grace period they are closed and
      // the run ends anyway (the process tree stops what it saw of it).
      setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); conclude(); }, KILL_GRACE_MS).unref();
    });
    const failed = (): TestOutcome => {
      const text = tail.toString('utf8');
      if (!box) return { state: 'fail', failing: failingCount(text) };
      if (code !== null && [65, 71].includes(code) && SANDBOX_REFUSED.test(text)) return { state: 'nosandbox' };
      const what = sandboxDenial(text, box.spec);
      return what ? { state: 'blocked', what } : { state: 'fail', failing: failingCount(text) };
    };
    const conclude = () => {
      if (ended === 'timeout') finish({ state: 'timeout' });
      else if (ended === 'cancelled') finish({ state: 'cancelled' });
      else if (ended === 'capped') finish(failed());
      else finish(code === 0 ? { state: 'pass' } : failed());
    };
    child.on('close', conclude);
  });
}

// The test setup this agent's work changed since it started: setup files it changed (committed, uncommitted or new), and
// ignored dependency folders or setup files in its worktree (a fresh worktree has none). Read with git's own lists in a
// private git dir (git.ts), so the agent's repository config can't run anything meanwhile. The fingerprint covers the
// command, the folder, each changed file's content and every ignored entry's names, sizes and times; a run you approved
// with /test lets later turns run while it stays the same.
// unverifiable: part of it can't be checked (a link out of the worktree, a tree too large): it always asks.
export interface TestSetup { changed: string[]; fingerprint: string; unverifiable: boolean }
const WALK_LIMIT = 200_000;
export async function testSetup(path: string, base: string, repo: string | undefined, command: readonly string[]): Promise<TestSetup> {
  const git = await isolatedGitDir(path, base, repo ? { repo } : {});
  let configs: string[], ignored: string[];
  try {
    const names = [...(await diffNameStatus(path, base, git)).flatMap(entry => entry.from ? [entry.from, entry.path] : [entry.path]), ...await untrackedFiles(path, git)];
    // Setup files, and anything in a dependency folder git does see (untracked or even committed).
    configs = [...new Set(names.filter(name => isTestConfig(name, command) || isDependencyPath(name)))].sort();
    const listed = (await runGit(path, [...git.args, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z', '--'], 'Git check failed', { maxBuffer: 16 * 1024 * 1024 })).split('\0').filter(Boolean);
    if (listed.some(name => !insideWorktree(name.replace(/\/$/, '')))) throw new GitError('Git check failed');
    // Every ignored entry: a fresh worktree has none, and tools run code from build folders too (dist/, target/,
    // __pycache__/). A run's own output stays approved (see the session manager), so this asks only after the agent's turns.
    ignored = listed.sort();
  } finally { await git.dispose(); }
  const walked = ignored.length ? await walkDigest(path, ignored) : { digest: 'none', unverifiable: false };
  const fingerprint = createHash('sha256').update(await testFingerprint(command, path, configs)).update('\0').update(walked.digest).digest('hex');
  // Shown names only (gate): control characters can't cross the socket; the fingerprint above read the real ones.
  return { changed: [...configs.map(diffPath), ...ignored.map(name => `${diffPath(name)} (ignored)`)], fingerprint, unverifiable: walked.unverifiable };
}
// Names, kinds, sizes and change times of everything under the entries, without following links. A link is hashed by
// its target when that stays inside the worktree; one that leads out makes the setup unverifiable, like a tree past
// WALK_LIMIT entries or WALK_MS: then every turn asks (nothing too large or out of reach to check runs unasked).
const WALK_MS = 10_000;
async function walkDigest(root: string, entries: readonly string[]): Promise<{ digest: string; unverifiable: boolean }> {
  const hash = createHash('sha256'), queue = entries.map(entry => entry.replace(/\/$/, '')), top = await realpath(root), deadline = Date.now() + WALK_MS;
  let unverifiable = false;
  for (let next = 0; next < queue.length; next++) {
    if (next >= WALK_LIMIT || Date.now() > deadline) return { digest: `too large after ${next} entries`, unverifiable: true };
    const relative = queue[next] ?? '', path = join(root, relative);
    let info;
    try { info = await lstat(path); } catch (error) { if (isFsError(error, 'ENOENT')) { hash.update(`${relative}\0gone\n`); continue; } throw error; }
    hash.update(`${relative}\0${info.mode}\0${info.size}\0${info.mtimeMs}\0${info.ctimeMs}\n`);
    if (info.isSymbolicLink()) {
      let target: string;
      try { target = await realpath(path); } catch (error) { if (isFsError(error, 'ENOENT') || isFsError(error, 'ELOOP')) { hash.update('dangling\n'); continue; } throw error; }
      hash.update(`→${await readlink(path)}\n`);
      if (target !== top && !target.startsWith(top + '/')) unverifiable = true;
      continue;
    }
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) queue.push(`${relative}/${name}`);
  }
  return { digest: hash.digest('hex'), unverifiable };
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
export const TEST_ERRORS = ['This agent has no worktree to test', "Set /test-cmd from your checkout; this folder is an agent's worktree AI Term has no record of", 'Tests unavailable; git could not read the worktree', 'No test command for this project · /test-cmd <command>',
  'The test setup changed since it was shown; run /test again', "This folder isn't in a git repository; /test-cmd is per project"] as const;
// A project is a repository: its main checkout's folder (a linked worktree's common git dir leads back to it), real path.
export async function projectRepo(cwd: string): Promise<string> {
  const top = await repoTopLevel(cwd);
  if (!top) throw new TestRunError("This folder isn't in a git repository; /test-cmd is per project");
  const common = await repoCommonDir(top);
  return realpath(common.endsWith('/.git') ? dirname(common) : top);
}
