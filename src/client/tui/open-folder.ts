import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isFsError } from '../../shared/paths.js';
import { basename, isAbsolute } from 'node:path';
import { findExecutable, systemTool } from '../../shared/executable.js';

export type FolderApp = 'finder' | 'code';
const defaultFind = (name: string): Promise<string | null> => findExecutable(name);
export type Runner = (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<void>;
// Fixed reasons only: the homepage shows them, and a child's own error text can carry anything.
export class OpenError extends Error {}
const OPEN_TIMEOUT_MS = 10_000;
// `code` gets the variables it needs to start, not the whole environment: API keys exported in this shell have no
// business in an editor AI Term opened.
const CODE_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM'];
const run: Runner = (file, args, env) => new Promise((resolve, reject) => {
  execFile(file, [...args], { env, timeout: OPEN_TIMEOUT_MS }, error => { if (error) reject(error); else resolve(); });
});
// /open: the agent's folder in Finder (/usr/bin/open) or VS Code (`code` from PATH). execFile with an argv array and
// `--` before the path, so the path is only ever a path.
// Linux (v0.8.1): xdg-open takes no `--`, so only an absolute path (checked above) reaches it, which can't read as an
// option. Windows: explorer.exe with the path as its one argument.
export async function openFolder(path: string, app: FolderApp, runner: Runner = run, find: (name: string) => Promise<string | null> = defaultFind, platform: NodeJS.Platform = process.platform): Promise<'Finder' | 'VS Code' | 'your file manager' | 'Explorer'> {
  if (!isAbsolute(path) || path.includes('\0')) throw new OpenError('folder path is not absolute');
  let folder;
  try { folder = await stat(path); }
  catch (error) { throw new OpenError(isFsError(error, 'ENOENT') || isFsError(error, 'ENOTDIR') ? 'folder is gone' : 'folder is unavailable'); }
  if (!folder.isDirectory()) throw new OpenError('folder is gone');
  if (app === 'finder' && platform === 'linux') {
    const opener = await (find === defaultFind ? systemTool('xdg-open') : find('xdg-open'));
    if (!opener) throw new OpenError("xdg-open isn't installed");
    try { await runner(opener, [path], { PATH: '/usr/bin:/bin' }); } catch { throw new OpenError("your file manager couldn't open it"); }
    return 'your file manager';
  }
  if (app === 'finder' && platform === 'win32') {
    // explorer.exe exits 1 even when it opened the folder.
    try { await runner(`${process.env.SystemRoot ?? 'C:\\Windows'}\\explorer.exe`, [path], {}); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 1)) throw new OpenError("Explorer couldn't open it"); }
    return 'Explorer';
  }
  if (app === 'finder') {
    // open launches a folder with an extension as a package (Tool.app, X.xcodeproj); -R only reveals it in Finder.
    const reveal = /\.[A-Za-z0-9]+$/.test(basename(path)) ? ['-R'] : [];
    try { await runner('/usr/bin/open', [...reveal, '--', path], { PATH: '/usr/bin:/bin' }); } catch { throw new OpenError("Finder couldn't open it"); }
    return 'Finder';
  }
  const code = await find('code');
  if (!code) throw new OpenError("VS Code's code command isn't on PATH");
  const env = Object.fromEntries(CODE_ENV.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
  try { await runner(code, ['--', path], env); } catch { throw new OpenError("VS Code couldn't open it"); }
  return 'VS Code';
}
