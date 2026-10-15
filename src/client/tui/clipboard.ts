import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';
import { systemTool } from '../../shared/executable.js';
interface CopyProcess extends EventEmitter { stdin: Writable | null }
export type CopyExecutor = (file: string, args: string[], options: { timeout: number }, callback: (error: Error | null) => void) => CopyProcess;
export interface CopyPlatform { platform: NodeJS.Platform; env: Readonly<Record<string, string | undefined>>; find: (name: string) => Promise<string | null> }
const here: CopyPlatform = { platform: process.platform, env: process.env, find: name => systemTool(name) };
// Only stdin is a pipe: xclip stays in the background to serve the selection, and inherited output pipes would keep the
// copy waiting until another app took it (TS review). Done when the tool itself exits.
const spawnCopy: CopyExecutor = (file, args, options, callback) => {
  const child = spawn(file, args, { stdio: ['pipe', 'ignore', 'ignore'], timeout: options.timeout });
  child.once('exit', code => callback(code === 0 ? null : new Error('Copy failed')));
  return child;
};
// The clipboard tool for this system, by fixed name, run with an argv array: macOS's pbcopy; on Linux wl-copy under
// Wayland, else xclip or xsel (v0.8.1); Windows' clip.exe.
async function copier(system: CopyPlatform): Promise<[string, string[]]> {
  if (system.platform === 'darwin') return ['/usr/bin/pbcopy', []];
  if (system.platform === 'win32') return [`${system.env.SystemRoot ?? 'C:\\Windows'}\\System32\\clip.exe`, []];
  const tools: [string, string[]][] = [...system.env.WAYLAND_DISPLAY ? [['wl-copy', []] as [string, string[]]] : [], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [name, args] of tools) { const path = await system.find(name); if (path) return [path, args]; }
  throw new Error('no clipboard tool (install wl-clipboard, xclip or xsel)');
}
export async function copyText(text: string, execute: CopyExecutor = spawnCopy, system: CopyPlatform = here): Promise<void> {
  const [file, args] = await copier(system);
  return new Promise((resolve, reject) => {
    const child = execute(file, args, { timeout: 2000 }, error => { if (error) reject(error); else resolve(); });
    child.once('error', reject);
    child.once('close', code => { if (code === 0) resolve(); else reject(new Error('Copy failed')); });
    if (!child.stdin) { reject(new Error('Copy input unavailable')); return; }
    child.stdin.once('error', reject); child.stdin.end(text);
  });
}
