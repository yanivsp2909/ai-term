import { existsSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
// git: /usr/bin/git on macOS and Linux (a fixed path, not whatever PATH holds). Windows (v0.8.2): Git for Windows' git.exe
// in its usual place, else the first git.exe on PATH; its own folder (for its helpers) and System32 are the child's PATH.
// Git for Windows reads /dev/null in config values and paths as its null device, so those stay as they are.
const WINDOWS_GIT = ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe'];
export function nullDevice(platform: NodeJS.Platform = process.platform): string { return platform === 'win32' ? 'NUL' : '/dev/null'; }
// A PATH entry that can't be looked into (missing, a file, no access, a loop, a bad name) just has no git: this runs at import.
const isFile = (path: string): boolean => { try { return statSync(path).isFile(); } catch (error) { if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EINVAL', 'ELOOP', 'ENAMETOOLONG'].includes(String(error.code))) return false; throw error; } };
export function gitExecutable(platform: NodeJS.Platform = process.platform, path: string = process.env.PATH ?? '', places: readonly string[] = WINDOWS_GIT): string | null {
  if (platform !== 'win32') return '/usr/bin/git';
  const found = places.find(existsSync) ?? path.split(delimiter).filter(isAbsolute).map(folder => join(folder, 'git.exe')).find(isFile);
  return found ?? null;
}
// null on Windows without Git for Windows: git features then fail plainly, never through a bare git.exe that Windows would
// look for in the repository's own folder first (review).
export const GIT: string | null = gitExecutable();
export const GIT_PATH = process.platform === 'win32' ? [...GIT ? [dirname(GIT)] : [], `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`].join(delimiter) : '/usr/bin:/bin';
// Windows programs need SystemRoot (and git its temp folder); nothing else of the daemon's env goes to git.
export const GIT_SYSTEM: Record<string, string> = process.platform === 'win32' ? Object.fromEntries(['SystemRoot', 'TEMP', 'TMP', 'USERPROFILE'].flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name] ?? '']])) : {};
