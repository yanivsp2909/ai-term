import { expect, it } from 'vitest';
import { lstat, mkdir, readdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bisectPlan, runBisect } from '../src/daemon/bisect.js';
import { buildBisectEnv } from '../src/daemon/env.js';
import { cloneCommand, cloneFolder } from '../src/daemon/dep-clone.js';
import { MAC, digest, git, noClone, sandboxFor, useBisectRepos } from './fixtures/bisect-deps.js';

// B33: a read-only link still broke test runners that write a cache inside node_modules (Vitest's node_modules/.vite), so
// the copy gets its own copy-on-write clone where the disk can make one (src/daemon/dep-clone.ts).
const { nodeRepo, ownTemp } = useBisectRepos();

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
  expect(await cloneFolder(join(repo, 'node_modules'), join(copy, 'node_modules'))).toEqual({ ok: true });
  expect((await lstat(join(copy, 'node_modules'))).isDirectory()).toBe(true);
  expect(await readlink(join(copy, 'node_modules', 'out'))).toBe(outside);
  await writeFile(join(copy, 'node_modules', 'dep', 'index.js'), 'changed\n'); await writeFile(join(copy, 'node_modules', 'dep', 'new.txt'), 'x\n');
  expect(await digest(join(repo, 'node_modules'))).toBe(before);
  // A dependency folder swapped for a link after the plan checked it: cp copies the link itself, which is removed.
  await symlink(outside, join(root, 'swapped'));
  expect(await cloneFolder(join(root, 'swapped'), join(copy, 'swapped'))).toEqual({ ok: false, why: 'it is a link now' });
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

it.skipIf(!MAC)('HIGH (TS review): a cloned .venv whose scripts name the original venv by its absolute path (shebangs do) still runs: the original stays readable', async () => {
  const { repo, badCommit } = await nodeRepo();
  // A venv's console scripts start with #!<checkout>/.venv/bin/python, and that python reads <checkout>/.venv/pyvenv.cfg.
  await mkdir(join(repo, '.venv', 'bin'), { recursive: true }); await writeFile(join(repo, '.venv', 'pyvenv.cfg'), 'home = /usr/bin\n');
  await symlink('/bin/sh', join(repo, '.venv', 'bin', 'sh'));
  await writeFile(join(repo, '.venv', 'bin', 'tool'), `#!${join(repo, '.venv', 'bin', 'sh')}\ncat '${join(repo, '.venv', 'pyvenv.cfg')}' >/dev/null || exit 3\ngrep -qx ok state.txt\n`, { mode: 0o755 });
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n.venv/\n');
  const plan = await bisectPlan(repo, '.venv/bin/tool'), logs: string[] = [];
  expect(plan.deps).toEqual(['node_modules', '.venv']);
  const result = await ownTemp(() => runBisect({ repo, plan, sandbox: sandboxFor(repo), unsandboxed: false, env: buildBisectEnv(process.env), log: text => logs.push(text) }));
  expect(result).toMatchObject({ commit: badCommit });
  expect(logs, logs.join(' | ')).toEqual([]);
}, 60_000);
