import { execFile } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';
interface CopyProcess extends EventEmitter { stdin: Writable | null }
export type CopyExecutor = (file: string, args: string[], options: { timeout: number }, callback: (error: Error | null) => void) => CopyProcess;
export function copyText(text: string, execute: CopyExecutor = execFile): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execute('/usr/bin/pbcopy', [], { timeout: 2000 }, error => { if (error) reject(error); else resolve(); });
    child.once('error', reject);
    child.once('close', code => { if (code === 0) resolve(); else reject(new Error('Copy failed')); });
    if (!child.stdin) { reject(new Error('Copy input unavailable')); return; }
    child.stdin.once('error', reject); child.stdin.end(text);
  });
}
