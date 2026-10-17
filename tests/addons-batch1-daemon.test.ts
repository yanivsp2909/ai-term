import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pty from 'node-pty';
import { runAb } from '../src/daemon/perf-ab.js';
import { tempClone } from '../src/daemon/temp-clone.js';
import { buildBisectEnv } from '../src/daemon/env.js';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import * as engines from '../src/daemon/engines.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { SettingsStore } from '../src/daemon/settings.js';
import type { SessionInfo } from '../src/shared/protocol.js';
import type { TestOutcome } from '../src/daemon/test-run.js';

// v1.1 batch 1, the daemon's own parts: /perf's A/B, /bisect's env and temporary copy, and the session manager's glue.
const run = promisify(execFile), roots: string[] = [], managers: SessionManager[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.shutdown(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
const git = async (cwd: string, ...args: string[]) => (await run('/usr/bin/git', [...ID, ...args], { cwd })).stdout.trim();
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-batch1-d-'))); roots.push(dir); return dir; }

it('the A/B alternates before and after each round and reports the medians; a run that fails stops it', async () => {
  const order: string[] = [], times = { before: [100, 130, 110, 900, 120], after: [40, 45, 30, 50, 35] };
  let clock = 0;
  const side = (name: 'before' | 'after') => ({ cwd: `/${name}`, run: async (): Promise<TestOutcome> => { order.push(name); clock += times[name].shift() ?? 0; return { state: 'pass' }; } });
  expect(await runAb(side('before'), side('after'), { now: () => clock, sandbox: true })).toEqual({ state: 'done', rounds: 5, beforeMs: 120, afterMs: 40, sandbox: true });
  expect(order).toEqual(['before', 'after', 'after', 'before', 'before', 'after', 'after', 'before', 'before', 'after']);
  const failing = { cwd: '/after', run: async (): Promise<TestOutcome> => ({ state: 'fail', failing: 1 }) };
  expect(await runAb(side('before'), failing, { now: () => 0, sandbox: false })).toEqual({ state: 'failed', reason: "The benchmark didn't pass on the after code (it failed)" });
});

it('bisect\'s env has no keys and ignores your global and system git config', () => {
  const env = buildBisectEnv({ PATH: '/usr/bin', HOME: '/Users/y', OPENAI_API_KEY: 'sk-x', GITHUB_TOKEN: 'ghp_x', GIT_DIR: '/elsewhere', AITERM_STATUS_TOKEN: 'x' });
  expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/Users/y', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', CI: '1' });
  expect(Object.keys(env).filter(name => /KEY|TOKEN|AITERM|^GIT_DIR$/.test(name))).toEqual([]);
});

it('a temporary copy checks out one commit, shares objects without writing to your repository, and goes away', async () => {
  const dir = await temp(), repo = join(dir, 'repo'); await mkdir(repo);
  await git(dir, 'init', '-q', '-b', 'main', '--', repo);
  await writeFile(join(repo, 'a.txt'), 'one\n'); await git(repo, 'add', '--', '.'); await git(repo, 'commit', '-qm', 'one', '--'); const first = await git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'a.txt'), 'two\n'); await git(repo, 'commit', '-qam', 'two', '--');
  const before = [(await readdir(join(repo, '.git'))).sort().join(','), await git(repo, 'status', '--porcelain'), await git(repo, 'worktree', 'list', '--porcelain')];
  const copy = await tempClone(repo, first);
  expect(await readFile(join(copy.path, 'a.txt'), 'utf8')).toBe('one\n');
  expect(await readFile(join(copy.path, '.git', 'objects', 'info', 'alternates'), 'utf8')).toContain(join(repo, '.git', 'objects'));
  expect([(await readdir(join(repo, '.git'))).sort().join(','), await git(repo, 'status', '--porcelain'), await git(repo, 'worktree', 'list', '--porcelain')]).toEqual(before);
  await copy.dispose();
  await expect(readdir(copy.path)).rejects.toThrow();
  await expect(tempClone(repo, 'main')).rejects.toThrow();
});

