import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bisectPlan, runBisect } from '../src/daemon/bisect.js';
import { buildBisectEnv } from '../src/daemon/env.js';
import { MAC, git, noClone, sandboxFor, useBisectRepos } from './fixtures/bisect-deps.js';

// B32: /bisect's copy holds only committed files, so a Node project's `npm test` failed on every commit. The main
// checkout's installed dependency folders are linked into the copy, readable but never writable inside the sandbox
// (B33 clones them first, tests/b33-bisect-clone*.test.ts; these are the plan, Y, and the link where no clone is made).
const { roots, nodeRepo, ownTemp } = useBisectRepos();

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
  expect(logs).toEqual(['Bisect: node_modules wasn\'t cloned (this disk can\'t clone); it\'s linked read-only']);
}, 60_000);

it('B33: with Y and no sandbox nothing is cloned either, so the plan\'s "nothing added" holds', async () => {
  const { repo } = await nodeRepo(6, 10, true), clones: string[] = [];
  const clone = async (source: string) => { clones.push(source); return { ok: false as const, why: 'test' }; };
  await expect(runBisect({ repo, plan: await bisectPlan(repo, 'npm test'), sandbox: async () => null, unsandboxed: true, env: buildBisectEnv(process.env), clone, log: () => {} })).rejects.toThrow('also fails at');
  expect(clones).toEqual([]);
}, 60_000);

it('LOW (security review): where no sandbox starts and you didn\'t press Y, it refuses before cloning anything (no wait for clones it won\'t use)', async () => {
  const { repo } = await nodeRepo(), clones: string[] = [];
  const clone = async (source: string) => { clones.push(source); return { ok: true as const }; };
  await expect(runBisect({ repo, plan: await bisectPlan(repo, 'npm test'), sandbox: async () => null, unsandboxed: false, env: buildBisectEnv(process.env), clone, log: () => {} })).rejects.toThrow('No sandbox here');
  expect(clones).toEqual([]);
});
