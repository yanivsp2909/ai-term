import { expect, it } from 'vitest';
import { chmod, lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bisectPlan, runBisect } from '../src/daemon/bisect.js';
import { buildBisectEnv } from '../src/daemon/env.js';
import { cloneFolder } from '../src/daemon/dep-clone.js';
import { MAC, sandboxFor, useBisectRepos } from './fixtures/bisect-deps.js';

// B33 review: a clone that fails says why and leaves nothing behind; a read-only folder inside node_modules doesn't keep
// the copy from being removed.
const { locked, nodeRepo, ownTemp } = useBisectRepos();

it.skipIf(!MAC)('MEDIUM (TS review): a clone that fails says why (cp\'s exit, not "this disk"), leaves nothing behind, and the folder is linked instead', async () => {
  const { root, repo, badCommit } = await nodeRepo(), copy = join(root, 'copy'); await mkdir(copy);
  // An unreadable file makes cp stop with exit 1 after part of the tree is cloned.
  const secret = join(repo, 'node_modules', 'dep', 'unreadable.txt'); await writeFile(secret, 'x\n'); await chmod(secret, 0o000); locked.push({ path: secret, mode: 0o644 });
  expect(await cloneFolder(join(repo, 'node_modules'), join(copy, 'node_modules'))).toEqual({ ok: false, why: 'cp exited 1' });
  await expect(lstat(join(copy, 'node_modules'))).rejects.toThrow();
  const logs: string[] = [], plan = await bisectPlan(repo, 'node test.js');
  const result = await ownTemp(() => runBisect({ repo, plan, sandbox: sandboxFor(repo), unsandboxed: false, env: buildBisectEnv(process.env), log: text => logs.push(text) }));
  expect(result).toMatchObject({ commit: badCommit });
  expect(logs).toEqual(['Bisect: node_modules wasn\'t cloned (cp exited 1); it\'s linked read-only']);
}, 60_000);

it.skipIf(!MAC)('LOW (TS review): a read-only folder inside node_modules is cloned read-only, and the copy is still removed; a failed clone with one falls back instead of stopping', async () => {
  const { root, repo, badCommit } = await nodeRepo(6, 10, true);
  const ro = join(repo, 'node_modules', 'ro'); await mkdir(ro); await writeFile(join(ro, 'kept.txt'), 'x\n'); await chmod(ro, 0o555); locked.push({ path: ro, mode: 0o755 });
  const logs: string[] = [];
  await ownTemp(async temp => {
    expect(await runBisect({ repo, plan: await bisectPlan(repo, 'node test.js'), sandbox: sandboxFor(repo), unsandboxed: false, env: buildBisectEnv(process.env), log: text => logs.push(text) })).toMatchObject({ commit: badCommit });
    expect(await readdir(temp)).toEqual([]);
  });
  expect(logs, logs.join(' | ')).toEqual([]);
  // cp stopping on an unreadable file after it made the read-only folder: removed all the same, and a plain false.
  const secret = join(repo, 'node_modules', 'zz-unreadable.txt'); await writeFile(secret, 'x\n'); await chmod(secret, 0o000); locked.push({ path: secret, mode: 0o644 });
  const copy = join(root, 'copy'); await mkdir(copy);
  expect(await cloneFolder(join(repo, 'node_modules'), join(copy, 'node_modules'))).toEqual({ ok: false, why: 'cp exited 1' });
  await expect(lstat(join(copy, 'node_modules'))).rejects.toThrow();
}, 60_000);
