import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, lstat, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { getPaths, preparePaths, type Paths } from '../src/shared/paths.js';
import { Connection } from '../src/client/connection.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { DaemonServer } from '../src/daemon/server.js';
import { Logger } from '../src/daemon/log.js';
import { ClickReceiver, parseClick, CLICK_SOCKET, type ClickRoutes } from '../src/daemon/click-receiver.js';
import { TerminalLauncher, terminalCommandFile, type TerminalRunner } from '../src/daemon/terminal-launch.js';
import type { SessionInfo } from '../src/shared/protocol.js';
const roots: string[] = [];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function home(): Promise<Paths> { const root = await mkdtemp(join(tmpdir(), 'ai-term-click-')); roots.push(root); const paths = getPaths(root); await preparePaths(paths); return paths; }
const now = '2026-10-13T12:00:00.000Z';
function agent(status: SessionInfo['status'] = 'waiting', id = randomUUID()): SessionInfo {
  return { id, title: 'fix-login', engine: 'codex', model: null, auth: { kind: 'account' }, cwd: '/tmp', permission: 'ask', status, statusDetail: status === 'waiting' ? 'permission' : status, statusSince: now, createdAt: now, lastOutputAt: now, exitCode: null, ctxPercent: null, lastActivity: null };
}
// The receiver with stub routes: every branch is visible as a call or a log line.
async function receiver(sessions: SessionInfo[], options: { client?: boolean; now?: () => number } = {}) {
  const paths = await home(), selected: string[] = [], opened: string[] = [], logs: string[] = [];
  const routes: ClickRoutes = { session: id => sessions.find(s => s.id === id) ?? null, hasClient: () => options.client ?? false, select: id => { selected.push(id); }, openTerminal: async id => { opened.push(id); } };
  const clicks = new ClickReceiver(join(paths.run, CLICK_SOCKET), routes, { info: text => logs.push(text), error: text => logs.push(text) }, options.now);
  await clicks.listen(); cleanup.push(() => clicks.close());
  return { paths, socket: join(paths.run, CLICK_SOCKET), selected, opened, logs, clicks };
}
function send(path: string, bytes: string | Buffer, end = true): Promise<void> {
  // The receiver hangs up on an oversized write; the sender's EPIPE is expected then, and the log line is what counts.
  return new Promise(done => { const socket = createConnection(path, () => { socket.write(bytes); if (end) socket.end(); }); socket.on('error', () => undefined); socket.on('close', () => done()); socket.resume(); });
}
const payload = (id: string) => `{"clicked":"${id}"}\n`;

it('accepts only the exact one-line payload with a lowercase UUID', () => {
  const id = randomUUID();
  expect(parseClick(Buffer.from(payload(id)))).toBe(id);
  for (const bad of [
    `{"clicked":"${id}"}`, `{"clicked":"${id}"}\n\n`, `{"clicked":"${id}"}\r\n`, `{"clicked":"${id.toUpperCase()}"}\n`, `{ "clicked":"${id}"}\n`,
    `{"clicked":"${id}","text":"approve"}\n`, `{"clicked":"AITERMCANARY"}\n`, `{"clicked":["${id}"]}\n`, `["${id}"]\n`, `{"clicked":"${id}"}\n{"clicked":"${id}"}\n`,
    `{"clicked":"${id}\\u0000"}\n`, 'not json\n', '\n', '', 'x'.repeat(4096),
  ]) expect(parseClick(Buffer.from(bad))).toBeNull();
});

it('the click socket is private: 0600, in the 0700 run directory', async () => {
  const r = await receiver([]);
  const socket = await lstat(r.socket), run = await lstat(r.paths.run);
  expect(socket.isSocket()).toBe(true); expect(socket.mode & 0o777).toBe(0o600); expect(run.mode & 0o777).toBe(0o700);
});

it('with a client open, a click selects that agent and opens nothing', async () => {
  const session = agent(), r = await receiver([session], { client: true });
  await send(r.socket, payload(session.id));
  await vi.waitFor(() => expect(r.selected).toEqual([session.id]));
  expect(r.opened).toEqual([]);
});

it('with no client open, a click opens a Terminal window inside that agent', async () => {
  const session = agent('done'), r = await receiver([session]);
  await send(r.socket, payload(session.id));
  await vi.waitFor(() => expect(r.opened).toEqual([session.id]));
  expect(r.selected).toEqual([]);
});

