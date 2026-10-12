import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, lstat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { getPaths, preparePaths, type Paths } from '../src/shared/paths.js';
import { Connection } from '../src/client/connection.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { DaemonServer, socketAnswers } from '../src/daemon/server.js';
import { Logger } from '../src/daemon/log.js';
import { PtyHost } from '../src/daemon/pty-host.js';
import { encodeControl, encodeData, FrameDecoder, decodeControl } from '../src/shared/protocol.js';
const roots: string[] = [];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function home(): Promise<Paths> { const root = await mkdtemp(join(tmpdir(), 'ai-term-reject-')); roots.push(root); const paths = getPaths(root); await preparePaths(paths); return paths; }
async function setup(script = 'stty -echo; while read line; do eval "$line"; done') {
  const paths = await home();
  const manager = new SessionManager(paths, new Logger(paths.log), { executable: '/bin/sh', args: ['-c', script], env: { PATH: '/usr/bin:/bin' } }); await manager.load();
  const server = new DaemonServer(paths, manager, new Logger(paths.log)); await server.listen();
  cleanup.push(async () => { await server.close(); await manager.shutdown(); });
  return { paths, manager, server };
}
async function client(paths: Paths): Promise<Connection> {
  const connection = await Connection.connect(paths, { entry: resolve('src/cli/index.ts'), autoStart: false });
  cleanup.unshift(async () => { connection.close(); });
  return connection;
}
// A raw socket speaks frames directly, so a test can send what the real client never would.
function raw(paths: Paths, hello = true) {
  const socket: Socket = createConnection(paths.socket); cleanup.unshift(async () => { socket.destroy(); });
  const decoder = new FrameDecoder(), replies: Record<string, unknown>[] = [];
  let closed = false;
  socket.on('data', data => { for (const frame of decoder.push(data)) if (frame.type === 1) replies.push(decodeControl(frame) as Record<string, unknown>); });
  socket.on('close', () => { closed = true; });
  socket.on('error', () => undefined);
  if (hello) socket.write(encodeControl({ id: randomUUID(), kind: 'hello', protocol: 1, version: 'test' }));
  return { socket, replies, send: (value: unknown) => socket.write(encodeControl(value)), closed: () => closed };
}
const failures = (replies: Record<string, unknown>[]) => replies.filter(reply => reply.ok === false);

it('answers invalid requests with INVALID_REQUEST, echoes only a string id, and keeps the connection usable', async () => {
  const { paths } = await setup();
  const peer = raw(paths);
  await expect.poll(() => peer.replies.length).toBe(1);
  for (const value of [[1, 2], 'text', null, { id: 5, kind: 'sessions.list' }, { id: 'not-a-uuid', kind: 'sessions.list' }, { id: randomUUID(), kind: 'sessions.exec', cmd: 'rm -rf /' }]) peer.send(value);
  await expect.poll(() => failures(peer.replies).length).toBe(6);
  const errors = failures(peer.replies);
  expect(errors.every(reply => (reply.error as { code: string }).code === 'INVALID_REQUEST')).toBe(true);
  expect(errors.map(reply => reply.id)).toEqual([undefined, undefined, undefined, undefined, 'not-a-uuid', expect.any(String)]);
  const listId = randomUUID(); peer.send({ id: listId, kind: 'sessions.list' });
  await expect.poll(() => peer.replies.find(reply => reply.id === listId)).toMatchObject({ ok: true, sessions: [] });
  expect(peer.closed()).toBe(false);
});

it('closes a client that sends an output frame or a bad frame length, and other clients keep working', async () => {
  const { paths } = await setup();
  const output = raw(paths), length = raw(paths), other = await client(paths);
  await expect.poll(() => output.replies.length + length.replies.length).toBe(2);
  output.socket.write(encodeData(2, randomUUID(), Buffer.from('fake output')));
  length.socket.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 1]));
  await expect.poll(() => output.closed() && length.closed()).toBe(true);
  expect(failures(output.replies)).toEqual([{ ok: false, error: { code: 'UNSUPPORTED_FRAME', message: 'Output frames are daemon-only' } }]);
  expect(failures(length.replies)).toEqual([{ ok: false, error: { code: 'INVALID_LENGTH', message: expect.any(String) } }]);
  expect((await other.request({ kind: 'sessions.list' })).sessions).toEqual([]);
});

