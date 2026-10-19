import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import headless from '@xterm/headless';
import { Homepage } from '../src/client/tui/homepage.js';
import { AddonPanel } from '../src/client/tui/addon-panel.js';
import { AddonService } from '../src/daemon/addons.js';
import { tempClone } from '../src/daemon/temp-clone.js';
import { OWNER_FILE, sweepTemp } from '../src/daemon/temp-sweep.js';
import type { AddonAsk } from '../src/shared/addons.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SessionInfo, SuccessResponse } from '../src/shared/protocol.js';
import { AS_ROOT } from './platform.js';

// The backlog fixes' reviews (TypeScript and security, fresh context): each finding here failed before its fix.
const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { await exec('/bin/chmod', ['-R', 'u+rwX', root]).catch(() => undefined); await rm(root, { recursive: true, force: true }); } });
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-f-rev-'))); roots.push(dir); return dir; }
const present = async (path: string) => { try { await lstat(path); return true; } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; } };
class TTY extends EventEmitter { isTTY = true; columns = 130; rows = 45; output = ''; setRawMode() {} resume() {} pause() {} write(s: string | Buffer) { this.output += String(s); return true; } }
async function screen(tty: TTY) { const term = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true }); try { await new Promise<void>(r => term.write(tty.output, r)); return Array.from({ length: 45 }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n'); } finally { term.dispose(); } }
const bisectAsk = (): AddonAsk => ({ receipt: randomUUID(), name: 'bisect', summary: 'Bisect', cwd: '/tmp', target: null, brain: 'none', brainNeed: 'none', worktree: false, readOnly: true, files: [], inputTokens: { low: 0, high: 0 }, outputTokens: { low: 0, high: 0 }, priceUsd: { low: 0, high: 0 }, subscription: false,
  bisect: { command: ['npm', 'test'], good: 'a'.repeat(40), bad: 'b'.repeat(40), goodLabel: 'HEAD~32', commits: 3, deps: [], sandbox: true } });

it('TS MEDIUM: a new /bisect while one runs is refused, so the running one stays reachable (and x can stop it)', async () => {
  const requests: RequestBody[] = [];
  const client = Object.assign(new EventEmitter(), { async request(body: RequestBody): Promise<SuccessResponse> {
    requests.push(body); const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.get') response.settings = { theme: 'graphite' }; if (body.kind === 'sessions.list') response.sessions = [] as SessionInfo[]; if (body.kind === 'keys.list') response.keys = [];
    if (body.kind === 'sessions.preview') { response.snapshot = ''; response.cols = 85; response.rows = 30; }
    if (body.kind === 'addons.plan') response.addonAsk = bisectAsk();
    if (body.kind === 'addons.start') response.addonRun = randomUUID();
    return response;
  } });
  const tty = new TTY(), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', terminalProgram: 'unknown' }); await home.start();
  try {
    tty.emit('data', Buffer.from('/bisect npm test\r')); await vi.waitFor(async () => expect(await screen(tty)).toContain('y starts'), { timeout: 10_000 });
    tty.emit('data', Buffer.from('y')); await vi.waitFor(async () => expect(await screen(tty)).toContain('x stops it'), { timeout: 10_000 });
    tty.emit('data', Buffer.from('\x1b')); await vi.waitFor(async () => expect(await screen(tty)).not.toContain('x stops it'), { timeout: 10_000 });
    tty.emit('data', Buffer.from('/bisect npm test HEAD~5\r'));
    await vi.waitFor(async () => expect(await screen(tty)).toContain('a /bisect is running here · /bisect opens it, x there stops it'), { timeout: 10_000 });
    expect(requests.filter(r => r.kind === 'addons.plan')).toHaveLength(1);
  } finally { await home.stop(); }
}, 30_000);

it('TS LOW: x before the run has started stops nothing, so the popup keeps offering x instead of saying Stopping', () => {
  let started = false;
  const actions = { start: vi.fn(), build: vi.fn(), approve: vi.fn(), step: vi.fn(), copy: vi.fn(), choose: vi.fn(), cancel: vi.fn(() => started) };
  const p = new AddonPanel(() => {}, () => {}, actions);
  p.setAsk(bisectAsk()); p.key('y'); p.key('x');
  expect(actions.cancel).toHaveBeenCalledTimes(1); expect(p.lines.join('\n')).toContain('x stops it'); expect(p.lines.join('\n')).not.toContain('Stopping');
  started = true; p.key('x'); expect(p.lines.join('\n')).toContain('Stopping');
});

it('TS LOW and security LOW 6: the temporary copy itself stops with the run (git clone and checkout)', async () => {
  const dir = await temp(), repo = join(dir, 'repo'); await mkdir(repo); await exec('/usr/bin/git', ['init', '-q', '-b', 'main', '--', repo]);
  await exec('/usr/bin/git', ['-c', 'user.name=T', '-c', 'user.email=t@e.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'c', '--allow-empty'], { cwd: repo });
  const head = (await exec('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim(), base = await realpath(tmpdir());
  const before = new Set((await readdir(base)).filter(name => name.startsWith('ai-term-clone-')));
  const stopped = new AbortController(); stopped.abort();
  await expect(tempClone(repo, head, stopped.signal)).rejects.toThrow();
  expect((await readdir(base)).filter(name => name.startsWith('ai-term-clone-') && !before.has(name))).toEqual([]);
});

it.skipIf(AS_ROOT)('TS LOW and security LOW 1: the sweep skips an impossible pid quietly, and never changes a folder it is locked out of (skipped as root: file modes do not stop root)', async () => {
  const dir = await temp(), logs: string[] = [];
  const huge = join(dir, 'ai-term-test-aaaaaa'); await mkdir(huge); await writeFile(join(huge, OWNER_FILE), 'ai-term 9999999999\n');
  // Follow-up review: a locked folder's mark can't be read, so it may not be AI Term's at all: it is left exactly as it is.
  const locked = join(dir, 'ai-term-test-bbbbbb'); await mkdir(locked); await writeFile(join(locked, OWNER_FILE), 'ai-term 999999\n'); await chmod(locked, 0o000);
  expect(await sweepTemp({ dir, log: text => logs.push(text) })).toBe(0);
  expect(await present(huge)).toBe(true); expect(await present(locked)).toBe(true);
  expect((await lstat(locked)).mode & 0o777).toBe(0);
  expect(logs).toEqual([]);
});

it('follow-up LOW: the daemon runs one /bisect per folder, whatever the client shows', async () => {
  const root = await temp(), runner = { addonBisect: vi.fn(() => new Promise(() => {})) };
  const service = new AddonService(root, root, runner as never);
  const start = (service as unknown as { startBisect(input: unknown, plan: unknown, unsandboxed: boolean): string }).startBisect.bind(service);
  start({ addon: { name: 'bisect', local: 'bisect' }, cwd: '/tmp/a' }, { sandbox: true }, false);
  expect(() => start({ addon: { name: 'bisect', local: 'bisect' }, cwd: '/tmp/a' }, { sandbox: true }, false)).toThrow('A /bisect is already running in this folder');
  start({ addon: { name: 'bisect', local: 'bisect' }, cwd: '/tmp/b' }, { sandbox: true }, false);
  expect(runner.addonBisect).toHaveBeenCalledTimes(2);
});

it('security LOW 4: an A/B that fails on a system error says so in fixed words, never with its path', async () => {
  const id = randomUUID(), root = await temp();
  const runner = { addonPerfAb: async () => { throw Object.assign(new Error(`ENOENT: no such file or directory, open '${root}/bench/a.js'`), { code: 'ENOENT' }); } };
  const logs: string[] = [], service = new AddonService(root, root, runner as never, undefined, text => logs.push(text));
  (service as unknown as { runs: Map<string, unknown> }).runs.set(id, { input: {}, nonce: '', result: { kind: 'perf', measured: 'm', change: 'c', benchmark: ['node', 'bench/a.js'], files: [] } });
  service.startAb(id, false);
  await vi.waitFor(() => expect(service.ab(id)?.state).toBe('failed'));
  const ab = service.ab(id);
  expect(ab?.state === 'failed' ? ab.reason : '').not.toContain(root);
  expect(logs.join('\n')).not.toContain(root);
});

it('security LOW 5: once the daemon is stopping, no new /bisect or A/B starts', async () => {
  const root = await temp(), runner = { addonBisect: vi.fn(() => new Promise(() => {})), addonPerfAb: vi.fn(() => new Promise(() => {})) };
  const service = new AddonService(root, root, runner as never), id = randomUUID();
  (service as unknown as { runs: Map<string, unknown> }).runs.set(id, { input: {}, nonce: '', result: { kind: 'perf', measured: 'm', change: 'c', benchmark: ['node', 'bench/a.js'], files: [] } });
  await service.stopAll();
  const start = (service as unknown as { startBisect(input: unknown, plan: unknown, unsandboxed: boolean): string }).startBisect.bind(service);
  expect(() => start({ addon: { name: 'bisect', local: 'bisect' }, cwd: '/tmp' }, { sandbox: true }, false)).toThrow('AI Term is stopping');
  expect(() => service.startAb(id, false)).toThrow('AI Term is stopping');
  expect(runner.addonBisect).not.toHaveBeenCalled(); expect(runner.addonPerfAb).not.toHaveBeenCalled();
});
