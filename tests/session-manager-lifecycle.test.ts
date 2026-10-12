import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pty from 'node-pty';
import { getPaths, preparePaths, type Paths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { PtyHost } from '../src/daemon/pty-host.js';
import { Mirror } from '../src/daemon/mirror.js';
import { atomicWrite } from '../src/daemon/store.js';
import * as engines from '../src/daemon/engines.js';
const roots: string[] = [];
const managers: SessionManager[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const manager of managers.splice(0)) await manager.shutdown(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function home(): Promise<Paths> { const root = await mkdtemp(join(tmpdir(), 'ai-term-lifecycle-')); roots.push(root); const paths = getPaths(root); await preparePaths(paths); return paths; }
const shell = (script: string) => ({ executable: '/bin/sh', args: ['-c', script], env: { PATH: '/usr/bin:/bin' } });
async function manager(paths: Paths, script = 'printf up; read answer', writer = atomicWrite, log = new Logger(paths.log)) {
  const m = new SessionManager(paths, log, shell(script), undefined, writer); managers.push(m); await m.load(); return m;
}
const now = new Date().toISOString();
const record = { id: randomUUID(), title: 'shell', engine: 'shell', model: 'shell', auth: { kind: 'account' }, cwd: '/tmp', permission: 'ask', status: 'exited', statusDetail: 'exit 0', statusSince: now, createdAt: now, exitCode: 0, lastOutputAt: null, ctxPercent: null };

describe('load', () => {
  it.each([
    ['an array', '[]', 'Invalid daemon state'], ['null', 'null', 'Invalid daemon state'], ['sessions as an object', '{"sessions":{}}', 'Invalid daemon state'],
    ['a null record', '{"sessions":[null]}', 'Invalid session record'], ['a record without an id', JSON.stringify({ sessions: [{ ...record, id: 'x' }] }), 'Invalid session record'],
    ['an unknown engine', JSON.stringify({ sessions: [{ ...record, engine: 'bash' }] }), 'Invalid session record'],
    ['a record that fails the session check', JSON.stringify({ sessions: [{ ...record, status: 'bogus' }] }), 'Invalid daemon session'],
  ])('refuses state holding %s and leaves the file as it was', async (_name, text, message) => {
    const paths = await home();
    await writeFile(paths.state, text, { mode: 0o600 });
    const m = new SessionManager(paths, new Logger(paths.log)); managers.push(m);
    await expect(m.load()).rejects.toThrow(message);
    expect(m.list()).toEqual([]);
    // A bad file is never overwritten with an empty list: the user's records stay recoverable.
    expect(await readFile(paths.state, 'utf8')).toBe(text);
  });
});

describe('unknown sessions and bad arguments', () => {
  it('every per-session operation refuses an unknown id without touching other sessions', async () => {
    const paths = await home(), m = await manager(paths), live = await m.create({ cwd: paths.root }), unknown = randomUUID();
    expect(() => m.get(unknown)).toThrow('Session not found');
    await expect(m.snapshot(unknown)).rejects.toThrow('Session not found');
    await expect(m.stop(unknown)).rejects.toThrow('Session not found');
    await expect(m.remove(unknown)).rejects.toThrow('Session not found');
    await expect(m.rename(unknown, 'title')).rejects.toThrow('Invalid session or title');
    await expect(m.attach(unknown, 80, 24, () => undefined)).rejects.toThrow('Invalid attach');
    await expect(m.resizeAttached(unknown, 80, 24, () => true)).rejects.toThrow('Invalid resize');
    await expect(m.detach(unknown, () => true)).resolves.toBeUndefined();
    expect(() => m.clientBackpressure(unknown, true)).not.toThrow();
    expect(() => m.input(unknown, Buffer.from('x'))).not.toThrow();
    expect(m.list().map(s => s.id)).toEqual([live.id]);
  });
  it('refuses bad titles and sizes before changing anything', async () => {
    const paths = await home(), m = await manager(paths), live = await m.create({ cwd: paths.root, title: 'kept' });
    for (const title of ['', 'x'.repeat(61), 'a\x1bb']) await expect(m.rename(live.id, title)).rejects.toThrow('Invalid session or title');
    expect(m.get(live.id).title).toBe('kept');
    for (const [cols, rows] of [[1, 24], [80, 0], [1001, 24], [80, 501], [80.5, 24]] as const) {
      await expect(m.previewSize(cols, rows)).rejects.toThrow('Invalid preview size');
      await expect(m.attach(live.id, cols, rows, () => undefined)).rejects.toThrow('Invalid attach');
      await expect(m.resizeAttached(live.id, cols, rows, () => true)).rejects.toThrow('Invalid resize');
    }
    expect(m.previewDimensions()).toEqual({ cols: 85, rows: 30 });
  });
  it('create refuses a bad title or a missing folder and records nothing', async () => {
    const paths = await home(), m = await manager(paths);
    await expect(m.create({ cwd: paths.root, title: '' })).rejects.toThrow('Invalid session request');
    await expect(m.create({ cwd: paths.root, title: 'bell\x07' })).rejects.toThrow('Invalid session request');
    await expect(m.create({ cwd: join(paths.root, 'missing') })).rejects.toThrow('Invalid session request');
    expect(m.list()).toEqual([]);
  });
  it('input reaches the PTY only while attached', async () => {
    const paths = await home(), m = await manager(paths), live = await m.create({ cwd: paths.root });
    const write = vi.spyOn(PtyHost.prototype, 'write');
    m.input(live.id, Buffer.from('detached\n'));
    expect(write).not.toHaveBeenCalled();
    await m.attach(live.id, 80, 24, () => undefined);
    m.input(live.id, Buffer.from('attached\n'));
    expect(write.mock.calls.map(([data]) => String(data))).toEqual(['attached\n']);
    // read exits after that line; wait for onExit before cleanup signals its vanished process group.
    await expect.poll(() => m.get(live.id).status).toBe('exited');
  });
});

describe('agent sessions', () => {
  const status = (patch: Partial<Awaited<ReturnType<typeof engines.checkEngine>>>) => ({ installed: true, path: '/bin/echo', version: '1.0.0', loggedIn: true, authMethod: 'subscription' as const, ...patch });
  const agent = (engine: 'claude-code' | 'codex', cwd: string) => ({ engine, model: null, auth: { kind: 'account' as const }, cwd, permission: 'ask' as const });
  it.each([
    ['codex', { installed: false, path: null }, 'codex not found in PATH'], ['claude-code', { installed: false, path: null }, 'claude not found in PATH'],
    ['codex', { path: null }, 'codex not found in PATH'], ['claude-code', { loggedIn: false }, 'Engine is not logged in'], ['codex', { loggedIn: null }, 'Engine login status unavailable'],
  ] as const)('%s with %j fails with "%s" and leaves no record', async (engine, patch, message) => {
    const paths = await home(), m = await manager(paths);
    vi.spyOn(engines, 'checkEngine').mockResolvedValue(status(patch));
    const spawn = vi.spyOn(pty, 'spawn');
    await expect(m.create(agent(engine, paths.root))).rejects.toThrow(message);
    expect(spawn).not.toHaveBeenCalled();
    expect(m.list()).toEqual([]);
    expect(JSON.parse(await readFile(paths.state, 'utf8'))).toEqual({ sessions: [] });
  });
  it('names each engine by default and records how it is billed', async () => {
    const paths = await home(), m = await manager(paths);
    vi.spyOn(engines, 'checkEngine').mockResolvedValueOnce(status({})).mockResolvedValueOnce(status({ authMethod: 'api-key' }));
    const claude = await m.create(agent('claude-code', paths.root)), codex = await m.create(agent('codex', paths.root));
    expect(claude).toMatchObject({ title: 'Claude Code', engine: 'claude-code', model: null, authMethod: 'subscription' });
    expect(codex).toMatchObject({ title: 'Codex', engine: 'codex', model: null, authMethod: 'api-key' });
  });
});

describe('failures while running', () => {
  it('a PTY that cannot spawn becomes an error record, is saved, and can be removed', async () => {
    const paths = await home(), m = await manager(paths), events: unknown[] = [];
    m.on('event', event => events.push(event));
    vi.spyOn(pty, 'spawn').mockImplementation(() => { throw new Error('posix_spawnp failed.'); });
    const failed = await m.create({ cwd: paths.root });
    expect(failed).toMatchObject({ status: 'error', statusDetail: 'spawn failed', exitCode: null });
    expect(events).toContainEqual({ kind: 'session.updated', session: expect.objectContaining({ id: failed.id, status: 'error' }) });
    expect(JSON.parse(await readFile(paths.state, 'utf8')).sessions).toEqual([expect.objectContaining({ id: failed.id, status: 'error', pid: null })]);
    expect(m.sessionRoots()).toEqual([]);
    expect(m.activeCount()).toBe(0);
    expect(await readFile(paths.log, 'utf8')).toContain('PTY spawn failed: posix_spawnp failed.');
    await m.remove(failed.id);
    expect(m.list()).toEqual([]);
  });
  it('a mirror that fails to update reports a fatal error instead of hiding it', async () => {
    const paths = await home(), m = await manager(paths), fatal = vi.fn();
    m.on('fatal', fatal);
    vi.spyOn(Mirror.prototype, 'write').mockRejectedValue(new Error('parser crashed'));
    await m.create({ cwd: paths.root });
    await expect.poll(() => fatal.mock.calls.length).toBeGreaterThan(0);
    expect(fatal.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(await readFile(paths.log, 'utf8')).toContain('Mirror update failed: parser crashed');
  });
  it('lists only live PTYs as sampler roots and counts only starting or running sessions as active', async () => {
    const paths = await home(), m = await manager(paths);
    const live = await m.create({ cwd: paths.root });
    await expect.poll(() => m.get(live.id).status).toBe('running');
    expect(m.sessionRoots()).toEqual([{ sessionId: live.id, pid: expect.any(Number) }]);
    expect(m.activeCount()).toBe(1);
    await m.stop(live.id);
    expect(m.sessionRoots()).toEqual([]);
    expect(m.activeCount()).toBe(0);
  });
});

describe('attach races', () => {
  it('an attach queued when shutdown starts fails and never publishes a snapshot', async () => {
    const paths = await home(), m = await manager(paths), live = await m.create({ cwd: paths.root });
    const publish = vi.fn();
    const attaching = m.attach(live.id, 80, 24, publish);
    const stopping = m.shutdown();
    await expect(attaching).rejects.toThrow('Session unavailable');
    await stopping;
    expect(publish).not.toHaveBeenCalled();
    await expect(m.attach(live.id, 80, 24, publish)).rejects.toThrow('Invalid attach');
  });
  it('a detach from a client that no longer owns the session changes nothing', async () => {
    const paths = await home(), m = await manager(paths, 'stty -echo; while read line; do eval "$line"; done'), live = await m.create({ cwd: paths.root });
    await m.attach(live.id, 70, 20, () => undefined);
    const events: unknown[] = []; m.on('event', event => events.push(event));
    await m.detach(live.id, () => false);
    expect(events).toEqual([]);
    // Still attached: input still reaches the PTY and preview resizes leave it at the attached size.
    m.input(live.id, Buffer.from('printf STILL_ATTACHED\n'));
    await expect.poll(() => m.snapshot(live.id)).toContain('STILL_ATTACHED');
    await m.previewSize(40, 12);
    expect(events).not.toContainEqual(expect.objectContaining({ kind: 'session.previewResized', sessionId: live.id }));
  });
  it('a resize from a client that does not own the session is refused and logged', async () => {
    const paths = await home(), m = await manager(paths), live = await m.create({ cwd: paths.root });
    await m.attach(live.id, 70, 20, () => undefined);
    await expect(m.resizeAttached(live.id, 90, 30, () => false)).rejects.toThrow('Not attached');
    expect(await readFile(paths.log, 'utf8')).toContain('Attachment change failed: Not attached');
    // The queue survives a refused change.
    expect(await m.snapshot(live.id)).toEqual(expect.any(String));
  });
});

describe('warnings', () => {
  it('a repeated state failure warns once, and recovery clears it', async () => {
    const paths = await home();
    let fail = false;
    const writer = vi.fn(async (path: string, value: unknown) => { if (fail) throw new Error('ENOSPC'); await atomicWrite(path, value); });
    const m = await manager(paths, 'printf up; read answer', writer), events: unknown[] = [];
    m.on('event', event => { if (typeof event === 'object' && event && 'kind' in event && String(event.kind).startsWith('daemon.')) events.push(event); });
    const live = await m.create({ cwd: paths.root });
    fail = true;
    await m.rename(live.id, 'one'); await m.rename(live.id, 'two'); await m.rename(live.id, 'three');
    expect(events).toEqual([{ kind: 'daemon.warning', text: 'Session state could not be saved; agents keep running.' }]);
    fail = false;
    await m.rename(live.id, 'four');
    expect(events.at(-1)).toEqual({ kind: 'daemon.warningCleared' });
    expect(m.warningText()).toBeNull();
  });
  it('clearing one of two warnings leaves the other on screen', async () => {
    const paths = await home(), log = new Logger(paths.log);
    let fail = false;
    const writer = vi.fn(async (path: string, value: unknown) => { if (fail) throw new Error('ENOSPC'); await atomicWrite(path, value); });
    const m = await manager(paths, 'printf up; read answer', writer, log), events: unknown[] = [];
    const live = await m.create({ cwd: paths.root });
    m.on('event', event => { if (typeof event === 'object' && event && 'kind' in event && String(event.kind).startsWith('daemon.')) events.push(event); });
    fail = true; await m.rename(live.id, 'one');
    // The log path turns into a symlink, which the logger refuses to follow.
    await rm(paths.log, { force: true }); await symlink(paths.state, paths.log);
    log.error('cannot be written');
    expect(m.warningText()).toBe('Session state could not be saved; agents keep running. Log could not be saved; agents keep running.');
    fail = false; await m.rename(live.id, 'two');
    expect(events.at(-1)).toEqual({ kind: 'daemon.warning', text: 'Log could not be saved; agents keep running.' });
    await rm(paths.log); log.info('recovered');
    expect(events.at(-1)).toEqual({ kind: 'daemon.warningCleared' });
  });
});