it('drops clicks for an unknown or finished agent with a log line, never acting', async () => {
  const exited = agent('exited'), failed = agent('error'), r = await receiver([exited, failed], { client: true });
  for (const id of [randomUUID(), exited.id, failed.id]) await send(r.socket, payload(id));
  await vi.waitFor(() => expect(r.logs).toEqual(['Notification click for unknown agent dropped', 'Notification click for finished agent dropped', 'Notification click for finished agent dropped']));
  expect(r.selected).toEqual([]); expect(r.opened).toEqual([]);
});

it('refuses malformed, oversized, multi-line and unterminated payloads with a fixed log line', async () => {
  const session = agent(), r = await receiver([session], { client: true });
  for (const bad of [`{"clicked":"${session.id}","approve":true}\n`, `${payload(session.id)}${payload(session.id)}`, 'x'.repeat(10_000), `{"clicked":"${session.id}"}`]) await send(r.socket, bad);
  await vi.waitFor(() => expect(r.logs).toHaveLength(4));
  expect(new Set(r.logs)).toEqual(new Set(['Notification click rejected']));
  expect(r.selected).toEqual([]);
});

it('a connection that sends nothing is closed after one second', async () => {
  const r = await receiver([]), started = Date.now();
  await new Promise<void>(done => { const socket = createConnection(r.socket); socket.on('close', () => done()); socket.on('error', () => undefined); });
  expect(Date.now() - started).toBeGreaterThanOrEqual(900); expect(Date.now() - started).toBeLessThan(3000);
  expect(r.logs).toEqual(['Notification click rejected']);
});

it('allows at most one click action per second', async () => {
  const a = agent(), b = agent(); let t = 10_000;
  const r = await receiver([a, b], { client: true, now: () => t });
  await send(r.socket, payload(a.id)); await vi.waitFor(() => expect(r.selected).toEqual([a.id]));
  t += 400; await send(r.socket, payload(b.id));
  await vi.waitFor(() => expect(r.logs).toEqual(['Notification click rate limited']));
  t += 700; await send(r.socket, payload(b.id));
  await vi.waitFor(() => expect(r.selected).toEqual([a.id, b.id]));
});

it('the generated .command holds only a fixed interpreter, the absolute ai CLI and the validated UUID', () => {
  const id = randomUUID();
  expect(terminalCommandFile({ node: '/opt/node/bin/node', entry: '/Users/test/ai-term/dist/cli/index.js' }, id)).toBe(
    `#!/bin/sh\nrm -f -- "$0"\nexec '/opt/node/bin/node' '/Users/test/ai-term/dist/cli/index.js' --attach '${id}'\n`);
  expect(terminalCommandFile({ node: '/opt/node/bin/node', entry: '/Users/test/ai-term/src/cli/index.ts', loader: '/Users/test/ai-term/node_modules/tsx/dist/loader.mjs' }, id)).toBe(
    // Source mode pins AI Term's tsconfig (v0.2 gate); tests/gate-source-mode.test.ts explains why.
    `#!/bin/sh\nrm -f -- "$0"\nexec /usr/bin/env 'TSX_TSCONFIG_PATH=/Users/test/ai-term/tsconfig.json' '/opt/node/bin/node' --import '/Users/test/ai-term/node_modules/tsx/dist/loader.mjs' '/Users/test/ai-term/src/cli/index.ts' --attach '${id}'\n`);
  for (const [command, session] of [
    [{ node: '/opt/node/bin/node', entry: '/x/index.js' }, 'AITERMCANARY'], [{ node: '/opt/node/bin/node', entry: '/x/index.js' }, id.toUpperCase()],
    [{ node: "/opt/no'de", entry: '/x/index.js' }, id], [{ node: '/opt/node', entry: '/x/my ai/index.js' }, id], [{ node: 'node', entry: '/x/index.js' }, id],
    [{ node: '/opt/node', entry: '/x/$(touch)/index.js' }, id], [{ node: '/opt/node', entry: '/x/index.ts' }, id], [{ node: '/opt/node', entry: '/x/../index.js' }, id],
  ] as const) expect(() => terminalCommandFile(command, session)).toThrow('Invalid terminal command');
});

function launcherFixture(paths: Paths, fail = false) {
  const calls: { file: string; args: string[]; contents: string; mode: number; dirMode: number }[] = [], logs: string[] = [], timers: (() => void)[] = [];
  const runner: TerminalRunner = (file, args, done) => {
    const path = args.at(-1) ?? '';
    void Promise.all([readFile(path, 'utf8'), lstat(path), lstat(dirname(path))]).then(([contents, stat, dir]) => { calls.push({ file, args: [...args], contents, mode: stat.mode & 0o777, dirMode: dir.mode & 0o777 }); done(fail ? new Error('open failed /secret/path') : null); });
  };
  const launcher = new TerminalLauncher(paths.root, { node: '/opt/node/bin/node', entry: '/Users/test/ai-term/dist/cli/index.js' }, { info: text => logs.push(text), error: text => logs.push(text) }, runner, callback => { timers.push(callback); });
  return { launcher, calls, logs, timers };
}