async function manager() {
  const dir = await temp(), repo = join(dir, 'repo'), home = join(dir, 'home');
  await mkdir(repo); await mkdir(home, { mode: 0o700 });
  await run('/usr/bin/git', ['init', '-q', '-b', 'main', '--', repo]);
  await writeFile(join(repo, 'check.sh'), '#!/bin/sh\necho ran >> ran.log\nexit 0\n'); await chmod(join(repo, 'check.sh'), 0o755);
  await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
  await git(repo, 'add', '--', '.'); await git(repo, 'commit', '-qm', 'initial', '--');
  const paths = getPaths(home); await preparePaths(paths);
  const real = pty.spawn;
  vi.spyOn(pty, 'spawn').mockImplementation((_file, _args, options) => real('/bin/sh', ['-c', 'sleep 30'], { ...options, env: { PATH: '/usr/bin:/bin' } }));
  vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' });
  const m = new SessionManager(paths, new Logger(paths.log)); managers.push(m); await m.load();
  const agent = await m.create({ engine: 'codex', model: 'gpt-test', auth: { kind: 'account' }, cwd: repo, permission: 'ask', title: 'fixer' });
  const live = (m as unknown as { sessions: Map<string, { info: SessionInfo }> }).sessions.get(agent.id);
  if (!live) throw new Error('no live'); live.info.status = 'done';
  return { repo, home, m, agent, tree: agent.worktree ?? '' };
}

it('/teach and /review deep get the agent\'s diff and worktree; an empty diff is said plainly', async () => {
  const { m, agent, tree } = await manager();
  await expect(m.addonAgent(agent.id)).rejects.toThrow("This agent's diff is empty");
  await writeFile(join(tree, 'a.ts'), 'export const a = 2;\n');
  const view = await m.addonAgent(agent.id);
  expect(view).toMatchObject({ title: 'fixer', cwd: tree });
  expect(view.diff).toContain('a.ts'); expect(view.diff).toContain('export const a = 2;');
  expect(Buffer.byteLength(view.diff)).toBeLessThanOrEqual(9000);
});

it('with auto-test off, an add-on that keeps tests (/fix, /cover, /refactor) still runs them in the sandbox after its turn', async () => {
  const { repo, home, m, agent, tree } = await manager();
  await m.setTestCommand(repo, ['./check.sh']); await new SettingsStore(home).set({ autoTest: false });
  await m.afterTurn(agent.id);
  expect(m.list().find(s => s.id === agent.id)?.tests).toBeUndefined();
  (m.addons as unknown as { tests: Set<string> }).tests.add(agent.id);
  await m.afterTurn(agent.id);
  await vi.waitFor(() => expect(m.list().find(s => s.id === agent.id)?.tests).toMatchObject({ state: process.platform === 'darwin' ? 'pass' : expect.any(String) }), { timeout: 10_000 });
  if (process.platform === 'darwin') expect(await readFile(join(tree, 'ran.log'), 'utf8')).toBe('ran\n');
});

it.skipIf(process.platform !== 'darwin')('macOS: /perf\'s A/B runs the same new benchmark on the code before (a temporary copy) and after (the worktree), sandboxed', async () => {
  const { m, agent, tree } = await manager();
  await mkdir(join(tree, 'bench')); await writeFile(join(tree, 'bench', 'a.sh'), '#!/bin/sh\ngrep -q "a = " a.ts\n'); await chmod(join(tree, 'bench', 'a.sh'), 0o755);
  await writeFile(join(tree, 'a.ts'), 'export const a = 2;\n');
  const view = await m.addonPerfAb(agent.id, ['./bench/a.sh'], ['bench/a.sh'], false);
  expect(view).toMatchObject({ state: 'done', rounds: 5, sandbox: true });
  // A file that isn't a new benchmark under bench/ is never copied into the before side.
  await expect(m.addonPerfAb(agent.id, ['./bench/a.sh'], ['a.ts'], false)).rejects.toThrow();
}, 60_000);

it('LOW (security review): the agent\'s diff fits the first message after JSON escaping, so an approved run can start', async () => {
  const { m, agent, tree } = await manager();
  await writeFile(join(tree, 'a.ts'), Array.from({ length: 400 }, () => '"\\\\"\\\\"\\\\"\\\\"\\\\"\\\\"\\\\"\\\\"\\\\"').join('\n'));
  const view = await m.addonAgent(agent.id);
  expect(Buffer.byteLength(JSON.stringify(view.diff))).toBeLessThanOrEqual(8800);
  expect(view.diff).toContain('(the diff is cut here; read the rest in the worktree)');
});
