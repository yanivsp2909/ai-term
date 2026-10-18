import { afterEach, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bisectPlan, runBisect } from '../src/daemon/bisect.js';
import { prepareSandbox, sandboxReady, type PreparedSandbox } from '../src/daemon/test-sandbox.js';
import { buildBisectEnv } from '../src/daemon/env.js';
import { repoCommonDir } from '../src/daemon/git.js';
import { parseAddonResult } from '../src/shared/addon-results.js';

// v1.1 /bisect against a real temporary repository with one planted bad commit: no model, no tokens. The user's checkout
// is only read; the bisect runs in a temporary copy under the test sandbox and ends with reset and the copy removed.
const run = promisify(execFile), roots: string[] = [], MAC = process.platform === 'darwin';
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
const git = async (cwd: string, ...args: string[]) => (await run('/usr/bin/git', [...ID, ...args], { cwd })).stdout.trim();
async function repoWithBadCommit(bad = 6, total = 10) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-bisect-'))); roots.push(root);
  const repo = join(root, 'repo'); await mkdir(repo);
  await git(root, 'init', '-q', '-b', 'main', '--', repo);
  await writeFile(join(repo, 'check.sh'), '#!/bin/sh\ngrep -qx ok state.txt\n'); await chmod(join(repo, 'check.sh'), 0o755);
  const commits: string[] = [];
  for (let n = 1; n <= total; n++) {
    await writeFile(join(repo, 'state.txt'), n < bad ? 'ok\n' : 'broken\n'); await writeFile(join(repo, `file${n}.txt`), `${n}\n`);
    await git(repo, 'add', '--', '.'); await git(repo, 'commit', '-qm', n === bad ? 'planted: break the state' : `change ${n}`, '--');
    commits.push(await git(repo, 'rev-parse', 'HEAD'));
  }
  // Uncommitted work of the user's, which must survive untouched.
  await writeFile(join(repo, 'notes.txt'), 'mine\n');
  return { root, repo, commits, badCommit: commits[bad - 1] ?? '' };
}
const snapshot = async (repo: string) => ({ head: await git(repo, 'rev-parse', 'HEAD'), branch: await git(repo, 'symbolic-ref', '--short', 'HEAD'), status: await git(repo, 'status', '--porcelain'), refs: await git(repo, 'for-each-ref', '--format=%(refname)'), worktrees: await git(repo, 'worktree', 'list', '--porcelain'), gitFiles: (await readdir(join(repo, '.git'))).sort().join(',') });
const sandboxFor = (repo: string) => async (path: string): Promise<PreparedSandbox | null> => {
  const box = await prepareSandbox(path, { home: homedir(), private: [], loopback: false, env: buildBisectEnv(process.env), readable: [await repoCommonDir(repo)] });
  if (await sandboxReady(box.profile, box.program, box.prefix)) return box;
  await box.dispose(); return null;
};

it('the plan reads the good ref from the last word, or goes back 32 commits; it refuses what it can\'t bisect', async () => {
  const { repo, commits } = await repoWithBadCommit();
  expect(await bisectPlan(repo, `./check.sh ${commits[1]}`)).toMatchObject({ command: ['./check.sh'], good: commits[1], bad: commits.at(-1), commits: 8 });
  expect(await bisectPlan(repo, './check.sh main~3')).toMatchObject({ command: ['./check.sh'], goodLabel: 'main~3', commits: 3 });
  // Fewer than 32 commits: the first commit is the good side.
  expect(await bisectPlan(repo, './check.sh')).toMatchObject({ command: ['./check.sh'], good: commits[0], goodLabel: 'the first commit', commits: 9 });
  await expect(bisectPlan(repo, './check.sh HEAD')).rejects.toThrow('Nothing to bisect');
  await expect(bisectPlan(repo, '"unclosed')).rejects.toThrow('/bisect <test command>');
});

