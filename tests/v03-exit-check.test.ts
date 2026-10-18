import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import headless from '@xterm/headless';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { DaemonServer } from '../src/daemon/server.js';
import { Connection } from '../src/client/connection.js';
import { split } from '../src/client/split.js';
import { createTheme } from '../src/client/tui/theme.js';

// v0.3 exit check: two agents (a stub engine) on the same repo, in a split, each writing files through its own pane.
const stub = { path: '' };
vi.mock('../src/daemon/engines.js', () => ({ checkEngine: async () => ({ installed: true, path: stub.path, loggedIn: true, authMethod: 'subscription' }) }));
const run = promisify(execFile), git = (cwd: string, ...args: string[]) => run('/usr/bin/git', args, { cwd }).then(r => r.stdout);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
class TTY extends EventEmitter {
  isTTY = true; isRaw = false; columns = 130; rows = 45; output = '';
  setRawMode(raw: boolean) { this.isRaw = raw; } resume() {} pause() {}
  write(data: string | Buffer) { this.output += data.toString(); if (data.toString().includes('\x1b[c')) queueMicrotask(() => this.emit('data', Buffer.from('\x1b[?1;2c'))); return true; }
}
async function screen(tty: TTY): Promise<string> {
  const terminal = new headless.Terminal({ cols: tty.columns, rows: tty.rows, allowProposedApi: true });
  try { await new Promise<void>(resolve => terminal.write(tty.output, resolve)); return Array.from({ length: tty.rows }, (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n'); }
  finally { terminal.dispose(); }
}
// Pane i's body text: the split's left and right halves (65 and 64 columns, a one-column divider between).
async function pane(tty: TTY, i: number): Promise<string> { return (await screen(tty)).split('\n').map(line => i === 0 ? line.slice(0, 65) : line.slice(66)).join('\n'); }

it('two agents in a split write only into their own worktrees, and the original checkout is untouched', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'ai-exit-')); roots.push(temp);
  const repo = join(temp, 'repo'), home = join(temp, 'home'); await mkdir(repo); await mkdir(home, { mode: 0o700 });
  await writeFile(join(repo, 'README'), 'base\n'); await git(repo, 'init', '-b', 'main', '--'); await git(repo, 'add', '--', 'README');
  await git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'base', '--');
  const head = await git(repo, 'rev-parse', 'HEAD'), status = await git(repo, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored');
  // The stub engine ignores its CLI flags: each line typed into it becomes <line>.txt in its folder, then it lists the folder.
  stub.path = join(temp, 'stub-engine');
  await writeFile(stub.path, '#!/bin/sh\nprintf "READY\\n"\nwhile IFS= read -r line; do printf "by %s\\n" "$line" > "$line.txt"; printf "SEE:"; ls -1A | tr "\\n" " "; printf ":END\\n"; done\n'); await chmod(stub.path, 0o755);
  const paths = getPaths(home); await preparePaths(paths);
  const log = new Logger(paths.log), manager = new SessionManager(paths, log), server = new DaemonServer(paths, manager, log);
  const tty = new TTY();
  try {
    await manager.load(); await server.listen();
    const a = await manager.create({ engine: 'codex', model: null, auth: { kind: 'account' }, cwd: repo, permission: 'ask', title: 'left' });
    const b = await manager.create({ engine: 'codex', model: null, auth: { kind: 'account' }, cwd: repo, permission: 'ask', title: 'right' });
    expect(a.worktree).toBeDefined(); expect(b.worktree).toBeDefined(); expect(a.worktree).not.toBe(b.worktree);
    await expect.poll(() => manager.list().every(s => s.status === 'running'), { timeout: 10_000 }).toBe(true);
    const done = split([a.id, b.id], { stdin: tty, stdout: tty, signals: new EventEmitter(), theme: createTheme('graphite'), connect: () => Connection.connect(paths, { entry: '/unused', autoStart: false }) });
    await vi.waitFor(async () => expect(await screen(tty)).toContain('each pane is its own agent in its own worktree'), { timeout: 10_000 });
    // Keys go to the focused (left) pane; Ctrl+\ moves focus to the right pane.
    tty.emit('data', Buffer.from('alpha\r'));
    await vi.waitFor(async () => expect(await pane(tty, 0)).toMatch(/SEE:\.git README alpha\.txt :END/), { timeout: 10_000 });
    tty.emit('data', Buffer.from([0x1c])); tty.emit('data', Buffer.from('beta\r'));
    await vi.waitFor(async () => expect(await pane(tty, 1)).toMatch(/SEE:\.git README beta\.txt :END/), { timeout: 10_000 });
    // Each agent's own listing never shows the other's file, and the left pane never received "beta".
    expect(await pane(tty, 0)).not.toContain('beta'); expect(await pane(tty, 1)).not.toContain('alpha');
    tty.emit('data', Buffer.from([0x05])); await expect(done).resolves.toMatchObject({ reason: 'home key' });
    // On disk: each worktree has only its own file.
    expect((await readdir(a.worktree ?? '')).sort()).toEqual(['.git', 'README', 'alpha.txt']);
    expect((await readdir(b.worktree ?? '')).sort()).toEqual(['.git', 'README', 'beta.txt']);
    expect(await readFile(join(a.worktree ?? '', 'alpha.txt'), 'utf8')).toBe('by alpha\n');
    // The original checkout: same files, same HEAD, same branch, same (clean) status, nothing written into it.
    expect((await readdir(repo)).sort()).toEqual(['.git', 'README']);
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(head); expect((await git(repo, 'branch', '--show-current')).trim()).toBe('main');
    expect(await git(repo, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored')).toBe(status);
    expect((await git(repo, 'worktree', 'list', '--porcelain')).match(/^worktree /gm)).toHaveLength(3);
    // Each agent works on its own branch; neither branch has a commit the other or main lacks.
    expect((await git(repo, 'for-each-ref', '--format=%(refname:short) %(objectname)', '--', 'refs/heads/')).trim().split('\n').sort()).toEqual([`ai/left ${head.trim()}`, `ai/right ${head.trim()}`, `main ${head.trim()}`]);
  } finally { await server.close(); await manager.shutdown(); }
}, 30_000);
