import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import headless from '@xterm/headless';
import { bisectPlan, BISECT_STOPPED, runBisect } from '../src/daemon/bisect.js';
import { AB_STOPPED, runAb } from '../src/daemon/perf-ab.js';
import { runTests } from '../src/daemon/test-run.js';
import { AddonService } from '../src/daemon/addons.js';
import { AddonPanel } from '../src/client/tui/addon-panel.js';
import { Homepage } from '../src/client/tui/homepage.js';
import { validateRequest } from '../src/shared/validate.js';
import { parseAddonResult } from '../src/shared/addon-results.js';
import type { AddonAsk } from '../src/shared/addons.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SessionInfo, SuccessResponse } from '../src/shared/protocol.js';
import { processRuns } from './platform.js';

// Backlog F1 (batch 1 suggestion, B33 LOW-3): x stops a running /bisect or /perf A/B: its processes are stopped, its
// temporary copy is removed, and the popup says "stopped". Esc still only closes (D58: closing never stops), and
// /bisect alone reopens the last one, so a closed run can be stopped too.
const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-f1-'))); roots.push(dir); return dir; }
const ID = ['-c', 'user.name=T', '-c', 'user.email=t@e.invalid', '-c', 'commit.gpgsign=false'];
const alive = processRuns;
const gone = async (path: string) => { try { await lstat(path); return false; } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true; throw error; } };

it('a stopped /bisect ends its test processes, removes its temporary copy and says stopped', async () => {
  const root = await temp(), repo = join(root, 'repo'), marks = join(root, 'marks'); await mkdir(repo); await mkdir(marks);
  await exec('/usr/bin/git', ['init', '-q', '-b', 'main', '--', repo]);
  for (const n of [1, 2, 3]) { await writeFile(join(repo, `f${n}.txt`), `${n}\n`); await exec('/usr/bin/git', [...ID, 'add', '--', `f${n}.txt`], { cwd: repo }); await exec('/usr/bin/git', [...ID, 'commit', '-qm', `c${n}`], { cwd: repo }); }
  // The test command starts a child that would outlive a plain kill of its parent, and says where it runs.
  const plan = await bisectPlan(repo, `sh -c ${JSON.stringify(`sleep 60 & echo $! > ${marks}/pid; pwd > ${marks}/cwd; wait`)} HEAD~2`, false);
  const controller = new AbortController();
  const result = runBisect({ repo, plan, sandbox: async () => null, unsandboxed: true, env: { PATH: '/usr/bin:/bin' }, log: () => {}, signal: controller.signal,
    run: (command, cwd, env, _box, timeoutMs, signal) => runTests(command, cwd, env, { timeoutMs, ...signal ? { signal } : {} }) });
  await vi.waitFor(async () => expect((await readFile(join(marks, 'pid'), 'utf8').catch(() => '')).trim()).toMatch(/^\d+$/), { timeout: 10_000 });
  const pid = Number((await readFile(join(marks, 'pid'), 'utf8')).trim()), copy = (await readFile(join(marks, 'cwd'), 'utf8')).trim();
  expect(alive(pid)).toBe(true);
  controller.abort();
  await expect(result).rejects.toThrow(BISECT_STOPPED);
  await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5_000 });
  expect(await gone(copy)).toBe(true);
  expect(BISECT_STOPPED).toMatch(/^■ stopped/);
}, 30_000);

it('a stopped A/B ends the run in progress and says stopped', async () => {
  const controller = new AbortController(); let runs = 0;
  const side = (cwd: string) => ({ cwd, run: (signal?: AbortSignal) => { runs++; return new Promise<{ state: 'cancelled' }>(done => { signal?.addEventListener('abort', () => done({ state: 'cancelled' }), { once: true }); }); } });
  const view = runAb(side('/before'), side('/after'), { sandbox: true, signal: controller.signal });
  await vi.waitFor(() => expect(runs).toBe(1)); controller.abort();
  expect(await view).toEqual({ state: 'failed', reason: AB_STOPPED });
  expect(runs).toBe(1);
});

it('the add-on service stops a running /bisect or A/B on addons.cancel, and refuses one with nothing running', async () => {
  const signals: AbortSignal[] = [];
  const runner = {
    addonBisect: (_cwd: string, _plan: unknown, _unsandboxed: boolean, signal?: AbortSignal) => new Promise<never>((_done, fail) => { if (signal) signals.push(signal); signal?.addEventListener('abort', () => fail(new (class extends Error {})('x'))); }),
  };
  const service = new AddonService(await temp(), await temp(), runner as never);
  const start = (service as unknown as { startBisect(input: unknown, plan: unknown, unsandboxed: boolean): string }).startBisect.bind(service);
  const id = start({ addon: { name: 'bisect', local: 'bisect' }, cwd: '/tmp' }, { sandbox: true }, false);
  expect(signals).toHaveLength(1); expect(signals[0]?.aborted).toBe(false);
  service.cancel(id);
  expect(signals[0]?.aborted).toBe(true);
  expect(() => service.cancel(randomUUID())).toThrow('Add-on run not found');
});

