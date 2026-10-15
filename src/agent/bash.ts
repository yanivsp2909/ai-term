import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { SANDBOX_EXEC, SandboxPathError, sandboxPath } from '../daemon/test-sandbox.js';
import { visible } from './display.js';
import { isFsError } from '../shared/paths.js';
import { ToolError } from './tools.js';

// A command line longer than this is refused before any approval: a person can still read it whole.
export const BASH_MAX_COMMAND_BYTES = 16 * 1024;
export const BASH_DEFAULT_TIMEOUT_MS = 120_000, BASH_MAX_TIMEOUT_MS = 600_000, BASH_OUTPUT_MAX_BYTES = 64 * 1024;
const KILL_GRACE_MS = 1000;
export interface BashResult { exitCode: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; interrupted: boolean; cut: boolean; stopFailed: boolean }
// sandbox: AI Term's own folder (~/.ai-term). Gate (Yaniv): on macOS a command runs under sandbox-exec with a profile that
// lets it do what you could, except read or write that folder (its settings, budgets, keys' metadata, other agents'
// files; the agent's own worktree in it stays open) or connect to AI Term's sockets there. Without sandbox-exec (another
// OS) it runs as before.
// protect: git folders whose hooks and config a command may not write (the repository a worktree shares its .git with:
// a hook planted there would run unsandboxed at your next commit).
export interface BashOptions { cwd: string; env: Record<string, string>; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal; sandbox?: { home: string; protect?: readonly string[] } }
export function bashProfile(home: string, cwd: string, protect: readonly string[] = []): string {
  const own = cwd.startsWith(`${home}/`) ? [`(allow file-read-data file-read-xattr file-write* (subpath "${sandboxPath(cwd)}"))`, `(allow network-outbound (remote unix-socket (subpath "${sandboxPath(cwd)}")))`] : [];
  return ['(version 1)', '(allow default)',
    // No debugger attach (task ports) and no peeking into other processes: the agent's and daemon's memory hold the key and
    // AI Term's credentials (fix review). Their own child processes stay visible.
    '(deny mach-priv-task-port)', '(deny process-info* (target others))',
    `(deny file-read-data file-read-xattr file-write* (subpath "${sandboxPath(home)}"))`, `(deny network-outbound (remote unix-socket (subpath "${sandboxPath(home)}")))`, ...own,
    ...protect.map(dir => `(deny file-write* (subpath "${sandboxPath(join(dir, 'hooks'))}") (literal "${sandboxPath(join(dir, 'config'))}"))`), ''].join('\n');
}
// The argv that runs a command line: sandboxed when it can be; a folder no profile can hold is refused, never run bare.
async function bashArgv(command: string, options: BashOptions): Promise<[string, string[]]> {
  const plain: [string, string[]] = ['/bin/sh', ['-c', command]];
  if (!options.sandbox || process.platform !== 'darwin') return plain;
  try { await access(SANDBOX_EXEC, constants.X_OK); } catch { return plain; }
  const [home, cwd] = await Promise.all([realpath(options.sandbox.home).catch(() => options.sandbox?.home ?? ''), realpath(options.cwd)]);
  let profile: string;
  try { profile = bashProfile(home, cwd, await Promise.all((options.sandbox.protect ?? []).map(dir => realpath(dir).catch(() => dir)))); } catch (error) { if (error instanceof SandboxPathError) throw new ToolError("bash can't run here: AI Term can't sandbox a folder with quotes, parentheses or control characters in its path"); throw error; }
  return [SANDBOX_EXEC, ['-p', profile, '--', '/bin/sh', '-c', command]];
}

// The bash tool runs the model's command line as one argv element of /bin/sh -c: running that line *is* the tool, and it is
// the one shell AI Term starts (S8). It gets its own process group so a timeout or Esc stops everything it started, a
// fixed env with no key (buildBashEnv), no stdin, and capped output.
// Process groups of commands still running, so the kill switch and a stop of the agent can end them all at once.
const running = new Set<number>();
export function killAllBash(): number {
  let count = 0;
  for (const pid of running) { try { process.kill(-pid, 'SIGKILL'); count++; } catch (error) { if (!isFsError(error, 'ESRCH')) count++; } }
  return count;
}
export async function runBash(command: string, options: BashOptions): Promise<BashResult> {
  const timeoutMs = Math.min(BASH_MAX_TIMEOUT_MS, Math.max(1000, options.timeoutMs ?? BASH_DEFAULT_TIMEOUT_MS)), maxBytes = options.maxBytes ?? BASH_OUTPUT_MAX_BYTES;
  const [program, args] = await bashArgv(command, options);
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    if (child.pid !== undefined) running.add(child.pid);
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
    child.on('error', error => { if (child.pid !== undefined) running.delete(child.pid); if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); reject(error); });
    child.on('close', (code, signal) => {
      if (child.pid !== undefined) running.delete(child.pid);
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
