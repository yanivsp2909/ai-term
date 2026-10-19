import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createServer } from 'node:net';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildTestEnv } from './env.js';
import type { PreparedSandbox } from './test-sandbox.js';
import { killGroup } from '../shared/kill-tree.js';
import { errorKind } from './log.js';

// v0.9.2 dev servers per worktree (D55, off by default; /settings y). The prompt's text for this part never arrived (it
// was cut off inside the queue part); the spec chosen: you start one with /dev after seeing exactly what runs, where, on
// which port and in which sandbox; it never starts or restarts by itself. Each worktree has its own port on 127.0.0.1.
// D56: the agent's code runs in the test sandbox with 127.0.0.1 open (macOS), or where no sandbox can hold a server your
// browser reaches (Linux's own network namespace, Windows), after you say so each time.
export const DEV_PORTS = { first: 4100, last: 4199 } as const;
// The worktree's port: the one it had, else the first in the range no other worktree holds and nothing listens on.
export function allocatePort(worktree: string, taken: ReadonlyMap<string, number>, free: (port: number) => boolean): number | null {
  const had = taken.get(worktree); if (had !== undefined) return had;
  const used = new Set(taken.values());
  for (let port = DEV_PORTS.first; port <= DEV_PORTS.last; port++) if (!used.has(port) && free(port)) return port;
  return null;
}
// Whether nothing listens on 127.0.0.1:port right now.
export function portFree(port: number): Promise<boolean> {
  return new Promise(resolve => { const server = createServer(); server.once('error', () => resolve(false)); server.listen(port, '127.0.0.1', () => server.close(() => resolve(true))); });
}
export async function allocateFreePort(worktree: string, taken: ReadonlyMap<string, number>): Promise<number | null> {
  const had = taken.get(worktree); if (had !== undefined) return had;
  const used = new Set(taken.values());
  for (let port = DEV_PORTS.first; port <= DEV_PORTS.last; port++) if (!used.has(port) && await portFree(port)) return port;
  return null;
}
// The test env (no keys, no AI Term variables) without CI, plus the port, 127.0.0.1 and no browser opened.
export function devEnv(base: NodeJS.ProcessEnv, port: number): Record<string, string> {
  const env = buildTestEnv(base); delete env.CI;
  return { ...env, PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none' };
}
export { devLines } from '../shared/dev.js';
// What `npm|pnpm|yarn|bun run <name>` (or `npm start`) would run, from the worktree's package.json, shown where nothing
// sandboxes it (review: the command words alone hide the agent's script). Plain text only; nothing when it can't tell.
export async function scriptOf(worktree: string, command: readonly string[]): Promise<string | undefined> {
  const [tool, verb, name] = command;
  if (!tool || !['npm', 'pnpm', 'yarn', 'bun'].includes(tool.replace(/^.*[\\/]/, '').replace(/\.(?:cmd|exe)$/i, ''))) return undefined;
  const script = verb === 'run' ? name : verb === 'start' ? 'start' : tool.includes('yarn') || tool.includes('pnpm') ? verb : undefined;
  if (!script) return undefined;
  let scripts: unknown;
  try { scripts = (JSON.parse(await readFile(join(worktree, 'package.json'), 'utf8')) as { scripts?: unknown }).scripts; }
  catch (error) { if (error instanceof SyntaxError || error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
  const value = scripts && typeof scripts === 'object' ? (scripts as Record<string, unknown>)[script] : undefined;
  return typeof value === 'string' && value.length <= 200 ? value.replace(DROP, '') : undefined;
}
const TAIL_LINES = 20, KILL_GRACE_MS = 2000, STOP_WAIT_MS = 5000, PARTIAL_MAX = 500;
// Escape sequences first (a lone ESC would otherwise leave `[32m` behind), then controls, bidi overrides and zero-width
// marks (review: they could dress up a line); a tab becomes two spaces and \r ends a line (progress bars), so every kept
// line is plain text the popup's checks accept.
// eslint-disable-next-line no-control-regex -- a server's own output never draws on the homepage.
const ESCAPES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex -- see above.
const DROP = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
// eslint-disable-next-line no-control-regex -- an escape cut at a chunk's end.
const OPEN_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b]*)?$/;
export interface Tail { lines: string[]; partial: string; decoder: StringDecoder }
export function emptyTail(): Tail { return { lines: [], partial: '', decoder: new StringDecoder('utf8') }; }
// A chunk of output into the tail; end: the stream closed, so a last line without a newline is kept too.
export function appendTail(tail: Tail, chunk: Buffer, end = false): Tail {
  let text = tail.partial + tail.decoder.write(chunk) + (end ? tail.decoder.end() : '');
  // An escape cut at the chunk's end waits for the rest.
  let held = '';
  const open = end ? null : text.match(OPEN_ESCAPE);
  if (open?.index !== undefined) { held = text.slice(open.index); text = text.slice(0, open.index); }
  const parts = text.replace(ESCAPES, '').replace(/\t/g, '  ').split(/\r\n|\r|\n/).map(line => line.replace(DROP, ''));
  const last = end ? '' : parts.pop() ?? '';
  const lines = [...tail.lines, ...parts.filter(line => line.trim()).map(line => [...line].slice(0, 200).join(''))].slice(-TAIL_LINES);
  return { lines, partial: (last + held).slice(-PARTIAL_MAX), decoder: tail.decoder };
}
interface Running { child: ChildProcessByStdio<null, Readable, Readable>; out: Tail; err: Tail; stopping: boolean; done: Promise<void>; box: PreparedSandbox | null }
export interface DevStart { command: readonly string[]; cwd: string; port: number; sandbox: PreparedSandbox | null; env: Record<string, string> }
export class DevServers {
  private readonly running = new Map<string, Running>();
  private closed = false;
  constructor(private readonly log: { error(text: string): void }) {}
  has(id: string): boolean { return this.running.has(id); }
  tail(id: string): string[] { const entry = this.running.get(id); return entry ? [...entry.out.lines, ...entry.err.lines].slice(-TAIL_LINES) : []; }
  // After this nothing starts (the daemon is stopping, review): a start that arrives late would outlive it.
  close(): void { this.closed = true; }
  // Resolves once the server is running; a program that can't start rejects, and its sandbox folder goes either way.
  // onExit: the server ended by itself (its exit code), not by stop().
  async start(id: string, plan: DevStart, onExit: (code: number | null) => void): Promise<void> {
    const refuse = async (message: string): Promise<never> => { await plan.sandbox?.dispose().catch((error: unknown) => this.log.error(`Dev server: its temp folder could not be removed (${errorKind(error)})`)); throw new Error(message); };
    if (this.closed) return refuse('AI Term is stopping; start it again after');
    if (this.running.has(id)) return refuse('A dev server already runs for this agent; /dev shows it');
    const [program, ...args] = [...plan.sandbox?.prefix ?? [], ...plan.command];
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try { child = spawn(program ?? '', args, { cwd: plan.cwd, env: { ...plan.env, ...plan.sandbox?.env ?? {}, PORT: String(plan.port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true }); }
    catch (error) { this.log.error(`Dev server couldn't start (${errorKind(error)})`); return refuse("The dev server couldn't start"); }
    let finished: () => void = () => {};
    const entry: Running = { child, out: emptyTail(), err: emptyTail(), stopping: false, done: new Promise<void>(resolve => { finished = resolve; }), box: plan.sandbox };
    this.running.set(id, entry);
    child.stdout.on('data', (chunk: Buffer) => { entry.out = appendTail(entry.out, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { entry.err = appendTail(entry.err, chunk); });
    let started = false;
    child.once('close', code => {
      entry.out = appendTail(entry.out, Buffer.alloc(0), true); entry.err = appendTail(entry.err, Buffer.alloc(0), true);
      this.running.delete(id); finished();
      void entry.box?.dispose().catch((error: unknown) => this.log.error(`Dev server: its temp folder could not be removed (${errorKind(error)})`));
      if (!entry.stopping && started) onExit(code);
    });
    let failure: unknown;
    started = await new Promise<boolean>(resolve => { child.once('spawn', () => resolve(true)); child.once('error', error => { failure = error; resolve(false); }); });
    if (!started) { entry.stopping = true; this.log.error(`Dev server couldn't start (${errorKind(failure)})`); throw new Error("The dev server couldn't start"); }
  }
  // Its whole process group: SIGTERM, then SIGKILL after 2 s (Windows: taskkill /T /F at once). At most 5 s: a child that
  // left the group and keeps the pipes open doesn't hold up removal or shutdown.
  async stop(id: string): Promise<void> {
    const entry = this.running.get(id); if (!entry) return;
    entry.stopping = true;
    const pid = entry.child.pid;
    const signal = (name: NodeJS.Signals) => { if (pid === undefined) return; try { killGroup(pid, name, () => this.log.error('Dev server could not be stopped')); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) this.log.error(`Dev server could not be stopped (${errorKind(error)})`); } };
    signal('SIGTERM');
    const kill = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS); kill.unref();
    let late: ReturnType<typeof setTimeout> | undefined;
    const waited = await Promise.race([entry.done.then(() => true), new Promise<boolean>(resolve => { late = setTimeout(() => resolve(false), STOP_WAIT_MS); late.unref(); })]);
    clearTimeout(kill); clearTimeout(late);
    if (!waited) { entry.child.stdout.destroy(); entry.child.stderr.destroy(); this.running.delete(id); this.log.error('Dev server did not stop in time; its pipes were closed'); }
  }
  async stopAll(): Promise<void> { await Promise.all([...this.running.keys()].map(id => this.stop(id))); }
}