it('x stops a running /bisect or A/B from the popup; Esc only closes it', () => {
  const actions = { start: vi.fn(), build: vi.fn(), approve: vi.fn(), step: vi.fn(), copy: vi.fn(), choose: vi.fn(), cancel: vi.fn(() => true), ab: vi.fn() }, close = vi.fn();
  const bisect: AddonAsk = { receipt: randomUUID(), name: 'bisect', summary: 'Bisect', cwd: '/tmp', target: null, brain: 'none', brainNeed: 'none', worktree: false, readOnly: true, files: [], inputTokens: { low: 0, high: 0 }, outputTokens: { low: 0, high: 0 }, priceUsd: { low: 0, high: 0 }, subscription: false,
    bisect: { command: ['npm', 'test'], good: 'a'.repeat(40), bad: 'b'.repeat(40), goodLabel: 'HEAD~32', commits: 3, deps: [], sandbox: true } };
  const p = new AddonPanel(() => {}, close, actions);
  p.setAsk(bisect); p.key('x'); expect(actions.cancel).not.toHaveBeenCalled();
  p.key('y'); expect(p.lines.join('\n')).toContain('x stops it');
  p.key('x'); expect(actions.cancel).toHaveBeenCalledTimes(1); expect(p.lines.join('\n')).toContain('Stopping');
  p.key('escape'); expect(close).toHaveBeenCalled(); expect(actions.cancel).toHaveBeenCalledTimes(1);
  const perf = new AddonPanel(() => {}, () => {}, actions);
  perf.setResult(parseAddonResult(JSON.stringify({ kind: 'perf', measured: 'ran it', change: 'faster', benchmark: ['node', 'bench/a.js'], files: [] }), 'perf', true));
  perf.setAb({ state: 'running' }); expect(perf.lines.join('\n')).toContain('x stops it');
  perf.key('x'); expect(actions.cancel).toHaveBeenCalledTimes(2); expect(perf.lines.join('\n')).toContain('stopping the A/B');
  perf.setAb({ state: 'failed', reason: AB_STOPPED }); expect(perf.lines.join('\n')).toContain('■ A/B stopped');
});

it('addons.cancel is a valid request for one run id only', async () => {
  await expect(validateRequest({ id: randomUUID(), kind: 'addons.cancel', sessionId: randomUUID() })).resolves.toMatchObject({ kind: 'addons.cancel' });
  await expect(validateRequest({ id: randomUUID(), kind: 'addons.cancel', sessionId: 'nope' })).rejects.toThrow();
  await expect(validateRequest({ id: randomUUID(), kind: 'addons.cancel', sessionId: randomUUID(), more: 1 })).rejects.toThrow();
});

class TTY extends EventEmitter { isTTY = true; columns = 130; rows = 45; output = ''; setRawMode() {} resume() {} pause() {} write(s: string | Buffer) { this.output += String(s); return true; } }
async function screen(tty: TTY) { const term = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true }); try { await new Promise<void>(r => term.write(tty.output, r)); return Array.from({ length: 45 }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n'); } finally { term.dispose(); } }

it('/bisect alone reopens the running /bisect, and x there stops it', async () => {
  const run = randomUUID(), requests: RequestBody[] = [];
  const client = Object.assign(new EventEmitter(), { async request(body: RequestBody): Promise<SuccessResponse> {
    requests.push(body); const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.get') response.settings = { theme: 'graphite' }; if (body.kind === 'sessions.list') response.sessions = [] as SessionInfo[]; if (body.kind === 'keys.list') response.keys = [];
    if (body.kind === 'sessions.preview') { response.snapshot = ''; response.cols = 85; response.rows = 30; }
    if (body.kind === 'addons.plan') response.addonAsk = { receipt: randomUUID(), name: 'bisect', summary: 'Bisect', cwd: '/tmp', target: null, brain: 'none', brainNeed: 'none', worktree: false, readOnly: true, files: [], inputTokens: { low: 0, high: 0 }, outputTokens: { low: 0, high: 0 }, priceUsd: { low: 0, high: 0 }, subscription: false,
      bisect: { command: ['npm', 'test'], good: 'a'.repeat(40), bad: 'b'.repeat(40), goodLabel: 'HEAD~32', commits: 3, deps: [], sandbox: true } };
    if (body.kind === 'addons.start') response.addonRun = run;
    return response;
  } });
  const tty = new TTY(), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', terminalProgram: 'unknown' }); await home.start();
  try {
    tty.emit('data', Buffer.from('/bisect npm test\r'));
    await vi.waitFor(async () => expect(await screen(tty)).toContain('y starts'), { timeout: 10_000 });
    tty.emit('data', Buffer.from('y'));
    await vi.waitFor(async () => expect(await screen(tty)).toContain('x stops it'), { timeout: 10_000 });
    tty.emit('data', Buffer.from('\x1b')); await vi.waitFor(async () => expect(await screen(tty)).not.toContain('x stops it'), { timeout: 10_000 });
    expect(requests.some(r => r.kind === 'addons.cancel')).toBe(false);
    tty.emit('data', Buffer.from('/bisect\r'));
    await vi.waitFor(async () => expect(await screen(tty)).toContain('x stops it'), { timeout: 10_000 });
    expect(requests.filter(r => r.kind === 'addons.plan')).toHaveLength(1);
    tty.emit('data', Buffer.from('x'));
    await vi.waitFor(() => expect(requests).toContainEqual({ kind: 'addons.cancel', sessionId: run }), { timeout: 10_000 });
  } finally { await home.stop(); }
}, 30_000);
