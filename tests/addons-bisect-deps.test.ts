import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bisectPlan, runBisect } from '../src/daemon/bisect.js';
import { prepareSandbox, sandboxReady, type PreparedSandbox } from '../src/daemon/test-sandbox.js';
import { buildBisectEnv } from '../src/daemon/env.js';
import { repoCommonDir } from '../src/daemon/git.js';
import { cloneCommand, cloneFolder } from '../src/daemon/dep-clone.js';

// B32: /bisect's copy holds only committed files, so a Node project's `npm test` failed on every commit. The main
// checkout's installed dependency folders are linked into the copy, readable but never writable inside the sandbox.
// B33: a read-only link still broke test runners that write a cache inside node_modules (Vitest's node_modules/.vite), so
// the copy gets its own copy-on-write clone where the disk can make one, and the read-only link only where it can't.
const run = promisify(execFile), roots: string[] = [], MAC = process.platform === 'darwin';
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
const git = async (cwd: string, ...args: string[]) => (await run('/usr/bin/git', [...ID, ...args], { cwd })).stdout.trim();
// A Node project whose test needs a dependency that only the installed node_modules has; commit 6 of 10 breaks it.
// The test also tries to write into node_modules/dep first (ignored when refused). cache: like Vitest, the runner writes
// node_modules/.cache and stops with an error when it can't.
async function nodeRepo(bad = 6, total = 10, cache = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-bisect-deps-'))); roots.push(root);
  const repo = join(root, 'repo'); await mkdir(repo);
  await git(root, 'init', '-q', '-b', 'main', '--', repo);
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'demo', private: true, scripts: { test: 'node test.js' } }));
  await writeFile(join(repo, 'test.js'), [
    "const fs = require('node:fs');",
    "try { fs.writeFileSync('node_modules/dep/planted.txt', 'x'); } catch {}",
    ...cache ? ["try { fs.mkdirSync('node_modules/.cache/demo', { recursive: true }); fs.writeFileSync(`node_modules/.cache/demo/${process.pid}.json`, '{}'); } catch { process.exit(3); }"] : [],
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
// Every entry under a folder, without following links: its path, kind, mode and size, a link's target, a file's bytes.
async function digest(folder: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name), info = await lstat(path);
      hash.update(`${path.slice(folder.length)}\0${info.mode}\0${info.size}\0`);
      if (info.isSymbolicLink()) hash.update(await readlink(path)); else if (info.isDirectory()) await walk(path); else hash.update(await readFile(path));
    }
  };
  await walk(folder); return hash.digest('hex');
}
// A temp folder of the test's own: other files' workers make ai-term-clone-* folders in the shared one at the same time.
async function ownTemp<T>(body: (temp: string) => Promise<T>): Promise<T> {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ai-bisect-deps-tmp-'))), saved = process.env.TMPDIR; roots.push(temp);
  process.env.TMPDIR = temp;
  try { return await body(temp); } finally { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; }
}
const noClone = async () => false;
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
  await expect(runBisect({ repo, plan: await bisectPlan(repo, 'npm test'), sandbox: without, unsandboxed: false, env: buildBisectEnv(process.env), clone: noClone, log: text => logs.push(text) })).rejects.toThrow('only committed files are there');
  expect(logs).toContain('Bisect: the sandbox couldn\'t open node_modules for reading; it isn\'t linked');
}, 60_000);

it('the popup\'s plan lists no dependencies where no sandbox can start, since nothing would be linked', async () => {
  const { repo } = await nodeRepo();
  expect((await bisectPlan(repo, 'npm test', false)).deps).toEqual([]);
});

it.skipIf(!MAC)('macOS, where the disk can\'t clone: npm test finds the planted commit through read-only links; nothing is written into your node_modules', async () => {
  const { repo, badCommit } = await nodeRepo();
  const status = await git(repo, 'status', '--porcelain'), logs: string[] = [];
  const result = await ownTemp(async temp => {
    const found = await runBisect({ repo, plan: await bisectPlan(repo, 'npm test'), sandbox: sandboxFor(repo), unsandboxed: false, env: buildBisectEnv(process.env), clone: noClone, log: text => logs.push(text) });
    expect((await readdir(temp)).filter(n => n.startsWith('ai-term-clone-'))).toEqual([]);
    return found;
  });
  expect(result).toMatchObject({ kind: 'bisect', commit: badCommit });
  // The write through the link failed every time: the main checkout's dependencies are as they were.
  await expect(stat(join(repo, 'node_modules', 'dep', 'planted.txt'))).rejects.toThrow();
  expect(await readdir(join(repo, 'node_modules'))).toEqual(['dep']);
  expect(await git(repo, 'status', '--porcelain')).toBe(status);
  expect(logs).toEqual(['Bisect: node_modules can\'t be cloned on this disk; it\'s linked read-only']);
}, 60_000);

