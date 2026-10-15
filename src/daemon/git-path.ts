import { existsSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
// git: /usr/bin/git on macOS and Linux (a fixed path, not whatever PATH holds). Windows (v0.8.2): Git for Windows' git.exe
// in its usual place, else the first git.exe on PATH; its own folder (for its helpers) and System32 are the child's PATH.
// Git for Windows reads /dev/null in config values and paths as its null device, so those stay as they are.
const WINDOWS_GIT = ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe'];
export function nullDevice(platform: NodeJS.Platform = process.platform): string { return platform === 'win32' ? 'NUL' : '/dev/null'; }
const isFile = (path: string): boolean => { try { return statSync(path).isFile(); } catch (error) { if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'EACCES'].includes(String(error.code))) return false; throw error; } };
export function gitExecutable(platform: NodeJS.Platform = process.platform, path: string = process.env.PATH ?? ''): string {
  if (platform !== 'win32') return '/usr/bin/git';
  const found = WINDOWS_GIT.find(existsSync) ?? path.split(delimiter).filter(isAbsolute).map(folder => join(folder, 'git.exe')).find(isFile);
  return found ?? 'git.exe';
}
export const GIT = gitExecutable();
export const GIT_PATH = process.platform === 'win32' ? [dirname(GIT), `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`].join(delimiter) : '/usr/bin:/bin';
