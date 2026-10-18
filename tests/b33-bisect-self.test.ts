import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { appendFile, lstat, mkdtemp, readdir, readFile, readlink, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bisectPlan, runBisect } from '../src/daemon/bisect.js';
import { prepareSandbox, sandboxReady, type PreparedSandbox } from '../src/daemon/test-sandbox.js';
import { buildBisectEnv } from '../src/daemon/env.js';
import { repoCommonDir } from '../src/daemon/git.js';

// B33 on AI Term itself (opt-in, about a minute: AITERM_BISECT_SELF_TEST=1 npx vitest run tests/b33-bisect-self.test.ts).
// A temporary clone of this repository, good at a real commit twelve back and bad at HEAD plus one planted failing test,
// with an APFS clone of this checkout's node_modules as its installed dependencies. Vitest writes node_modules/.vite while
// it runs, so through B32's read-only link every commit failed and /bisect stopped with "also fails at".
const run = promisify(execFile), roots: string[] = [];
const SELF = process.env.AITERM_BISECT_SELF_TEST === '1' && process.platform === 'darwin';
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
const git = async (cwd: string, ...args: string[]) => (await run('/usr/bin/git', [...ID, ...args], { cwd })).stdout.trim();
// The cache folders' bytes, and every other entry's path, kind, mode, size and time: a rewrite anywhere changes it.
async function digest(folder: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (dir: string, bytes: boolean): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name), info = await lstat(path), cache = bytes || dir === folder && name.startsWith('.vite');
      hash.update(`${path.slice(folder.length)}\0${info.mode}\0${info.size}\0${info.mtimeMs}\0`);
      if (info.isSymbolicLink()) hash.update(await readlink(path)); else if (info.isDirectory()) await walk(path, cache); else if (cache) hash.update(await readFile(path));
    }
  };
  await walk(folder, false); return hash.digest('hex');
}

it.skipIf(!SELF)('B33: /bisect npx vitest on a temporary clone of AI Term finds the planted commit; the clone\'s node_modules is unchanged', async () => {
  const here = resolve('.'), good = await git(here, 'rev-parse', '--verify', 'HEAD~12^{commit}'), head = await git(here, 'rev-parse', '--verify', 'HEAD^{commit}');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-bisect-self-'))); roots.push(root);
  const repo = join(root, 'ai-term'), temp = join(root, 'tmp');
  // Your checkout is only read: cloned without hard links, and its node_modules cloned copy-on-write.
  await git(root, 'clone', '--quiet', '--no-hardlinks', '--no-checkout', '--', here, repo);
  await git(repo, 'checkout', '--quiet', '--detach', '--end-of-options', head);
  await run('/bin/cp', ['-c', '-P', '-R', '--', join(here, 'node_modules'), join(repo, 'node_modules')]);
  await appendFile(join(repo, 'tests', 'protocol.test.ts'), "\nit('planted by the B33 self-bisect', () => { expect(1).toBe(2); });\n");
  await git(repo, 'commit', '-qam', 'planted: a failing protocol test', '--');
  const planted = await git(repo, 'rev-parse', 'HEAD'), before = await digest(join(repo, 'node_modules'));
  const sandbox = async (path: string, readable: readonly string[] = []): Promise<PreparedSandbox | null> => {
    const box = await prepareSandbox(path, { home: homedir(), private: [], loopback: false, env: buildBisectEnv(process.env), readable: [await repoCommonDir(repo), ...readable] });
    if (await sandboxReady(box.profile, box.program, box.prefix)) return box;
    await box.dispose(); return null;
  };
  // A temp folder of the test's own, so the copy's removal can be checked.
  await run('/bin/mkdir', ['--', temp]);
  const saved = process.env.TMPDIR, logs: string[] = [];
  process.env.TMPDIR = temp;
  let result: Awaited<ReturnType<typeof runBisect>>;
  try {
    const plan = await bisectPlan(repo, `npx vitest run tests/protocol.test.ts ${good}`);
    expect(plan).toMatchObject({ command: ['npx', 'vitest', 'run', 'tests/protocol.test.ts'], good, deps: ['node_modules'], commits: 13 });
    const started = performance.now();
    result = await runBisect({ repo, plan, sandbox, unsandboxed: false, env: buildBisectEnv(process.env), log: text => logs.push(text) });
    // The time the report asks for: the bisect alone (clone, checks at both ends, the steps, removal), without the setup above.
    console.info(`B33 self-bisect: ${((performance.now() - started) / 1000).toFixed(1)} s, ${result.steps} steps`);
  } finally { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; }
  expect(result).toMatchObject({ kind: 'bisect', commit: planted, subject: 'planted: a failing protocol test' });
  expect(logs, logs.join(' | ')).toEqual([]);
  expect(await digest(join(repo, 'node_modules'))).toBe(before);
  expect(await readdir(temp)).toEqual([]);
}, 300_000);
