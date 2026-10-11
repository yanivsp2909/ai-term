import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { lstat, mkdir, chmod } from 'node:fs/promises';
export interface Paths { root: string; run: string; logs: string; state: string; pid: string; socket: string; log: string }
export function getPaths(root = process.env.AI_TERM_HOME ?? join(homedir(), '.ai-term')): Paths {
  if (!isAbsolute(root) || root.includes('\0')) throw new Error('AI_TERM_HOME must be an absolute path');
  return { root, run: join(root, 'run'), logs: join(root, 'logs'), state: join(root, 'state.json'), pid: join(root, 'run/daemon.pid'), socket: join(root, 'run/daemon.sock'), log: join(root, 'logs/daemon.log') };
}
export function isFsError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
export async function privateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (!isFsError(error, 'EEXIST')) throw error; }
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid?.()) throw new Error('Private directory must be a real directory owned by this user');
  await chmod(path, 0o700);
}
export async function preparePaths(paths: Paths): Promise<void> {
  await privateDirectory(paths.root); await privateDirectory(paths.run); await privateDirectory(paths.logs);
}
