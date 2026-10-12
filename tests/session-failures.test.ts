import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { Mirror } from '../src/daemon/mirror.js';
import pty from 'node-pty';

afterEach(() => vi.restoreAllMocks());
it('B14 mirror failure fails and stops only its session with fixed diagnostics', async () => {
  const root = await mkdtemp('/tmp/ai-b14-'), paths = getPaths(root); await preparePaths(paths);
  const terminals: { data: (text: string) => void; exit: (event: { exitCode: number; signal?: number }) => void }[] = [];
  vi.spyOn(pty, 'spawn').mockImplementation(() => {
    const t = { data: (_text: string) => {}, exit: (_event: { exitCode: number; signal?: number }) => {} };
    const exits: ((event: { exitCode: number; signal?: number }) => void)[] = [];
    t.exit = event => { for (const exit of exits) exit(event); }; terminals.push(t);
    return { pid: 900000 + terminals.length, onData: (cb: (text: string) => void) => { t.data = cb; return { dispose() {} }; }, onExit: (cb: (event: { exitCode: number; signal?: number }) => void) => { exits.push(cb); return { dispose() {} }; }, write() {}, pause() {}, resume() {}, resize() {} } as unknown as pty.IPty;
  });
  const signals = vi.spyOn(process, 'kill').mockImplementation(pid => { terminals[-pid - 900001]?.exit({ exitCode: 0 }); return true; });
  const realWrite = Mirror.prototype.write;
  vi.spyOn(Mirror.prototype, 'write').mockImplementation(function (this: Mirror, data) { if (data === 'bad') return Promise.reject(new Error('AITERMCANARY')); return realWrite.call(this, data); });
  const manager = new SessionManager(paths, new Logger(paths.log), { executable: '/stub', args: [], env: {} });
  const fatal = vi.fn(), output = vi.fn(), events: unknown[] = [];
  manager.on('fatal', fatal); manager.on('output', output); manager.on('event', event => events.push(event));
  try {
    await manager.load(); const a = await manager.create({ cwd: root }), b = await manager.create({ cwd: root });
    terminals[0]?.data('bad'); await manager.snapshot(a.id);
    expect(manager.get(a.id)).toMatchObject({ status: 'error', statusDetail: 'terminal mirror failed', exitCode: null });
    expect(fatal).not.toHaveBeenCalled(); expect(signals.mock.calls.every(([pid]) => pid === -900001)).toBe(true);
    terminals[0]?.data('later'); terminals[1]?.data('healthy'); await manager.snapshot(b.id); await manager.snapshot(a.id);
    expect(manager.get(a.id).statusDetail).toBe('terminal mirror failed'); expect(manager.get(b.id).status).toBe('running');
    expect(output.mock.calls.map(call => call[1].toString())).toEqual(['healthy']);
    expect(await readFile(paths.log, 'utf8')).toContain('Session terminal mirror failed');
    expect(await readFile(paths.log, 'utf8') + JSON.stringify(events)).not.toContain('AITERMCANARY');
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});
