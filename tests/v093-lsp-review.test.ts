import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { LspPool, formatDiagnostics, LSP_WAIT_MS, type LspSpawn } from '../src/agent/lsp.js';
import type { Deadline } from '../src/shared/deadline.js';
import { buildBashEnv } from '../src/daemon/env.js';

// v0.9.3 review (typescript-reviewer, fresh context): each failed before its fix.
const MAC = process.platform === 'darwin', roots: string[] = [], pools: LspPool[] = [];
afterEach(async () => { for (const pool of pools.splice(0)) await pool.stopAll(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
// B31: the deadline is a manual timer and starts are counted at spawn, so a slow sandboxed start on a loaded machine
// can't decide what a test sees: only a test's own fire() ends a wait.
function manualClock() {
  const pending: { ms: number; fire: () => void }[] = [];
  const deadline: Deadline = (ms, fire) => { const entry = { ms, fire }; pending.push(entry); return () => { pending.splice(pending.indexOf(entry) >>> 0, 1); }; };
  return { deadline, waiting: (ms: number) => pending.filter(entry => entry.ms === ms).length, fire: (ms: number) => { for (const entry of pending.filter(e => e.ms === ms)) { pending.splice(pending.indexOf(entry), 1); entry.fire(); } } };
}
async function setup(server: string) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-lsp-rev-'))); roots.push(dir);
  const bin = join(dir, 'bin'), tree = join(dir, 'home', '.ai-term', 'worktrees', 'r', 'a'), aiTerm = join(dir, 'home', '.ai-term');
  await mkdir(bin); await mkdir(tree, { recursive: true });
  await writeFile(join(bin, 'typescript-language-server'), `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(join(tree, 'starts.log'))}, 'x');\n${server}\n`); await chmod(join(bin, 'typescript-language-server'), 0o755);
  await writeFile(join(tree, 'a.ts'), 'ERROR\n');
  const env = { ...buildBashEnv(process.env), PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: join(dir, 'home') };
  const clock = manualClock(), children: ReturnType<LspSpawn>[] = [];
  const counted: LspSpawn = (program, args, options) => { const child = spawn(program, args, options); children.push(child); return child; };
  const pool = new LspPool({ root: tree, env, sandbox: { home: aiTerm }, deadline: clock.deadline, spawn: counted }); pools.push(pool);
  const starts = async () => (await readFile(join(tree, 'starts.log'), 'utf8').catch(() => '')).length;
  return { pool, starts, clock, children };
}

it.skipIf(!MAC)('HIGH: a server that never answers initialize can\'t hold a write: it gives up at its deadline, and an interrupted turn stops waiting at once', async () => {
  const { pool, clock } = await setup("process.stdin.resume(); setInterval(() => {}, 1000);");
  const write = pool.diagnose('a.ts');
  // The write waits on the default 8 s deadline, however long the sandboxed start takes; passing it ends the wait.
  await vi.waitFor(() => expect(clock.waiting(LSP_WAIT_MS)).toBe(1), { timeout: 15_000 });
  clock.fire(LSP_WAIT_MS);
  expect(await write).toBe("diagnostics for a.ts: the language server didn't answer in time");
  const abort = new AbortController(), again = pool.diagnose('a.ts', abort.signal);
  await vi.waitFor(() => expect(clock.waiting(LSP_WAIT_MS)).toBe(1), { timeout: 15_000 });
  abort.abort();
  // No deadline fired: only the interrupt can have ended this wait, and its timer is gone with it.
  expect(await again).toBe('');
  expect(clock.waiting(LSP_WAIT_MS)).toBe(0);
}, 20_000);

it.skipIf(!MAC)('MEDIUM: a server that crashes at start answers at once, is said once, and isn\'t started again on every write', async () => {
  const { pool, starts, clock } = await setup('process.exit(1);');
  // No deadline ever fires here, so the answer can only come from the crash itself, not from a wait running out.
  expect(await pool.diagnose('a.ts')).toBe("diagnostics for a.ts: typescript-language-server stopped; diagnostics for this language are off until the agent restarts");
  expect(await pool.diagnose('a.ts')).toBe('');
  expect(clock.waiting(LSP_WAIT_MS)).toBe(0);
  // The server logs its start before it exits, and its exit came before the answer: the count is final.
  expect(await starts()).toBe(1);
}, 20_000);

it.skipIf(!MAC)('MEDIUM: two writes at once start one server, and stopping leaves none behind', async () => {
  const { pool, clock, children } = await setup("process.stdin.resume(); setInterval(() => {}, 1000);");
  const abort = new AbortController(), both = Promise.all([pool.diagnose('a.ts', abort.signal), pool.diagnose('a.ts', abort.signal)]);
  // Both writes are past the start and waiting on the one server before the turn is interrupted.
  await vi.waitFor(() => expect(clock.waiting(LSP_WAIT_MS)).toBe(2), { timeout: 15_000 });
  abort.abort(); await both;
  expect(children).toHaveLength(1);
  expect(pool.running()).toEqual(['typescript']);
  await pool.stopAll();
  expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
}, 20_000);

it('LOW: a diagnostic without a column, with an odd code or severity still reads plainly', () => {
  const text = formatDiagnostics('a.ts', [{ range: { start: { line: 0 } }, severity: 'bad', code: { value: 'x' }, message: 'm' } as never]);
  expect(text).toBe('diagnostics for a.ts: 1 error\n1:1 error m');
});
