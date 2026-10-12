import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pty from 'node-pty';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
const roots: string[] = [];
const managers: SessionManager[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const manager of managers.splice(0)) await manager.shutdown(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
// node-pty closes the PTY fd as soon as the child hangs up, but reports the exit only when its wait callback runs.
// A resize in between throws this exact error (seen with real PTYs under load); here the gap is held open on purpose.
async function hungUp() {
  const root = await mkdtemp(join(tmpdir(), 'ai-term-hangup-')); roots.push(root);
  const paths = getPaths(root); await preparePaths(paths);
  const manager = new SessionManager(paths, new Logger(paths.log), { executable: '/bin/sh', args: ['-c', 'printf up; read answer'], env: { PATH: '/usr/bin:/bin' } }); managers.push(manager);
  await manager.load();
  const spawn = pty.spawn.bind(pty);
  let terminal: pty.IPty | undefined;
  vi.spyOn(pty, 'spawn').mockImplementation((...args) => { terminal = spawn(...args); return terminal; });
  const session = await manager.create({ cwd: root });
  await expect.poll(() => manager.get(session.id).status).toBe('running');
  if (!terminal) throw new Error('no terminal');
  const resize = vi.spyOn(terminal, 'resize').mockImplementation(() => { throw new Error('ioctl(2) failed, EBADF'); });
  return { manager, session, resize };
}

it('a preview resize that lands after the child hung up, before its exit is reported, still resizes the preview', async () => {
  const { manager, session, resize } = await hungUp();
  const events: unknown[] = []; manager.on('event', event => events.push(event));
  await expect(manager.previewSize(40, 12)).resolves.toBeUndefined();
  expect(resize).toHaveBeenCalled();
  expect(events).toContainEqual({ kind: 'session.previewResized', sessionId: session.id, cols: 40, rows: 12 });
});

it('attach and detach still work in that gap', async () => {
  const { manager, session } = await hungUp();
  const publish = vi.fn();
  await expect(manager.attach(session.id, 70, 20, publish)).resolves.toBeUndefined();
  expect(publish).toHaveBeenCalledWith(expect.any(String), { cols: 70, rows: 20 }, expect.any(Object));
  await expect(manager.resizeAttached(session.id, 80, 24, () => true)).resolves.toBeUndefined();
  await expect(manager.detach(session.id, () => true)).resolves.toBeUndefined();
});

it('any other resize failure still reaches the caller', async () => {
  const { manager, resize } = await hungUp();
  resize.mockImplementation(() => { throw new Error('resizing must be done using positive cols and rows'); });
  await expect(manager.previewSize(40, 12)).rejects.toThrow('resizing must be done using positive cols and rows');
});
