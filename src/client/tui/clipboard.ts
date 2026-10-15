import { execFile } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';
import { findExecutable } from '../../shared/executable.js';
interface CopyProcess extends EventEmitter { stdin: Writable | null }
export type CopyExecutor = (file: string, args: string[], options: { timeout: number }, callback: (error: Error | null) => void) => CopyProcess;
export interface CopyPlatform { platform: NodeJS.Platform; env: Readonly<Record<string, string | undefined>>; find: (name: string) => Promise<string | null> }
const here: CopyPlatform = { platform: process.platform, env: process.env, find: name => findExecutable(name) };
// The clipboard tool for this system, by fixed name, run with an argv array: macOS's pbcopy; on Linux wl-copy under
// Wayland, else xclip or xsel (v0.8.1); Windows' clip.exe.
async function copier(system: CopyPlatform): Promise<[string, string[]]> {
  if (system.platform === 'darwin') return ['/usr/bin/pbcopy', []];
  if (system.platform === 'win32') return [`${system.env.SystemRoot ?? 'C:\\Windows'}\\System32\\clip.exe`, []];
  const tools: [string, string[]][] = [...system.env.WAYLAND_DISPLAY ? [['wl-copy', []] as [string, string[]]] : [], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [name, args] of tools) { const path = await system.find(name); if (path) return [path, args]; }
  throw new Error('no clipboard tool: install wl-clipboard, xclip or xsel');
}
export async function copyText(text: string, execute: CopyExecutor = execFile, system: CopyPlatform = here): Promise<void> {
  const [file, args] = await copier(system);
  return new Promise((resolve, reject) => {
    const child = execute(file, args, { timeout: 2000 }, error => { if (error) reject(error); else resolve(); });
    child.once('error', reject);
    child.once('close', code => { if (code === 0) resolve(); else reject(new Error('Copy failed')); });
    if (!child.stdin) { reject(new Error('Copy input unavailable')); return; }
    child.stdin.once('error', reject); child.stdin.end(text);
  });
}
