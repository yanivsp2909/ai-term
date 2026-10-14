import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pty from 'node-pty';
import { listWorktrees } from '../src/daemon/git.js';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { Logger } from '../src/daemon/log.js';
import { SettingsStore } from '../src/daemon/settings.js';
vi.mock('../src/daemon/engines.js', () => ({ checkEngine: async () => ({ installed: true, path: process.execPath, loggedIn: true, authMethod: 'subscription' }) }));
const run = promisify(execFile), roots: string[] = [], managers: SessionManager[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.shutdown(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), 'ai-retry-')); roots.push(temp);
  const repo = join(temp, 'repo'), home = join(temp, 'home'); await mkdir(join(repo, 'sub'), { recursive: true }); await mkdir(home, { mode: 0o700 });
  await writeFile(join(repo, 'sub', 'tracked.txt'), 'committed'); await run('/usr/bin/git', ['init', '--', repo]);
  await run('/usr/bin/git', ['add', '--', 'sub/tracked.txt'], { cwd: repo });
  await run('/usr/bin/git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'initial', '--'], { cwd: repo });
  const paths = getPaths(home); await preparePaths(paths);
  const m = new SessionManager(paths, new Logger(paths.log)); managers.push(m); await m.load();
  return { repo, home, m };
}
// Node stands in for the CLI and exits at once on Claude/Codex flags, so every agent here ends as failed.
const finished = (m: SessionManager, id: string) => expect.poll(() => m.get(id).status).toMatch(/^(exited|error)$/);

it('/retry restarts a failed agent with the same engine, model, effort, mode and folder, reusing its worktree', async () => {
  const { repo, m } = await fixture(), spawn = vi.spyOn(pty, 'spawn');
  const first = await m.create({ engine: 'codex', model: 'gpt-test', effort: 'high', auth: { kind: 'account' }, cwd: join(repo, 'sub'), permission: 'dontAsk', title: 'fixer' });
  await finished(m, first.id);
  const retried = await m.retry(first.id);
  expect(retried.id).not.toBe(first.id);
  expect(retried).toMatchObject({ engine: 'codex', model: 'gpt-test', effort: 'high', permission: 'dontAsk', title: 'fixer', cwd: first.cwd, worktree: first.worktree, branch: first.branch });
  // Same worktree: no new one, and the old record is replaced rather than kept beside it.
  expect((await listWorktrees(repo)).length).toBe(2);
  expect(m.list().map(s => s.id)).toEqual([retried.id]);
  // A fresh start: never Codex's resume picker.
  const args = spawn.mock.calls.at(-1)?.[1] ?? [];
  expect(args).not.toContain('resume'); expect(spawn.mock.calls.at(-1)?.[2]?.cwd).toBe(first.cwd);
});

it('a Claude retry starts a new conversation instead of resuming the old one', async () => {
  const { repo, m } = await fixture(), spawn = vi.spyOn(pty, 'spawn');
  const first = await m.create({ engine: 'claude-code', model: 'sonnet', auth: { kind: 'account' }, cwd: repo, permission: 'ask' });
  await finished(m, first.id);
  const retried = await m.retry(first.id);
  expect(retried.conversationId).toBeDefined(); expect(retried.conversationId).not.toBe(first.conversationId);
  const args = spawn.mock.calls.at(-1)?.[1] ?? [];
  expect(args).toContain(`--session-id=${retried.conversationId}`); expect(args.join(' ')).not.toContain('--resume');
});

it('an agent that ran in place retries in place, even with worktrees turned back on', async () => {
  const { repo, home, m } = await fixture();
  await new SettingsStore(home).set({ worktrees: 'off' });
  const first = await m.create({ engine: 'codex', model: null, auth: { kind: 'account' }, cwd: repo, permission: 'ask' });
  await finished(m, first.id);
  await new SettingsStore(home).set({ worktrees: 'on' });
  const retried = await m.retry(first.id);
  expect(retried.worktree).toBeUndefined(); expect(retried.cwd).toBe(repo);
  expect((await listWorktrees(repo)).length).toBe(1);
});

it('running agents are refused; a deleted worktree or folder is refused with a fixed reason and nothing starts', async () => {
  const { repo, home, m } = await fixture();
  const shellHome = getPaths(home), shells = new SessionManager(shellHome, new Logger(shellHome.log), { executable: '/bin/sh', args: ['-c', 'read answer'], env: { PATH: '/usr/bin:/bin' } });
  managers.push(shells); await shells.load();
  const running = await shells.create({ cwd: repo });
  await expect(shells.retry(running.id)).rejects.toThrow('Retry needs a finished agent');
  const first = await m.create({ engine: 'codex', model: null, auth: { kind: 'account' }, cwd: repo, permission: 'ask', title: 'gone' });
  await finished(m, first.id);
  await run('/usr/bin/git', ['worktree', 'remove', '--force', '--', first.worktree ?? ''], { cwd: repo });
  const spawn = vi.spyOn(pty, 'spawn');
  await expect(m.retry(first.id)).rejects.toThrow('Its worktree is gone');
  expect(spawn).not.toHaveBeenCalled(); expect(m.list().map(s => s.id)).toContain(first.id);
});

it('a worktree another live agent already uses is refused', async () => {
  const { repo, m } = await fixture();
  const first = await m.create({ engine: 'codex', model: null, auth: { kind: 'account' }, cwd: repo, permission: 'ask', title: 'shared' });
  await finished(m, first.id);
  // The resumed agent stays "running" because its stub PTY never exits.
  const exits: ((e: { exitCode: number }) => void)[] = [];
  vi.spyOn(pty, 'spawn').mockImplementation(() => ({ pid: 900003, onData: () => ({ dispose() {} }), onExit: (cb: (e: { exitCode: number }) => void) => { exits.push(cb); return { dispose() {} }; }, write() {}, resize() {}, pause() {}, resume() {} }) as unknown as pty.IPty);
  const resumed = await m.resume(first.id);
  expect(resumed.worktree).toBe(first.worktree);
  vi.spyOn(process, 'kill').mockImplementation(() => { for (const exit of exits) exit({ exitCode: 0 }); return true; });
  await expect(m.retry(first.id)).rejects.toThrow('Worktree in use by a running agent');
});
