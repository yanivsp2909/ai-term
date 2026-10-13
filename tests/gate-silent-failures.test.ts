// v0.2 release gate, silent-failure review: failures that were swallowed or logged without the fact a user needs.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import pty from 'node-pty';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { KeyStore } from '../src/daemon/keys.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { UsageService } from '../src/daemon/usage-service.js';
import { DaemonServer } from '../src/daemon/server.js';
import { Connection, DaemonRequestError } from '../src/client/connection.js';
import { ClickReceiver } from '../src/daemon/click-receiver.js';
import { clickRouteFailure } from '../src/daemon/main.js';
import { Homepage } from '../src/client/tui/homepage.js';
import * as engines from '../src/daemon/engines.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SuccessResponse } from '../src/shared/protocol.js';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function home() { const root = await mkdtemp(join(tmpdir(), 'ai-gate-silent-')); roots.push(root); const paths = getPaths(root); await preparePaths(paths); return { root, paths }; }
const readLog = (path: string) => readFile(path, 'utf8').catch(() => '');

it('M1: a key whose metadata and Keychain rollback both fail names the orphaned Keychain account in the log, never the secret', async () => {
  const { root, paths } = await home(), values = new Map<string, string>(), secret = 'AITERMCANARY' + 'x'.repeat(30);
  const keys = new KeyStore(root, { vault: { read: async a => values.get(a) ?? null, write: async (a, s) => { values.set(a, s); }, remove: async () => { throw new Error('locked'); } } });
  // settings.json as a directory: the metadata write fails.
  await mkdir(join(root, 'settings.json'));
  await expect(keys.add({ provider: 'anthropic', label: 'k', secret })).rejects.toThrow('keychain cleanup failed');
  const [account] = [...values.keys()], log = await readLog(paths.log);
  expect(account).toMatch(/^anthropic:[0-9a-f-]{36}$/);
  expect(log).toContain(`Keychain cleanup failed; remove ai-term ${account} in Keychain Access`);
  expect(log).not.toContain('AITERMCANARY');
});

it('M2: a failed daemon request logs which request kind failed, with fixed text only', async () => {
  const { paths } = await home(), log = new Logger(paths.log), manager = new SessionManager(paths, log), server = new DaemonServer(paths, manager, log);
  let client: Connection | undefined;
  try {
    await manager.load(); await server.listen(); client = await Connection.connect(paths, { entry: '/unused', autoStart: false });
    await expect(client.request({ kind: 'sessions.stop', sessionId: randomUUID() })).rejects.toThrow('Session not found');
    await vi.waitFor(async () => expect(await readLog(paths.log)).toContain('Operation failed: sessions.stop (Session not found)'));
  } finally { client?.close(); await server.close(); await manager.shutdown(); }
});

it('M4: a Claude session whose node or ai path is outside the safe set logs that its status line is off', async () => {
  const { root, paths } = await home(), log = new Logger(paths.log), usage = new UsageService(root, log);
  const manager = new SessionManager(paths, log, undefined, undefined, undefined, undefined, usage, '/Users/test/My Projects/ai-term/dist/cli/index.js');
  vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/stub', version: '1', loggedIn: true, authMethod: 'subscription' });
  const exits: ((e: { exitCode: number }) => void)[] = [];
  vi.spyOn(pty, 'spawn').mockImplementation(() => ({ pid: 900002, onData: () => ({ dispose() {} }), onExit: (cb: (e: { exitCode: number }) => void) => { exits.push(cb); return { dispose() {} }; }, write() {}, resize() {}, pause() {}, resume() {} }) as unknown as pty.IPty);
  vi.spyOn(process, 'kill').mockImplementation(() => { for (const exit of exits) exit({ exitCode: 0 }); return true; });
  try {
    await usage.start(); await manager.load();
    await manager.create({ engine: 'claude-code', model: 'sonnet', auth: { kind: 'account' }, cwd: root, permission: 'ask' });
    expect(await readLog(paths.log)).toContain('Claude status line left off: node or ai path has characters outside the safe set; context % needs it');
  } finally { await manager.shutdown(); await usage.close(); }
});

it('M5: a click route that cannot start says why, in fixed words', async () => {
  const { paths } = await home(), path = join(paths.run, 'click.sock');
  const holder = createServer(); await new Promise<void>(done => holder.listen(path, done));
  try {
    const receiver = new ClickReceiver(path, { session: () => null, hasClient: () => false, select() {}, openTerminal: async () => {} }, { info() {}, error() {} });
    const error = await receiver.listen().then(() => null, (e: unknown) => e);
    expect(clickRouteFailure(error)).toBe('Notification click route unavailable: socket in use');
    expect(clickRouteFailure(new Error('Unsafe socket path'))).toBe('Notification click route unavailable: unsafe socket path');
    expect(clickRouteFailure(new Error('EACCES /Users/secret/path'))).toBe('Notification click route unavailable: setup failed');
  } finally { await new Promise<void>(done => holder.close(() => done())); }
});

class TTY extends EventEmitter { isTTY = true; isRaw = false; columns = 130; rows = 45; output = ''; setRawMode(v: boolean) { this.isRaw = v; } resume() {} pause() {} write(v: string | Buffer) { this.output += v.toString(); return true; } }
class Client extends EventEmitter {
  constructor(private readonly clicks: Error) { super(); }
  async request(body: RequestBody): Promise<SuccessResponse> {
    const result: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'clicks.subscribe') throw this.clicks;
    if (body.kind === 'settings.get') result.settings = { theme: 'graphite' };
    if (body.kind === 'sessions.list') result.sessions = [];
    if (body.kind === 'engines.status') result.engines = { claudeCode: { installed: true, path: '/c', version: '1', loggedIn: true, authMethod: 'subscription' }, codex: { installed: true, path: '/x', version: '1', loggedIn: true, authMethod: 'subscription' } };
    if (body.kind === 'sessions.preview') { result.snapshot = ''; result.cols = 88; result.rows = 27; }
    return result;
  }
}
it('L2: only an older daemon refusing clicks.subscribe is ignored; a lost connection or timeout still fails the homepage', async () => {
  const refused = new Homepage(new Client(new DaemonRequestError('Unknown request kind')), { stdin: new TTY(), stdout: new TTY(), signals: new EventEmitter(), cwd: '/tmp' });
  await refused.start(); await refused.stop();
  const lost = new Homepage(new Client(new Error('Daemon request timed out')), { stdin: new TTY(), stdout: new TTY(), signals: new EventEmitter(), cwd: '/tmp' });
  await expect(lost.start()).rejects.toThrow('Daemon request timed out');
});
