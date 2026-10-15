import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createServer } from 'node:net';
import type { Readable } from 'node:stream';
import { buildTestEnv } from './env.js';
import type { PreparedSandbox } from './test-sandbox.js';
import { killGroup } from '../shared/kill-tree.js';
import type { DevPlan } from '../shared/dev.js';

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
type Tone = 'ink' | 'ink-2' | 'ink-3' | 'status-error' | 'status-done';
export function devLines(plan: DevPlan): { text: string; tone: Tone }[] {
  const command = plan.command.map(word => /[\s"'\\]/.test(word) ? JSON.stringify(word) : word).join(' ');
  return [
    { text: `Dev server for ${plan.title}`, tone: 'ink' },
    { text: `$ ${command}`, tone: 'ink-2' },
    { text: `in ${plan.cwd} · http://127.0.0.1:${plan.port} · PORT=${plan.port}`, tone: 'ink-3' },
    plan.sandbox ? { text: 'sandbox: listens on 127.0.0.1 only · writes only in this worktree and a temp folder · no internet', tone: 'ink-3' }
      : { text: `${plan.why ?? 'no sandbox'} · it runs with your user's rights`, tone: 'status-error' },
    ...plan.running ? [{ text: `▶ running · http://127.0.0.1:${plan.port}`, tone: 'status-done' as const }, ...plan.tail.map(line => ({ text: `  ${line}`, tone: 'ink-3' as const }))] : [],
    { text: plan.running ? 'x stops it · Esc closes' : 'y starts it · n or Esc starts nothing', tone: 'ink-3' },
  ];
}
const TAIL_LINES = 20, KILL_GRACE_MS = 2000;
// eslint-disable-next-line no-control-regex -- a server's own output never draws on the homepage.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]|\u001b\[[0-9;?]*[A-Za-z]/g;
interface Running { child: ChildProcessByStdio<null, Readable, Readable>; tail: string[]; partial: string; stopping: boolean; done: Promise<void>; box: PreparedSandbox | null }
export interface DevStart { command: readonly string[]; cwd: string; port: number; sandbox: PreparedSandbox | null; env: Record<string, string> }
export class DevServers {
  private readonly running = new Map<string, Running>();
  constructor(private readonly log: { error(text: string): void }) {}
  has(id: string): boolean { return this.running.has(id); }
  tail(id: string): string[] { return [...this.running.get(id)?.tail ?? []]; }
  // onExit: the server ended by itself (its exit code), not by stop().
  async start(id: string, plan: DevStart, onExit: (code: number | null) => void): Promise<void> {
    if (this.running.has(id)) throw new Error('A dev server already runs for this agent; /dev shows it');
    const [program, ...args] = [...plan.sandbox?.prefix ?? [], ...plan.command];
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try { child = spawn(program ?? '', args, { cwd: plan.cwd, env: { ...plan.env, ...plan.sandbox?.env ?? {}, PORT: String(plan.port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true }); }
    catch { await plan.sandbox?.dispose(); throw new Error("The dev server couldn't start"); }
    let finished: () => void = () => {};
    const entry: Running = { child, tail: [], partial: '', stopping: false, done: new Promise<void>(resolve => { finished = resolve; }), box: plan.sandbox };
    const read = (chunk: Buffer) => {
      const lines = (entry.partial + chunk.toString('utf8')).replace(CONTROL, '').split(/\r?\n/);
      entry.partial = (lines.pop() ?? '').slice(-500);
      entry.tail.push(...lines.filter(line => line.trim()).map(line => line.slice(0, 200)));
      if (entry.tail.length > TAIL_LINES) entry.tail.splice(0, entry.tail.length - TAIL_LINES);
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.once('error', () => this.log.error("Dev server couldn't start"));
    child.once('close', code => {
      this.running.delete(id); finished();
      void entry.box?.dispose().catch(() => this.log.error('Dev server: its temp folder could not be removed'));
      if (!entry.stopping) onExit(code);
    });
    this.running.set(id, entry);
  }
  // Its whole process group: SIGTERM, then SIGKILL after 2 s (Windows: taskkill /T /F at once).
  async stop(id: string): Promise<void> {
    const entry = this.running.get(id); if (!entry) return;
    entry.stopping = true;
    const pid = entry.child.pid;
    const signal = (name: NodeJS.Signals) => { if (pid === undefined) return; try { killGroup(pid, name, () => this.log.error('Dev server could not be stopped')); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) this.log.error('Dev server could not be stopped'); } };
    signal('SIGTERM');
    const timer = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS); timer.unref();
    await entry.done; clearTimeout(timer);
  }
  async stopAll(): Promise<void> { await Promise.all([...this.running.keys()].map(id => this.stop(id))); }
}
