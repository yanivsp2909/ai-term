import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveInside, JailError } from '../src/agent/jail.js';
import { writeTool, readTool, editTool } from '../src/agent/tools.js';

// The file tools never reach outside the agent's folder: not by `..`, not by an absolute path, not through a symlink.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ai-jail-'))); roots.push(temp);
  const root = join(temp, 'work'), outside = join(temp, 'outside');
  await mkdir(root); await mkdir(outside); await writeFile(join(outside, 'secret.txt'), 'outside');
  await writeFile(join(root, 'a.txt'), 'inside\n');
  return { temp, root, outside };
}

it('relative and absolute paths inside the folder resolve; new files in new folders too', async () => {
  const { root } = await fixture();
  expect(await resolveInside(root, 'a.txt')).toBe(join(root, 'a.txt'));
  expect(await resolveInside(root, join(root, 'a.txt'))).toBe(join(root, 'a.txt'));
  expect(await resolveInside(root, 'new/deeper/b.txt')).toBe(join(root, 'new/deeper/b.txt'));
  expect(await resolveInside(root, '.')).toBe(root);
});

it.each(['../outside/secret.txt', 'sub/../../outside/secret.txt', '/etc/passwd', '..', '', 'a\0b'])('refuses %j', async path => {
  const { root } = await fixture();
  await expect(resolveInside(root, path)).rejects.toBeInstanceOf(JailError);
});

it('refuses symlinks that lead outside, for files, folders and not-yet-existing children', async () => {
  const { root, outside } = await fixture();
  await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
  await symlink(outside, join(root, 'linkdir'));
  await expect(resolveInside(root, 'link.txt')).rejects.toBeInstanceOf(JailError);
  await expect(resolveInside(root, 'linkdir/secret.txt')).rejects.toBeInstanceOf(JailError);
  await expect(resolveInside(root, 'linkdir/new.txt')).rejects.toBeInstanceOf(JailError);
  await expect(readTool(root, { path: 'link.txt' })).rejects.toThrow('outside the folder');
  await expect(writeTool.run(root, { path: 'linkdir/new.txt', content: 'x' })).rejects.toThrow('outside the folder');
  await expect(editTool.run(root, { path: 'link.txt', old: 'outside', new: 'pwned' })).rejects.toThrow('outside the folder');
  expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside');
});

it('a symlink that stays inside the folder is fine, and a write never follows a final-component symlink', async () => {
  const { root } = await fixture();
  await symlink(join(root, 'a.txt'), join(root, 'alias.txt'));
  expect(await resolveInside(root, 'alias.txt')).toBe(join(root, 'a.txt'));
  expect(await readTool(root, { path: 'alias.txt' })).toContain('inside');
});
