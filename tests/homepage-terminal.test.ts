import { expect, it } from 'vitest';
import { mkdtemp, lstat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import * as pty from 'node-pty';
import headless from '@xterm/headless';
import { Connection } from '../src/client/connection.js';
import { getPaths, isFsError } from '../src/shared/paths.js';

it('source CLI opens homepage, enters a shell, returns via Ctrl+E, previews it and leaves agents running on /exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-term-home-terminal-')), paths = getPaths(root), entry = resolve('src/cli/index.ts');
  const env = { PATH: '/usr/bin:/bin', HOME: root, SHELL: '/bin/sh', AI_TERM_HOME: root, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  const daemon = spawn(process.execPath, ['--import', 'tsx', entry, 'daemon'], { env, stdio: 'ignore' }), exited = new Promise<void>(r => daemon.once('exit', () => r()));
  const terminal = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true });
  let client: Connection | undefined, child: pty.IPty | undefined, childDone: Promise<number> | undefined, finished = false;
  const lines = () => Array.from({ length: terminal.rows }, (_, y) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + y)?.translateToString() ?? '').join('\n');
  try {
    await expect.poll(async () => { try { return (await lstat(paths.socket)).isSocket(); } catch (error) { if (isFsError(error, 'ENOENT')) return false; throw error; } }, { timeout: 5000 }).toBe(true);
    client = await Connection.connect(paths, { entry, autoStart: false });
    const id = (await client.request({ kind: 'sessions.create', engine: 'shell', cwd: root })).session?.id;
    if (!id) throw new Error('Missing session');
    child = pty.spawn(process.execPath, ['--import', 'tsx', entry], { env, cwd: resolve('.'), cols: 130, rows: 45, name: 'xterm-256color' });
    childDone = new Promise<number>(r => child?.onExit(event => { finished = true; r(event.exitCode); }));
    let output = ''; child.onData(data => { output += data; terminal.write(data); });
    // v1.2: a new AI Term folder opens the first-run setup (it replaced the login popup there); Esc skips it. The setup
    // first: on a Mac it covers the Agents title before a poll sees it (v1.2.0 Mac check).
    await expect.poll(lines, { timeout: 10_000 }).toContain("What's installed"); child.write('\x1b'); await expect.poll(lines, { timeout: 10_000 }).not.toContain("What's installed");
    await expect.poll(lines, { timeout: 10_000 }).toContain('Agents 1');
    child.write('\r'); await expect.poll(lines, { timeout: 10_000 }).not.toContain('AI Term_');
    child.write('printf HOMEPAGE_SHELL_TEXT\r'); await expect.poll(lines, { timeout: 10_000 }).toContain('HOMEPAGE_SHELL_TEXT');
    child.write('\x05'); await expect.poll(lines, { timeout: 10_000 }).toContain('AI Term_'); await expect.poll(lines, { timeout: 10_000 }).toContain('HOMEPAGE_SHELL_TEXT');
    child.write('/theme slate\r'); await expect.poll(async () => (await client?.request({ kind: 'settings.get' }))?.settings?.theme, { timeout: 10_000 }).toBe('slate');
    child.resize(99, 29); terminal.resize(99, 29); await expect.poll(lines, { timeout: 10_000 }).not.toContain('This Mac');
    child.resize(130, 45); terminal.resize(130, 45); await expect.poll(lines, { timeout: 10_000 }).toContain('This Mac');
    child.write('/exit\r'); expect(await childDone).toBe(0);
    expect(output.slice(-500)).toContain('\x1b[?1006l'); expect(output.slice(-500)).toContain('\x1b[?2031l'); expect(output.slice(-500)).toContain('\x1b[?1049l');
    expect((await client.request({ kind: 'sessions.list' })).sessions?.find(s => s.id === id)?.status).toBe('running');
  } finally {
    if (child && !finished) child.kill(); if (childDone) await childDone;
    client?.close(); if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGTERM'); await exited;
    terminal.dispose(); await rm(root, { recursive: true, force: true });
  }
}, 60_000);
