import { spawn } from 'node:child_process';
import { visible } from './display.js';
import { isFsError } from '../shared/paths.js';
import { ToolError } from './tools.js';

// A command line longer than this is refused before any approval: a person can still read it whole.
export const BASH_MAX_COMMAND_BYTES = 16 * 1024;
export const BASH_DEFAULT_TIMEOUT_MS = 120_000, BASH_MAX_TIMEOUT_MS = 600_000, BASH_OUTPUT_MAX_BYTES = 64 * 1024;
const KILL_GRACE_MS = 1000;
export interface BashResult { exitCode: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; interrupted: boolean; cut: boolean; stopFailed: boolean }
export interface BashOptions { cwd: string; env: Record<string, string>; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal }

// The bash tool runs the model's command line as one argv element of /bin/sh -c: running that line *is* the tool, and it is
// the one shell AI Term starts (S8). It gets its own process group so a timeout or Esc stops everything it started, a
// fixed env with no key (buildBashEnv), no stdin, and capped output.
export function runBash(command: string, options: BashOptions): Promise<BashResult> {
  const timeoutMs = Math.min(BASH_MAX_TIMEOUT_MS, Math.max(1000, options.timeoutMs ?? BASH_DEFAULT_TIMEOUT_MS)), maxBytes = options.maxBytes ?? BASH_OUTPUT_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    let outBytes = 0, errBytes = 0, cut = false, timedOut = false, interrupted = false, settled = false, stopFailed = false;
    const take = (chunks: Buffer[], chunk: Buffer, used: number): number => {
      const room = maxBytes - used;
      if (room <= 0) { cut = true; return used; }
      if (chunk.length > room) { cut = true; chunks.push(chunk.subarray(0, room)); return maxBytes; }
      chunks.push(chunk); return used + chunk.length;
    };
    child.stdout.on('data', (chunk: Buffer) => { outBytes = take(out, chunk, outBytes); });
    child.stderr.on('data', (chunk: Buffer) => { errBytes = take(err, chunk, errBytes); });
    const stopGroup = (): void => {
      const pid = child.pid; if (pid === undefined) return;
      // ESRCH: the whole group already exited. Anything else means it may still run, and the report says so.
      const signal = (name: NodeJS.Signals): void => { try { process.kill(-pid, name); } catch (error) { if (!isFsError(error, 'ESRCH')) stopFailed = true; } };
      signal('SIGTERM'); setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => { timedOut = true; stopGroup(); }, timeoutMs);
    const onAbort = (): void => { interrupted = true; stopGroup(); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.on('error', error => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); reject(error); });
    child.on('close', (code, signal) => {
      if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut, interrupted, cut, stopFailed });
    });
  });
}

// What the model reads back: exit status first, then the two streams, each marked if it was cut.
export function bashReport(result: BashResult, timeoutMs: number): string {
  const status = result.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s; the command and everything it started were stopped` : result.interrupted ? 'interrupted by the user' : result.exitCode !== null ? `exit ${result.exitCode}` : `stopped by ${result.signal ?? 'a signal'}`;
  const parts = [status];
  if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
  if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
  if (result.stopFailed) parts.push('(some processes it started could not be stopped)');
  if (result.cut) parts.push(`(output cut at ${BASH_OUTPUT_MAX_BYTES} bytes per stream)`);
  return parts.join('\n');
}

export function checkCommand(command: unknown): string {
  if (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command) > BASH_MAX_COMMAND_BYTES) throw new ToolError(`command must be text up to ${BASH_MAX_COMMAND_BYTES} bytes`);
  return command;
}
export function bashPreview(command: string, timeoutMs: number): { title: string; body: string } {
  return { title: `bash · ${Math.round(timeoutMs / 1000)}s limit`, body: visible(command) };
}