it.skipIf(!MAC)('B33 macOS: a test runner that writes its cache inside node_modules finds the planted commit in a clone; your node_modules is byte-identical and the clone is gone', async () => {
  const { repo, badCommit } = await nodeRepo(6, 10, true);
  const before = await digest(join(repo, 'node_modules')), status = await git(repo, 'status', '--porcelain'), logs: string[] = [];
  // Without the clone this is B33: the cache write is refused at every commit, so the good ref fails too.
  await ownTemp(async () => {
    await expect(runBisect({ repo, plan: await bisectPlan(repo, 'npm test'), sandbox: sandboxFor(repo), unsandboxed: false, env: buildBisectEnv(process.env), clone: noClone, log: () => {} })).rejects.toThrow('also fails at');
  });
  const result = await ownTemp(async temp => {
    const found = await runBisect({ repo, plan: await bisectPlan(repo, 'npm test'), sandbox: sandboxFor(repo), unsandboxed: false, env: buildBisectEnv(process.env), log: text => logs.push(text) });
    expect((await readdir(temp)).filter(n => n.startsWith('ai-term-clone-'))).toEqual([]);
    return found;
  });
  expect(result).toMatchObject({ kind: 'bisect', commit: badCommit });
  expect(logs, logs.join(' | ')).toEqual([]);
  // The runner's cache and the write into node_modules/dep both landed in the clone, never here.
  expect(await digest(join(repo, 'node_modules'))).toBe(before);
  expect(await readdir(join(repo, 'node_modules'))).toEqual(['dep']);
  expect(await git(repo, 'status', '--porcelain')).toBe(status);
}, 60_000);

it.skipIf(!MAC)('B33 macOS: the clone never follows a link (one inside is copied as a link, a folder that is a link gives no clone), and writes to it stay there', async () => {
  const { root, repo } = await nodeRepo();
  const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'kept.txt'), 'kept\n');
  await symlink(outside, join(repo, 'node_modules', 'out'));
  const before = await digest(join(repo, 'node_modules')), copy = join(root, 'copy'); await mkdir(copy);
  expect(await cloneFolder(join(repo, 'node_modules'), join(copy, 'node_modules'))).toBe(true);
  expect((await lstat(join(copy, 'node_modules'))).isDirectory()).toBe(true);
  expect(await readlink(join(copy, 'node_modules', 'out'))).toBe(outside);
  await writeFile(join(copy, 'node_modules', 'dep', 'index.js'), 'changed\n'); await writeFile(join(copy, 'node_modules', 'dep', 'new.txt'), 'x\n');
  expect(await digest(join(repo, 'node_modules'))).toBe(before);
  // A dependency folder swapped for a link after the plan checked it: cp copies the link itself, which is removed.
  await symlink(outside, join(root, 'swapped'));
  expect(await cloneFolder(join(root, 'swapped'), join(copy, 'swapped'))).toBe(false);
  await expect(lstat(join(copy, 'swapped'))).rejects.toThrow();
  expect(await readdir(outside)).toEqual(['kept.txt']);
});

it('B33: the clone is cp with argv only and no link followed: -c (APFS clonefile) on macOS, --reflink=always on Linux, none elsewhere', () => {
  expect(cloneCommand('darwin', '/r/node_modules', '/t/repo/node_modules')).toEqual({ file: '/bin/cp', args: ['-c', '-P', '-R', '--', '/r/node_modules', '/t/repo/node_modules'] });
  // always, not auto: auto quietly makes a full copy where the file system can't share blocks; always fails, and the folder is linked read-only instead.
  expect(cloneCommand('linux', '/r/node_modules', '/t/repo/node_modules', '/usr/bin/cp')).toEqual({ file: '/usr/bin/cp', args: ['--reflink=always', '-P', '-R', '--', '/r/node_modules', '/t/repo/node_modules'] });
  expect(cloneCommand('linux', '/r/node_modules', '/t/repo/node_modules', null)).toBeNull();
  expect(cloneCommand('win32', 'C:\\r\\node_modules', 'C:\\t\\node_modules')).toBeNull();
});

it('B33: with Y and no sandbox nothing is cloned either, so the plan\'s "nothing added" holds', async () => {
  const { repo } = await nodeRepo(6, 10, true), clones: string[] = [];
  const clone = async (source: string) => { clones.push(source); return false; };
  await expect(runBisect({ repo, plan: await bisectPlan(repo, 'npm test'), sandbox: async () => null, unsandboxed: true, env: buildBisectEnv(process.env), clone, log: () => {} })).rejects.toThrow('also fails at');
  expect(clones).toEqual([]);
}, 60_000);