it('drops input from a client that never said hello, even for a session another client owns', async () => {
  const { paths, manager } = await setup();
  const owner = await client(paths), session = await manager.create({ cwd: paths.root });
  await owner.request({ kind: 'sessions.attach', sessionId: session.id, cols: 80, rows: 24 });
  const write = vi.spyOn(PtyHost.prototype, 'write');
  const stranger = raw(paths, false);
  stranger.socket.write(encodeData(3, session.id, Buffer.from('printf INTRUDER\n')));
  owner.input(session.id, Buffer.from('printf OWNER\n'));
  await expect.poll(() => manager.snapshot(session.id)).toContain('OWNER');
  expect(await manager.snapshot(session.id)).not.toContain('INTRUDER');
  expect(write.mock.calls.map(([data]) => String(data))).toEqual(['printf OWNER\n']);
  expect(await readFile(paths.log, 'utf8')).toContain('Dropped input from non-attached client');
});

it('attaching to a second session detaches the first, so input for the first is dropped', async () => {
  const { paths, manager } = await setup();
  const a = await manager.create({ cwd: paths.root }), b = await manager.create({ cwd: paths.root });
  const owner = await client(paths), events: unknown[] = []; owner.on('event', event => events.push(event));
  await owner.request({ kind: 'sessions.attach', sessionId: a.id, cols: 70, rows: 20 });
  await owner.request({ kind: 'sessions.attach', sessionId: b.id, cols: 70, rows: 20 });
  // The first session goes back to the preview size once its owner moves on.
  await expect.poll(() => events).toContainEqual({ kind: 'session.previewResized', sessionId: a.id, cols: 85, rows: 30 });
  owner.input(a.id, Buffer.from('printf STALE\n')); owner.input(b.id, Buffer.from('printf CURRENT\n'));
  await expect.poll(() => manager.snapshot(b.id)).toContain('CURRENT');
  expect(await manager.snapshot(a.id)).not.toContain('STALE');
});

it('a client that disconnects while its attach is queued leaves the session detached', async () => {
  const { paths, manager } = await setup();
  const session = await manager.create({ cwd: paths.root });
  let release: () => void = () => undefined; const gate = new Promise<void>(r => { release = r; });
  const attach = manager.attach.bind(manager);
  vi.spyOn(manager, 'attach').mockImplementation(async (...args) => { await gate; await attach(...args); });
  const peer = raw(paths); await expect.poll(() => peer.replies.length).toBe(1);
  peer.send({ id: randomUUID(), kind: 'sessions.attach', sessionId: session.id, cols: 60, rows: 20 });
  await expect.poll(() => vi.mocked(manager.attach).mock.calls.length).toBe(1);
  peer.socket.destroy(); await expect.poll(() => peer.closed()).toBe(true);
  const events: unknown[] = []; manager.on('event', event => events.push(event));
  release();
  // Detached sessions follow preview-size changes; an orphaned attachment would keep 60x20.
  await expect.poll(() => events).toContainEqual({ kind: 'session.previewResized', sessionId: session.id, cols: 85, rows: 30 });
  await manager.previewSize(40, 12);
  expect(events).toContainEqual({ kind: 'session.previewResized', sessionId: session.id, cols: 40, rows: 12 });
});

it('sends the daemon warning after hello and after sessions.list, only while one exists', async () => {
  const { paths, manager } = await setup();
  const warning = vi.spyOn(manager, 'warningText').mockReturnValue('Session state could not be saved; agents keep running.');
  const peer = raw(paths);
  await expect.poll(() => peer.replies).toContainEqual({ kind: 'daemon.warning', text: 'Session state could not be saved; agents keep running.' });
  peer.send({ id: randomUUID(), kind: 'sessions.list' });
  await expect.poll(() => peer.replies.filter(reply => reply.kind === 'daemon.warning').length).toBe(2);
  warning.mockReturnValue(null);
  const listId = randomUUID(); peer.send({ id: listId, kind: 'sessions.list' });
  await expect.poll(() => peer.replies.some(reply => reply.id === listId)).toBe(true);
  await new Promise(r => setTimeout(r, 50));
  expect(peer.replies.filter(reply => reply.kind === 'daemon.warning')).toHaveLength(2);
});

it('passes only known user-facing errors through; anything else becomes a fixed message', async () => {
  const { paths, manager } = await setup();
  const session = await manager.create({ cwd: paths.root }), owner = await client(paths);
  const rename = vi.spyOn(manager, 'rename');
  for (const known of ['claude not found in PATH', 'codex not found in PATH', 'Engine is not logged in', 'Engine login status unavailable', 'Current terminal screen exceeds snapshot frame limit']) {
    rename.mockRejectedValueOnce(new Error(known));
    await expect(owner.request({ kind: 'sessions.rename', sessionId: session.id, title: 'x' })).rejects.toThrow(known);
  }
  // A filesystem error can carry a private path; a near-miss of a known message must not slip through either.
  for (const thrown of [new Error("EACCES: permission denied, open '/Users/someone/private'"), new Error('Engine is not logged in, token=SECRET'), 'plain string']) {
    rename.mockRejectedValueOnce(thrown);
    const failure = owner.request({ kind: 'sessions.rename', sessionId: session.id, title: 'x' });
    await expect(failure).rejects.toThrow('Session operation failed');
    await expect(failure).rejects.not.toThrow(/private|SECRET/);
  }
  expect(await readFile(paths.log, 'utf8')).toContain('Operation failed');
});

