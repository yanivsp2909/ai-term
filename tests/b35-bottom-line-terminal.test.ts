import { expect, it } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import * as pty from 'node-pty';
import headless from '@xterm/headless';
import { getPaths, isFsError } from '../src/shared/paths.js';
import { runOnce } from './first-exec.js';

// B35, the way tier 2 met it: a brand-new AI Term folder, Claude Code found and logged in (a stub that says so), 120
// columns, then 100 and 80. The bottom line names the engine whole and has no empty field at every width.
const STUB_CLAUDE = `#!/bin/sh
case "$1" in
  --version) echo "2.0.0 (Claude Code)" ;;
  auth) echo '{"loggedIn":true,"authMethod":"claude.ai"}' ;;
esac
`;
const HINTS = '↑↓ agents  ⏎ open  p preview  / commands';

it('a fresh AI Term folder with Claude Code logged in shows claude code · own login whole at 120, 100 and 80 columns', async () => {
  // realpath: on a Mac tmpdir() is under /var, a link to /private/var, and the homepage reads ~ from the real cwd.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-term-b35-'))), state = join(root, '.ai-term'), bin = join(root, 'bin'), project = join(root, 'projects', 'demo');
  await mkdir(bin); await mkdir(project, { recursive: true });
  await writeFile(join(bin, 'claude'), STUB_CLAUDE); await chmod(join(bin, 'claude'), 0o755); await runOnce(join(bin, 'claude'));
  const paths = getPaths(state), entry = resolve('src/cli/index.ts');
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: root, SHELL: '/bin/sh', AI_TERM_HOME: state, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  const terminal = new headless.Terminal({ cols: 120, rows: 40, allowProposedApi: true });
  const screen = () => Array.from({ length: terminal.rows }, (_, y) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + y)?.translateToString() ?? '');
  const bottom = () => screen().at(-1) ?? '';
  let child: pty.IPty | undefined, childDone: Promise<number> | undefined, finished = false;
  try {
    child = pty.spawn(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), entry], { env, cwd: project, cols: 120, rows: 40, name: 'xterm-256color' });
    childDone = new Promise<number>(r => child?.onExit(event => { finished = true; r(event.exitCode); }));
    child.onData(data => terminal.write(data));
    // A new AI Term folder opens the first-run setup; Esc skips it, as tier 2 does.
    await expect.poll(() => screen().join('\n'), { timeout: 15_000 }).toContain("What's installed");
    child.write('\x1b'); await expect.poll(() => screen().join('\n'), { timeout: 10_000 }).not.toContain("What's installed");
    expect(screen().join('\n')).not.toContain('Connect a provider');
    // Tier 2's first check, as it is written.
    await expect.poll(bottom, { timeout: 10_000 }).toMatch(/· claude code · own login/);
    expect(bottom().trimEnd()).toBe(` ${'CLI default · claude code · own login · sub · ask · worktree on'.padEnd(120 - HINTS.length - 2)}${HINTS}`);
    child.resize(100, 40); terminal.resize(100, 40);
    await expect.poll(() => bottom().trimEnd(), { timeout: 10_000 }).toBe(' CLI default · claude code · own login · sub · ask · worktree on · ~/projects/demo');
    child.resize(80, 40); terminal.resize(80, 40);
    await expect.poll(() => bottom().trimEnd(), { timeout: 10_000 }).toBe(' CLI default · claude code · own login · sub · ask · worktree on');
    child.write('/exit\r'); expect(await childDone).toBe(0);
  } finally {
    if (child && !finished) child.kill(); if (childDone) await childDone;
    await stopDaemon(paths.socket, state);
    terminal.dispose(); await rm(root, { recursive: true, force: true });
  }
}, 60_000);

// The client started this test's own daemon (its folder is private to the test, cwd outside the repo, so tsx is
// resolved here): stop it by its pid file.
async function stopDaemon(socket: string, state: string): Promise<void> {
  try {
    const pid = Number(await readFile(join(state, 'run', 'daemon.pid'), 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, 'SIGTERM');
  } catch (error) { if (!(isFsError(error, 'ENOENT') || (error instanceof Error && 'code' in error && error.code === 'ESRCH'))) throw error; }
  await expect.poll(async () => { try { await lstat(socket); return true; } catch (error) { if (isFsError(error, 'ENOENT')) return false; throw error; } }, { timeout: 10_000 }).toBe(false);
}