it('opens the .command with open -a Terminal as an argv array from a private file, then deletes it', async () => {
  const paths = await home(), f = launcherFixture(paths), id = randomUUID();
  await f.launcher.open(id);
  expect(f.calls).toHaveLength(1);
  const call = f.calls[0];
  expect(call?.file).toBe('/usr/bin/open'); expect(call?.args.slice(0, 2)).toEqual(['-a', 'Terminal']); expect(call?.args).toHaveLength(3);
  const file = call?.args[2] ?? '';
  expect(file.startsWith(join(paths.root, 'launch') + '/')).toBe(true); expect(file.endsWith('.command')).toBe(true);
  expect(call?.mode).toBe(0o700); expect(call?.dirMode).toBe(0o700); expect((await lstat(join(paths.root, 'launch'))).mode & 0o777).toBe(0o700);
  expect(call?.contents).toBe(`#!/bin/sh\nrm -f -- "$0"\nexec '/opt/node/bin/node' '/Users/test/ai-term/dist/cli/index.js' --attach '${id}'\n`);
  // Terminal reads the file after open returns, so it is removed by its own first line or by the delayed cleanup.
  expect(f.timers).toHaveLength(1); f.timers[0]?.();
  await vi.waitFor(async () => expect(await readdir(join(paths.root, 'launch'))).toEqual([]));
});

it('a failed Terminal launch deletes the file at once and logs fixed text only', async () => {
  const paths = await home(), f = launcherFixture(paths, true);
  await f.launcher.open(randomUUID());
  expect(await readdir(join(paths.root, 'launch'))).toEqual([]);
  expect(f.logs).toEqual(['Notification click could not open Terminal']);
});

it('never writes a .command for an invalid UUID and refuses a symlinked launch directory', async () => {
  const paths = await home(), f = launcherFixture(paths);
  await expect(f.launcher.open('AITERMCANARY')).rejects.toThrow('Invalid terminal command'); expect(f.calls).toEqual([]);
  const elsewhere = await mkdtemp(join(tmpdir(), 'ai-term-elsewhere-')); roots.push(elsewhere);
  const { symlink } = await import('node:fs/promises'); await symlink(elsewhere, join(paths.root, 'launch'));
  await expect(f.launcher.open(randomUUID())).rejects.toThrow(); expect(f.calls).toEqual([]); expect(await readdir(elsewhere)).toEqual([]);
});

it('leftover launch folders from an earlier daemon are swept at start', async () => {
  const paths = await home(), f = launcherFixture(paths), old = join(paths.root, 'launch', 'click-old');
  await mkdir(old, { recursive: true, mode: 0o700 }); await writeFile(join(old, 'ai.command'), 'old', { mode: 0o700 });
  await f.launcher.sweep();
  expect(await readdir(join(paths.root, 'launch'))).toEqual([]);
});

it('the daemon tells only clients that handle clicks to select the agent, and counts them', async () => {
  const paths = await home();
  const manager = new SessionManager(paths, new Logger(paths.log), { executable: '/bin/sh', args: ['-c', 'sleep 30'], env: { PATH: '/usr/bin:/bin' } }); await manager.load();
  const server = new DaemonServer(paths, manager, new Logger(paths.log)); await server.listen();
  cleanup.push(async () => { await server.close(); await manager.shutdown(); });
  const homepage = await Connection.connect(paths, { entry: resolve('src/cli/index.ts'), autoStart: false }), other = await Connection.connect(paths, { entry: resolve('src/cli/index.ts'), autoStart: false });
  cleanup.unshift(async () => { homepage.close(); other.close(); });
  expect(server.clickClients()).toBe(0);
  await homepage.request({ kind: 'clicks.subscribe', on: true });
  expect(server.clickClients()).toBe(1);
  const seen: unknown[] = [], otherSeen: unknown[] = [], id = randomUUID();
  homepage.on('event', value => seen.push(value)); other.on('event', value => otherSeen.push(value));
  server.selectSession(id);
  await vi.waitFor(() => expect(seen).toEqual([{ kind: 'session.select', sessionId: id }]));
  expect(otherSeen).toEqual([]);
  homepage.close();
  await vi.waitFor(() => expect(server.clickClients()).toBe(0));
});
