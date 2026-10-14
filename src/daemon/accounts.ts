import { lstat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { CliEngine } from '../shared/protocol.js';
import { isAccountName } from '../shared/accounts.js';
import { isFsError, privateDirectory } from '../shared/paths.js';

// v0.6.4 (D53, D17): each account profile is the CLI's own config folder under ~/.ai-term/profiles/<name> (0700). Your skills,
// agents and commands are shared into it by symlinks to those folders only (the D48 roots), never to credentials, settings
// or history, so the CLI keeps the account's login and history apart while your extensions stay one set.
const SHARED: Record<CliEngine, { home: string; folders: readonly string[] }> = {
  'claude-code': { home: '.claude', folders: ['skills', 'agents', 'commands'] },
  codex: { home: '.codex', folders: ['prompts', 'skills', 'agents'] },
};
export function profileDir(root: string, name: string): string {
  if (!isAccountName(name)) throw new Error('Invalid account name');
  return join(root, 'profiles', name);
}
export async function prepareProfile(root: string, engine: CliEngine, name: string, home: string): Promise<string> {
  const dir = profileDir(root, name);
  // privateDirectory refuses a symlink or a folder owned by someone else, at both levels.
  await privateDirectory(join(root, 'profiles')); await privateDirectory(dir);
  const shared = SHARED[engine];
  for (const folder of shared.folders) {
    const target = join(home, shared.home, folder), link = join(dir, folder);
    // Only the folder's existence is checked (lstat); nothing in it is read.
    try { if (!(await lstat(target)).isDirectory() && !(await lstat(target)).isSymbolicLink()) continue; }
    catch (error) { if (isFsError(error, 'ENOENT')) continue; throw error; }
    try { await symlink(target, link); }
    catch (error) { if (!isFsError(error, 'EEXIST')) throw error; }
  }
  return dir;
}
