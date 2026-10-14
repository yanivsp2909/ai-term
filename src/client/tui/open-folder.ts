import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { findExecutable } from '../../shared/executable.js';

export type FolderApp = 'finder' | 'code';
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
export async function openFolder(path: string, app: FolderApp, runner: Runner = run, find = findExecutable): Promise<'Finder' | 'VS Code'> {
  if (!isAbsolute(path) || path.includes('\0')) throw new OpenError('folder path is not absolute');
  let folder;
  try { folder = await stat(path); } catch { throw new OpenError('folder is gone'); }
  if (!folder.isDirectory()) throw new OpenError('folder is gone');
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
