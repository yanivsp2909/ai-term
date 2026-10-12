import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import pty from 'node-pty';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { PtyHost } from '../src/daemon/pty-host.js';
import { Mirror } from '../src/daemon/mirror.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it('B15 awaits every stop and cleans every mirror when one stop rejects', async () => {
  const root = await mkdtemp('/tmp/ai-b15-'), paths = getPaths(root); await preparePaths(paths);
  const log = new Logger(paths.log), manager = new SessionManager(paths, log);
  let release: () => void = () => {};
  const gate = new Promise<void>(r => { release = r; });
  try {
    await manager.load();
    vi.spyOn(pty, 'spawn').mockImplementation(() => { throw new Error('AITERMCANARY'); });
    const a = await manager.create({ cwd: root }), b = await manager.create({ cwd: root });
    const stop = vi.spyOn(manager, 'stop').mockImplementation(async id => { if (id === a.id) throw new Error('AITERMCANARY'); await gate; });
    const dispose = vi.spyOn(Mirror.prototype, 'dispose');
    let settled = false;
    const done = manager.shutdown().then(() => { settled = true; }, () => { settled = true; });
    await new Promise(r => setImmediate(r));
    expect(settled).toBe(false); expect(stop.mock.calls).toEqual([[a.id], [b.id]]);
    release(); await done;
    expect(dispose).toHaveBeenCalledTimes(2);
    const text = await readFile(paths.log, 'utf8'); expect(text).toContain(`Session stop failed: ${a.id}`); expect(text).not.toContain('AITERMCANARY');
    expect(log.listenerCount('writeFailed')).toBe(0);
  } finally { release(); await rm(root, { recursive: true, force: true }); }
});
it('B15 bounds the exit wait after SIGKILL and cancels all wait timers', async () => {
  vi.useFakeTimers();
  vi.spyOn(pty, 'spawn').mockReturnValue({ pid: 900001, onExit: () => ({ dispose() {} }) } as unknown as pty.IPty);
  const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
  const host = new PtyHost({ executable: '/stub', args: [], env: {} }, '/tmp', 80, 24);
  let result = 'pending';
  const done = host.stop().then(() => { result = 'resolved'; }, error => { result = (error as Error).message; });
  await vi.advanceTimersByTimeAsync(6000);
  expect(result).toBe('Session stop timed out'); expect(signal.mock.calls.map(call => call[1])).toEqual(['SIGTERM', 'SIGKILL']);
  await done; expect(vi.getTimerCount()).toBe(0);
});
it('B15 process signal failures expose only a fixed stop cause', async () => {
  vi.spyOn(pty, 'spawn').mockReturnValue({ pid: 900001, onExit: () => ({ dispose() {} }) } as unknown as pty.IPty);
  vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('AITERMCANARY'); });
  const host = new PtyHost({ executable: '/stub', args: [], env: {} }, '/tmp', 80, 24);
  await expect(host.stop()).rejects.toThrow('Session stop signal failed');
});
