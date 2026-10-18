import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bisectPlan, runBisect } from '../src/daemon/bisect.js';
import { prepareSandbox, sandboxReady, type PreparedSandbox } from '../src/daemon/test-sandbox.js';
import { buildBisectEnv } from '../src/daemon/env.js';
import { repoCommonDir } from '../src/daemon/git.js';

// B32: /bisect's copy holds only committed files, so a Node project's `npm test` failed on every commit. The main
// checkout's installed dependency folders are linked into the copy, readable but never writable inside the sandbox.
const run = promisify(execFile), roots: string[] = [], MAC = process.platform === 'darwin';
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
const git = async (cwd: string, ...args: string[]) => (await run('/usr/bin/git', [...ID, ...args], { cwd })).stdout.trim();
// A Node project whose test needs a dependency that only the installed node_modules has; commit 6 of 10 breaks it.
// The test also tries to write through the link first: inside the sandbox that write must fail.
async function nodeRepo(bad = 6, total = 10) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-bisect-deps-'))); roots.push(root);
  const repo = join(root, 'repo'); await mkdir(repo);
  await git(root, 'init', '-q', '-b', 'main', '--', repo);
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'demo', private: true, scripts: { test: 'node test.js' } }));
  await writeFile(join(repo, 'test.js'), [
    "const fs = require('node:fs');",
    "try { fs.writeFileSync('node_modules/dep/planted.txt', 'x'); } catch {}",
    "const wrap = require('dep');",
    "process.exit(wrap(fs.readFileSync('state.txt', 'utf8').trim()) === '[ok]' ? 0 : 1);", ''].join('\n'));
  const commits: string[] = [];
  for (let n = 1; n <= total; n++) {
    await writeFile(join(repo, 'state.txt'), n < bad ? 'ok\n' : 'broken\n'); await writeFile(join(repo, `file${n}.txt`), `${n}\n`);
    await git(repo, 'add', '--', '.'); await git(repo, 'commit', '-qm', n === bad ? 'planted: break the state' : `change ${n}`, '--');
    commits.push(await git(repo, 'rev-parse', 'HEAD'));
  }
  // Installed, never committed: what `npm install` leaves behind.
  await mkdir(join(repo, 'node_modules', 'dep'), { recursive: true });
  await writeFile(join(repo, 'node_modules', 'dep', 'package.json'), JSON.stringify({ name: 'dep', main: 'index.js' }));
  await writeFile(join(repo, 'node_modules', 'dep', 'index.js'), "module.exports = s => '[' + s + ']';\n");
  return { root, repo, commits, badCommit: commits[bad - 1] ?? '' };
}
const sandboxFor = (repo: string) => async (path: string, readable: readonly string[] = []): Promise<PreparedSandbox | null> => {
  const box = await prepareSandbox(path, { home: homedir(), private: [], loopback: false, env: buildBisectEnv(process.env), readable: [await repoCommonDir(repo), ...readable] });
  if (await sandboxReady(box.profile, box.program, box.prefix)) return box;
  await box.dispose(); return null;
};

it('the plan links the installed dependency folders it finds; --no-deps turns them off; tracked or linked folders are left out', async () => {
  const { repo } = await nodeRepo();
  expect(await bisectPlan(repo, 'npm test')).toMatchObject({ command: ['npm', 'test'], deps: ['node_modules'] });
  expect(await bisectPlan(repo, '--no-deps npm test')).toMatchObject({ command: ['npm', 'test'], deps: [] });
  // vendor is committed here (the copy has it already); .venv is a link to somewhere else: neither is linked.
  await mkdir(join(repo, 'vendor')); await writeFile(join(repo, 'vendor', 'lib.txt'), 'x\n');
  await git(repo, 'add', '--', 'vendor'); await git(repo, 'commit', '-qm', 'vendor', '--');
  const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'ai-bisect-venv-'))); roots.push(elsewhere);
  await symlink(elsewhere, join(repo, '.venv'));
  await mkdir(join(repo, 'venv'));
  expect((await bisectPlan(repo, 'npm test')).deps).toEqual(['node_modules', 'venv']);
});

it('HIGH (TS review): with Y and no sandbox nothing is linked, so the test can\'t write into your installed dependencies', async () => {
  const { repo } = await nodeRepo();
  const env = buildBisectEnv(process.env), none = async () => null;
  await expect(runBisect({ repo, plan: await bisectPlan(repo, 'npm test'), sandbox: none, unsandboxed: true, env, log: () => {} })).rejects.toThrow('also fails at');
  await expect(stat(join(repo, 'node_modules', 'dep', 'planted.txt'))).rejects.toThrow();
}, 60_000);

it.skipIf(!MAC)('MEDIUM (TS review): a sandbox that couldn\'t open a dependency folder for reading gets no link, and says so', async () => {
  const { repo } = await nodeRepo(), logs: string[] = [];
  // A profile without the folder (as when a path can't go into a profile): the link would only fail every test.
  const without = async (path: string) => sandboxFor(repo)(path, []);
  await expect(runBisect({ repo, plan: await bisectPlan(repo, 'npm test'), sandbox: without, unsandboxed: false, env: buildBisectEnv(process.env), log: text => logs.push(text) })).rejects.toThrow('only committed files are there');
  expect(logs).toContain('Bisect: the sandbox couldn\'t open node_modules for reading; it isn\'t linked');
}, 60_000);

it('the popup\'s plan lists no dependencies where no sandbox can start, since nothing would be linked', async () => {
  const { repo } = await nodeRepo();
  expect((await bisectPlan(repo, 'npm test', false)).deps).toEqual([]);
});

it.skipIf(!MAC)('macOS: npm test finds the planted commit in the sandbox through read-only links; nothing is written into your node_modules', async () => {
  const { repo, badCommit } = await nodeRepo();
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ai-bisect-deps-tmp-'))), saved = process.env.TMPDIR; roots.push(temp);
  process.env.TMPDIR = temp;
  const status = await git(repo, 'status', '--porcelain'), logs: string[] = [];
  let result: Awaited<ReturnType<typeof runBisect>>;
  try { result = await runBisect({ repo, plan: await bisectPlan(repo, 'npm test'), sandbox: sandboxFor(repo), unsandboxed: false, env: buildBisectEnv(process.env), log: text => logs.push(text) }); }
  finally { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; }
  expect(result).toMatchObject({ kind: 'bisect', commit: badCommit });
  // The write through the link failed every time: the main checkout's dependencies are as they were.
  await expect(stat(join(repo, 'node_modules', 'dep', 'planted.txt'))).rejects.toThrow();
  expect(await readdir(join(repo, 'node_modules'))).toEqual(['dep']);
  expect(await git(repo, 'status', '--porcelain')).toBe(status);
  expect((await readdir(temp)).filter(n => n.startsWith('ai-term-clone-'))).toEqual([]);
  expect(logs, logs.join(' | ')).toEqual([]);
}, 60_000);