it.skipIf(!MAC)('macOS: finds the planted commit in a sandboxed temporary copy; your checkout, refs and worktrees are untouched and the copy is gone', async () => {
  const { repo, badCommit } = await repoWithBadCommit();
  // A temp folder of this test's own: other files' workers make ai-term-clone-* folders in the shared one at the same time.
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ai-bisect-tmp-'))), saved = process.env.TMPDIR; roots.push(temp);
  process.env.TMPDIR = temp;
  const before = await snapshot(repo), clonesBefore = (await readdir(temp)).filter(n => n.startsWith('ai-term-clone-'));
  const plan = await bisectPlan(repo, './check.sh'), logs: string[] = [];
  let result: Awaited<ReturnType<typeof runBisect>>;
  try { result = await runBisect({ repo, plan, sandbox: sandboxFor(repo), unsandboxed: false, env: buildBisectEnv(process.env), log: text => logs.push(text) }); }
  finally { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; }
  expect(result).toMatchObject({ kind: 'bisect', commit: badCommit, subject: 'planted: break the state', author: 'Test' });
  expect(result.steps).toBeGreaterThan(0);
  expect(result.diff.join('\n')).toContain('-ok'); expect(result.diff.join('\n')).toContain('+broken');
  expect(parseAddonResult(JSON.stringify(result), 'bisect', true)).toEqual(result);
  expect(await snapshot(repo)).toEqual(before);
  expect((await readdir(temp)).filter(n => n.startsWith('ai-term-clone-'))).toEqual(clonesBefore);
  expect(logs, logs.join(' | ')).toEqual([]);
}, 60_000);

it('without a sandbox nothing runs unless you said Y; a test that passes at HEAD or fails at the good ref stops plainly', async () => {
  const { repo, commits } = await repoWithBadCommit();
  const plan = await bisectPlan(repo, './check.sh'), none = async () => null, env = buildBisectEnv(process.env), logs: string[] = [], log = (text: string) => { logs.push(text); };
  await expect(runBisect({ repo, plan, sandbox: none, unsandboxed: false, env, log })).rejects.toThrow('No sandbox here');
  // Y: the same bisect, with your rights.
  expect((await runBisect({ repo, plan, sandbox: none, unsandboxed: true, env, log })).subject).toBe('planted: break the state');
  await expect(runBisect({ repo, plan: await bisectPlan(repo, `./check.sh ${commits[7]}`), sandbox: none, unsandboxed: true, env, log })).rejects.toThrow('also fails at');
  await git(repo, 'checkout', '-q', '--detach', commits[2] ?? '');
  await expect(runBisect({ repo, plan: await bisectPlan(repo, `./check.sh ${commits[0]}`), sandbox: none, unsandboxed: true, env, log })).rejects.toThrow('passes at HEAD');
  expect(logs).toEqual([]);
}, 60_000);

it.skipIf(!MAC)('HIGH (security review): a sandboxed test that rewrites the copy\'s git config can\'t make a later git step run code outside the sandbox', async () => {
  const { root, repo } = await repoWithBadCommit();
  // The test command, inside the sandbox, plants a smudge filter in the copy's own config, then fails as usual.
  const escaped = join(root, 'escaped');
  await writeFile(join(repo, 'plant.sh'), `#!/bin/sh\nprintf '[filter "x"]\\n\\tsmudge = touch ${escaped} && cat\\n' >> .git/config\necho '* filter=x' > .git/info/attributes\nexec ./check.sh\n`);
  await chmod(join(repo, 'plant.sh'), 0o755);
  await git(repo, 'add', '--', 'plant.sh'); await git(repo, 'commit', '-qm', 'add plant', '--');
  const plan = await bisectPlan(repo, `./plant.sh ${await git(repo, 'rev-parse', 'HEAD~10')}`);
  await runBisect({ repo, plan, sandbox: sandboxFor(repo), unsandboxed: false, env: buildBisectEnv(process.env), log: () => {} }).catch(() => undefined);
  await expect(stat(escaped)).rejects.toThrow();
}, 60_000);

it('MEDIUM (security review): a bare branch name is part of the command; a hash, a tag or a revision like main~3 is the good ref', async () => {
  const { repo, commits } = await repoWithBadCommit();
  await git(repo, 'branch', '--', 'test', commits[1] ?? ''); await git(repo, 'tag', '--', 'v1', commits[2] ?? '');
  expect(await bisectPlan(repo, 'npm test')).toMatchObject({ command: ['npm', 'test'], good: commits[0] });
  expect(await bisectPlan(repo, './check.sh v1')).toMatchObject({ command: ['./check.sh'], good: commits[2], goodLabel: 'v1' });
  expect(await bisectPlan(repo, './check.sh test~0')).toMatchObject({ command: ['./check.sh'], good: commits[1] });
  expect(await bisectPlan(repo, `./check.sh ${(commits[3] ?? '').slice(0, 9)}`)).toMatchObject({ command: ['./check.sh'], good: commits[3] });
});
