import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { isFsError } from '../shared/paths.js';
// The bash tool on Windows (v0.8.2): Git for Windows' bash.exe, next to its git.exe (cmd\git.exe → bin\bash.exe), or at
// its usual place. System32\bash.exe is WSL's, which would run the command in another system: never that one.
export const GIT_BASH_PLACES: readonly string[] = ['C:\\Program Files\\Git\\bin\\bash.exe'];
export async function findGitBash(git: string | null, candidates: readonly string[] = GIT_BASH_PLACES): Promise<string | null> {
  const near = git && isAbsolute(git) ? [join(dirname(dirname(git)), 'bin', 'bash.exe')] : [];
  for (const path of [...near, ...candidates]) {
    if (/[\\/]system32[\\/]/i.test(path)) continue;
    try { if ((await stat(path)).isFile()) return path; }
    catch (error) { if (!isFsError(error, 'ENOENT') && !isFsError(error, 'ENOTDIR')) throw error; }
  }
  return null;
}
