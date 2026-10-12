import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as pty from 'node-pty';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { DaemonServer } from '../src/daemon/server.js';
import { Logger } from '../src/daemon/log.js';

// Leaving a session, attach drops its signal listeners and waits for the daemon's detach reply before the homepage
// takes the signals back. With no listener at all, Node restores the default action and the signal kills the client.
it.each([['SIGTERM', 143], ['SIGHUP', 129]] as const)('%s while the homepage waits for a detach reply quits with %i instead of dying', async (signal, code) => {
  const root = await mkdtemp('/tmp/ai-handoff-'), paths = getPaths(root); await preparePaths(paths);
  const log = new Logger(paths.log), manager = new SessionManager(paths, log, { executable: '/bin/sh', args: ['-c', 'printf SESSION_READY; read answer'], env: { PATH: '/usr/bin:/bin' } });
  const server = new DaemonServer(paths, manager, log);
  let release: () => void = () => undefined; const gate = new Promise<void>(r => { release = r; });
  const detach = manager.detach.bind(manager);
  const held = vi.spyOn(manager, 'detach').mockImplementation(async (...args) => { await gate; await detach(...args); });
  const events: unknown[] = []; manager.on('event', event => events.push(event));
  let child: pty.IPty | undefined, finished = false;
  try {
    await manager.load(); await server.listen();
    const session = await manager.create({ cwd: root }); await expect.poll(() => manager.get(session.id).status).toBe('running');
    child = pty.spawn(process.execPath, ['--import', 'tsx', resolve('src/cli/index.ts')], { cwd: resolve('.'), cols: 130, rows: 45, env: { PATH: '/usr/bin:/bin', HOME: root, AI_TERM_HOME: root, TERM: 'xterm-256color', COLORTERM: 'truecolor' } });
    let output = ''; child.onData(data => { output += data; });
    const exited = new Promise<{ exitCode: number; signal?: number }>(r => child?.onExit(event => { finished = true; r(event); }));
    await expect.poll(() => output, { timeout: 10000 }).toContain('AI Term');
    child.write('\r');
    // The daemon resizes the session to the client's terminal only once the attach is accepted.
    await expect.poll(() => events, { timeout: 10000 }).toContainEqual({ kind: 'session.previewResized', sessionId: session.id, cols: 130, rows: 45 });
    child.write('\x05');
    await expect.poll(() => held.mock.calls.length, { timeout: 10000 }).toBe(1);
    output = '';
    child.kill(signal);
    // Give a default-action death time to happen before the reply arrives.
    await expect.poll(() => finished, { timeout: 500 }).toBe(true).catch(() => undefined);
    release();
    expect(await exited).toMatchObject({ exitCode: code, signal: 0 });
    expect(output).not.toContain('\x1b[?1049h'); // the homepage never came back
    expect(manager.get(session.id).status).toBe('running');
  } finally { release(); if (child && !finished) child.kill('SIGKILL'); await server.close(); await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
}, 30000);