it('a failed preview refresh clears the preview, so later output for that session is not streamed', async () => {
  const { paths, manager } = await setup();
  const session = await manager.create({ cwd: paths.root }), viewer = await client(paths);
  const outputs: string[] = []; viewer.on('output', (id: string) => outputs.push(id));
  vi.spyOn(manager, 'snapshot').mockRejectedValueOnce(new Error('mirror gone'));
  await expect(viewer.request({ kind: 'sessions.preview', sessionId: session.id })).rejects.toThrow('Session operation failed');
  manager.emit('output', session.id, Buffer.from('late'));
  await viewer.request({ kind: 'sessions.list' });
  expect(outputs).toEqual([]);
  await expect(viewer.request({ kind: 'sessions.preview', sessionId: randomUUID() })).rejects.toThrow('Session not found');
});

it('disconnects a client that stops reading instead of queueing events without bound', async () => {
  const { paths, manager, server } = await setup();
  const stalled = raw(paths), healthy = await client(paths);
  await expect.poll(() => stalled.replies.length).toBe(1);
  stalled.socket.pause();
  const events: unknown[] = []; healthy.on('event', event => events.push(event));
  const text = 'x'.repeat(512 * 1024);
  // One at a time, so the client that reads keeps up while the stalled one only piles up.
  for (let i = 0; i < 40; i++) { manager.emit('event', { kind: 'daemon.warning', text }); await expect.poll(() => events.length, { timeout: 5000 }).toBe(i + 1); }
  // A paused socket never reads its own EOF, so watch the daemon side drop it.
  await expect.poll(() => server.clientCount(), { timeout: 5000 }).toBe(1);
  await expect.poll(() => events.length, { timeout: 5000 }).toBe(40);
  expect((await healthy.request({ kind: 'sessions.list' })).sessions).toEqual([]);
});

it('listen refuses a socket path that is not a socket and leaves the file alone', async () => {
  const paths = await home();
  await writeFile(paths.socket, 'not a socket', { mode: 0o600 });
  const manager = new SessionManager(paths, new Logger(paths.log)), server = new DaemonServer(paths, manager, new Logger(paths.log));
  try {
    await expect(server.listen()).rejects.toThrow('Unsafe socket path');
    expect(await readFile(paths.socket, 'utf8')).toBe('not a socket');
  } finally { await server.close(); await manager.shutdown(); }
  // close() of a server that never listened must not remove a file it never created.
  expect(await readFile(paths.socket, 'utf8')).toBe('not a socket');
});

it('a second daemon on a live socket fails, and closing it never removes the first daemon socket', async () => {
  const { paths } = await setup();
  const manager = new SessionManager(paths, new Logger(paths.log)), second = new DaemonServer(paths, manager, new Logger(paths.log));
  try { await expect(second.listen()).rejects.toThrow('Daemon socket already in use'); }
  finally { await second.close(); await manager.shutdown(); }
  expect((await lstat(paths.socket)).isSocket()).toBe(true);
  const first = await client(paths);
  expect((await first.request({ kind: 'sessions.list' })).sessions).toEqual([]);
});

// B6: libuv unlinks a pipe server's bound path on close() whatever is there now, so an inode check alone can't protect a replacement.
it('close leaves a socket path alone once something else replaced it', async () => {
  const { paths, server } = await setup();
  await unlink(paths.socket);
  const replacement = createServer(socket => socket.end());
  await new Promise<void>(done => replacement.listen(paths.socket, done));
  cleanup.unshift(async () => { await new Promise<void>(done => replacement.close(() => done())); });
  await server.close();
  expect((await lstat(paths.socket)).isSocket()).toBe(true);
  expect(await socketAnswers(paths.socket)).toBe(true);
});

it('socketAnswers reports a missing or refused socket as dead and rethrows any other error', async () => {
  const paths = await home();
  expect(await socketAnswers(join(paths.root, 'missing.sock'))).toBe(false);
  await writeFile(join(paths.root, 'file'), '');
  // A path under a regular file is ENOTDIR: not proof the daemon is gone, so the caller must not unlink anything.
  await expect(socketAnswers(join(paths.root, 'file', 'daemon.sock'))).rejects.toMatchObject({ code: 'ENOTDIR' });
});
