import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import pty from 'node-pty';
import * as engines from '../src/daemon/engines.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { buildTestEnv } from '../src/daemon/env.js';
import { runTests } from '../src/daemon/test-run.js';
import { prepareSandbox, sandboxDenial, sandboxProfile, SandboxPathError, SECRET_PATHS, toolchainPaths, type SandboxSpec } from '../src/daemon/test-sandbox.js';
import { validateTestPlan, validateTestResult } from '../src/shared/test-run.js';
import { cardText } from '../src/client/tui/agent-card.js';
import { TestAsk, testLines } from '../src/client/tui/test-ask.js';
import { validateRequest } from '../src/shared/validate.js';
import type { SessionInfo } from '../src/shared/protocol.js';
import { processRuns } from './platform.js';

// B26 (HIGH): auto-test ran the agent's own test and source files with your full rights, and a Codex agent writes files in
// its worktree without asking, so a "test" could read ~/.ssh or reach the network. Now the whole test process tree runs
// under macOS sandbox-exec with a profile built only from validated absolute paths: writes only in the agent's worktree
// and a per-run temp folder, no network (127.0.0.1 only when the project allows it), no reads of credential folders.
// Without a working sandbox nothing runs by itself: the card says `tests need you · no sandbox` and /test asks each time.
const MAC = process.platform === 'darwin';
const run = promisify(execFile), roots: string[] = [], managers: SessionManager[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.shutdown(); vi.restoreAllMocks(); SessionManager.sandboxExec = null; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-b26-'))); roots.push(dir); return dir; }
const spec: SandboxSpec = { worktree: '/Users/me/.ai-term/worktrees/r/my tree; $x ü', temp: '/private/var/folders/x/T/ai-term-test-1', home: '/Users/me', private: ['/Users/me/.ai-term'], loopback: false };

it('the profile is built from the exact paths: deny by default, writes only in the worktree and the temp folder, the credential folders unreadable', () => {
  const text = sandboxProfile(spec);
  expect(text).toMatch(/^\(version 1\)\n\(deny default\)/);
  expect(text).toContain(`(allow file-write* (subpath "${spec.worktree}") (subpath "${spec.temp}")`);
  for (const name of ['.ssh', '.aws', '.gnupg', '.netrc', '.npmrc', '.docker', '.kube', '.config/gh', 'Library/Keychains', '.ai-term', '.claude', '.claude.json', '.codex']) {
    expect(SECRET_PATHS).toContain(name);
    expect(text).toContain(`"/Users/me/${name}"`);
  }
  // The agent's own worktree lives inside ~/.ai-term: it alone is readable again after the deny.
  expect(text.indexOf(`(allow file-read-data file-read-xattr (subpath "${spec.worktree}") (subpath "${spec.temp}"))`)).toBeGreaterThan(text.indexOf('(deny file-read-data'));
  expect(text).not.toContain('remote ip');
  expect(sandboxProfile({ ...spec, loopback: true })).toContain('(allow network-outbound (remote ip "localhost:*"))');
});

it('refuses any path with quotes, parentheses, backslashes or control characters, and any path that is not absolute and plain', () => {
  for (const bad of ['/a"b', "/a'b", '/a(b', '/a)b', '/a\\b', '/a\nb', '/a\u0007b', '/a\u009bb', 'relative/path', '/a/../b', '/a//b', '/a/./b', ''])
    for (const field of ['worktree', 'temp', 'home'] as const) expect(() => sandboxProfile({ ...spec, [field]: bad }), `${field}: ${JSON.stringify(bad)}`).toThrow(SandboxPathError);
  expect(() => sandboxProfile({ ...spec, private: ['/ok', '/no"t'] })).toThrow(SandboxPathError);
});

it('reads a sandbox denial from the output: what it was, plainly (the path alone: it may have been a read or a write); a failure inside its own folders is not one', () => {
  const box = { worktree: '/private/var/w/tree', temp: '/private/var/w/tmp', home: '/Users/me', private: ['/Users/me/.ai-term'] };
  expect(sandboxDenial("Error: EPERM: operation not permitted, open '/Users/me/.ssh/id_test'", box)).toBe('~/.ssh/id_test');
  expect(sandboxDenial('touch: /Users/me/pwned: Operation not permitted', box)).toBe('~/pwned');
  expect(sandboxDenial('sh: /etc/hosts.new: Operation not permitted', box)).toBe('/etc/hosts.new');
  expect(sandboxDenial('Error: connect EPERM 127.0.0.1:8080 - Local (0.0.0.0:0)', box)).toBe('network');
  expect(sandboxDenial('curl: (6) Could not resolve host: example.com', box)).toBe('network');
  expect(sandboxDenial('    s.connect(("10.0.0.1", 80))\nPermissionError: [Errno 1] Operation not permitted', box)).toBe('network');
  // Its own worktree (also as /var/... for /private/var/...) and temp folder: a real test failure, not the sandbox.
  expect(sandboxDenial("EPERM: operation not permitted, unlink '/var/w/tree/locked'", box)).toBeNull();
  expect(sandboxDenial('cp: /private/var/w/tmp/x: Operation not permitted', box)).toBeNull();
  expect(sandboxDenial('Tests  2 failed | 5 passed', box)).toBeNull();
  expect(sandboxDenial(`touch: /opt/${'deep/'.repeat(30)}file.txt: Operation not permitted`, box)).toMatch(/^….*\/deep\/file\.txt$/);
  // An escape sequence in the path never reaches the card.
  expect(sandboxDenial("EPERM: operation not permitted, open '/Users/me/.ssh/\u001b[2Jx'", box)).toBe('~/.ssh/?[2Jx');
});

it.skipIf(!MAC)('macOS (skipped elsewhere: sandbox-exec is macOS only): a sandboxed test can\'t write to $HOME, read a planted ~/.ssh key, signal a process outside or connect out; it writes its worktree and TMPDIR', async () => {
  const dir = await temp(), home = join(dir, 'home'), tree = join(dir, 'tree'), other = join(home, '.ai-term', 'worktrees', 'r', 'other');
  await mkdir(join(home, '.ssh'), { recursive: true }); await writeFile(join(home, '.ssh', 'id_test'), 'PRIVATE-KEY-MATERIAL\n');
  await mkdir(other, { recursive: true }); await writeFile(join(other, 'secret.txt'), 'OTHER-AGENT\n'); await mkdir(tree);
  let connections = 0; const server = createServer(socket => { connections++; socket.end(); }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port, outside = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  const probe = join(tree, 'probe.sh');
  await writeFile(probe, ['#!/bin/sh', 'echo x > "$HOME/pwned"', 'cat "$HOME/.ssh/id_test" > stolen.txt', `cat "${other}/secret.txt" > other.txt`, `kill -TERM ${outside.pid ?? 0}`,
    `node -e 'require("net").connect(${port},"127.0.0.1").on("connect",()=>require("fs").writeFileSync("net.txt","connected")).on("error",()=>{})'`,
    'echo ok > "$TMPDIR/inside" && cat "$TMPDIR/inside" > tmpdir.txt', 'echo own > own.txt', 'exit 1', ''].join('\n'));
  await chmod(probe, 0o755);
  try {
    const box = await prepareSandbox(tree, { home, private: [join(home, '.ai-term')], loopback: false });
    const outcome = await runTests(['./probe.sh'], tree, { ...buildTestEnv(process.env), HOME: home, ...box.env }, { timeoutMs: 20_000, sandbox: box });
    expect(outcome).toEqual({ state: 'blocked', what: '~/pwned' });
    await expect(stat(join(home, 'pwned'))).rejects.toThrow();
    expect(await readFile(join(tree, 'stolen.txt'), 'utf8')).toBe('');
    expect(await readFile(join(tree, 'other.txt'), 'utf8')).toBe('');
    await expect(stat(join(tree, 'net.txt'))).rejects.toThrow();
    expect(connections).toBe(0);
    expect(outside.exitCode).toBeNull(); expect(outside.signalCode).toBeNull();
    expect(await readFile(join(tree, 'own.txt'), 'utf8')).toBe('own\n');
    expect(await readFile(join(tree, 'tmpdir.txt'), 'utf8')).toBe('ok\n');
    expect(box.env.TMPDIR.startsWith(await realpath(tmpdir()))).toBe(true);
    await box.dispose();
    await expect(stat(box.env.TMPDIR)).rejects.toThrow();
    // The project allowed 127.0.0.1: the same probe now reaches the local server, and nothing else changes.
    const loop = await prepareSandbox(tree, { home, private: [join(home, '.ai-term')], loopback: true });
    await runTests(['./probe.sh'], tree, { ...buildTestEnv(process.env), HOME: home, ...loop.env }, { timeoutMs: 20_000, sandbox: loop });
    await loop.dispose();
    expect(await readFile(join(tree, 'net.txt'), 'utf8')).toBe('connected');
    expect(connections).toBe(1);
  } finally { outside.kill('SIGKILL'); server.close(); }
}, 40_000);

it('a process the tests started and detached (setsid) is stopped when the run ends', async () => {
  const dir = await temp(), pidFile = join(dir, 'escaped.pid');
  const script = `use POSIX; my $p=fork(); if(!$p){POSIX::setsid(); open(my $f,'>','${pidFile}'); print $f $$; close $f; sleep 30; exit 0} sleep 1;`;
  expect(await runTests(['/usr/bin/perl', '-e', script], dir, buildTestEnv(process.env), { timeoutMs: 15_000 })).toEqual({ state: 'pass' });
  const pid = Number(await readFile(pidFile, 'utf8'));
  expect(pid).toBeGreaterThan(1);
  await vi.waitFor(() => expect(processRuns(pid)).toBe(false), { timeout: 3_000 });
}, 20_000);

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
const git = (cwd: string, ...args: string[]) => run('/usr/bin/git', [...ID, ...args], { cwd });
async function setup(script: string) {
  const dir = await temp(), repo = join(dir, 'repo'), home = join(dir, 'home');
  await mkdir(repo); await mkdir(home, { mode: 0o700 });
  await run('/usr/bin/git', ['init', '-q', '-b', 'main', '--', repo]);
  await writeFile(join(repo, 'check.sh'), script); await chmod(join(repo, 'check.sh'), 0o755);
  await git(repo, 'add', '--', '.'); await git(repo, 'commit', '-qm', 'initial', '--');
  const paths = getPaths(home); await preparePaths(paths);
  const real = pty.spawn;
  vi.spyOn(pty, 'spawn').mockImplementation((_file, _args, options) => real('/bin/sh', ['-c', 'sleep 30'], { ...options, env: { PATH: '/usr/bin:/bin' } }));
  vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' });
  const m = new SessionManager(paths, new Logger(paths.log)); managers.push(m); await m.load();
  const agent = await m.create({ engine: 'codex', model: 'gpt-test', auth: { kind: 'account' }, cwd: repo, permission: 'ask', title: 'fixer' });
  const live = (m as unknown as { sessions: Map<string, { info: SessionInfo }> }).sessions.get(agent.id);
  if (!live) throw new Error('no live'); live.info.status = 'done';
  await m.setTestCommand(repo, ['./check.sh']);
  return { repo, m, agent, tree: agent.worktree ?? '' };
}
const result = (m: SessionManager, id: string) => m.list().find(s => s.id === id)?.tests;

it('no working sandbox: nothing runs by itself; the card says tests need you · no sandbox; /test says so and runs only on your y, every time', async () => {
  SessionManager.sandboxExec = '/nonexistent/sandbox-exec';
  const { m, agent, tree } = await setup('#!/bin/sh\ntouch ran-it\necho "Tests  2 failed"\nexit 1\n');
  await m.afterTurn(agent.id);
  expect(result(m, agent.id)).toEqual({ state: 'nosandbox' });
  await expect(stat(join(tree, 'ran-it'))).rejects.toThrow();
  const plan = await m.testPlan(agent.id);
  expect(validateTestPlan(plan)).toMatchObject({ sandbox: false, loopback: false, changed: [] });
  await m.runTestPlan(agent.id, plan.fingerprint);
  await vi.waitFor(() => expect(result(m, agent.id)).toEqual({ state: 'fail', failing: 2 }), { timeout: 10_000 });
  await rm(join(tree, 'ran-it'));
  // Your y was for that run only: the next turn end asks again.
  await m.afterTurn(agent.id);
  expect(result(m, agent.id)).toEqual({ state: 'nosandbox' });
  await expect(stat(join(tree, 'ran-it'))).rejects.toThrow();
}, 20_000);

it.skipIf(!MAC)('macOS (skipped elsewhere: sandbox-exec is macOS only): a turn end runs the tests sandboxed; a write outside reads `✗ blocked by sandbox`, never a failure count; 127.0.0.1 is a per-project switch shown in /test', async () => {
  const { repo, m, agent } = await setup('#!/bin/sh\necho "Tests  2 failed"\necho x > "$0.outside"\necho x > ../escaped\nexit 1\n');
  await m.afterTurn(agent.id);
  const tests = result(m, agent.id);
  expect(tests?.state).toBe('blocked');
  expect(tests && 'what' in tests ? tests.what : '').toMatch(/\/escaped$/);
  const plan = await m.testPlan(agent.id);
  expect(plan).toMatchObject({ sandbox: true, loopback: false });
  expect(await m.setTestLoopback(repo, true)).toEqual({ repo, loopback: true });
  const allowed = await m.testPlan(agent.id);
  expect(allowed.loopback).toBe(true); expect(allowed.fingerprint).not.toBe(plan.fingerprint);
  await expect(m.runTestPlan(agent.id, plan.fingerprint)).rejects.toThrow('The test setup changed since it was shown; run /test again');
}, 30_000);

it('cards, results and the /test popup say it plainly; l switches 127.0.0.1 for the project', async () => {
  const now = new Date().toISOString();
  const info: SessionInfo = { id: '6f1c4f53-3a1e-4bb0-9a49-3f3f3f3f3f3f', title: 'fixer', engine: 'codex', model: 'gpt', auth: { kind: 'account' }, cwd: '/tmp/t', worktree: '/tmp/t', branch: 'ai/fixer', permission: 'ask', status: 'done', statusDetail: 'done', statusSince: now, createdAt: now, lastOutputAt: now, exitCode: 0, ctxPercent: null, lastActivity: null, diffStat: { added: 3, removed: 1, files: 2 } };
  expect(cardText({ ...info, tests: { state: 'blocked', what: 'network' } }, Date.now(), 120).activity).toEqual({ text: '+3 −1 · ✗ blocked by sandbox: network', color: 'status-error' });
  expect(cardText({ ...info, tests: { state: 'nosandbox' } }, Date.now(), 120).activity).toEqual({ text: '+3 −1 · tests need you · no sandbox', color: 'status-waiting' });
  expect(validateTestResult({ state: 'blocked', what: 'read ~/.ssh/id_test' })).toEqual({ state: 'blocked', what: 'read ~/.ssh/id_test' });
  expect(validateTestResult({ state: 'nosandbox' })).toEqual({ state: 'nosandbox' });
  expect(() => validateTestResult({ state: 'blocked', what: 'x\u001b[2J' })).toThrow();
  expect(() => validateTestResult({ state: 'blocked', what: 'x'.repeat(200) })).toThrow();
  const plan = { title: 'fixer', command: ['npm', 'test'], cwd: '/tmp/t', changed: [], fingerprint: 'a'.repeat(64), sandbox: true, loopback: false };
  const text = (p: typeof plan) => testLines(p, 'darwin').map(line => line.text).join('\n');
  expect(text(plan)).toContain('sandbox: writes only in this worktree and a temp folder · no network');
  expect(text(plan)).toContain('127.0.0.1: off · l allows it for this project');
  expect(text({ ...plan, loopback: true })).toContain('127.0.0.1: on for this project · l turns it off');
  expect(text({ ...plan, sandbox: false })).toContain("no sandbox: it runs with your user's rights (files, network, your keys' folders)");
  expect(text({ ...plan, sandbox: false })).not.toContain('l allows');
  const toggled = vi.fn();
  const ask = new TestAsk(plan, () => {}, () => {}, () => {}, toggled);
  // On Linux 127.0.0.1 is always the run's own, so l has nothing to switch there.
  ask.key('l'); if (process.platform === 'linux') expect(toggled).not.toHaveBeenCalled(); else expect(toggled).toHaveBeenCalledWith(true);
  const id = '6f1c4f53-3a1e-4bb0-9a49-3f3f3f3f3f3f';
  await expect(validateRequest({ id, kind: 'project.setTestLoopback', cwd: '/tmp', allowed: true })).resolves.toMatchObject({ allowed: true });
  await expect(validateRequest({ id, kind: 'project.setTestLoopback', cwd: '/tmp', allowed: 'yes' })).rejects.toThrow();
});

it.skipIf(!MAC)('macOS (skipped elsewhere: sandbox-exec is macOS only): a key folder that is a link elsewhere stays unreadable through its target', async () => {
  const dir = await temp(), home = join(dir, 'home'), keys = join(dir, 'vault', 'ssh'), tree = join(dir, 'tree');
  await mkdir(keys, { recursive: true }); await mkdir(home); await mkdir(tree);
  await writeFile(join(keys, 'id_test'), 'PRIVATE-KEY-MATERIAL\n');
  await run('/bin/ln', ['-s', keys, join(home, '.ssh')]);
  await writeFile(join(tree, 'probe.sh'), `#!/bin/sh\ncat "$HOME/.ssh/id_test" > via-link.txt\ncat "${keys}/id_test" > via-target.txt\nexit 0\n`); await chmod(join(tree, 'probe.sh'), 0o755);
  const box = await prepareSandbox(tree, { home, private: [], loopback: false });
  try { await runTests(['./probe.sh'], tree, { ...buildTestEnv(process.env), HOME: home, ...box.env }, { timeoutMs: 20_000, sandbox: box }); }
  finally { await box.dispose(); }
  expect(await readFile(join(tree, 'via-link.txt'), 'utf8')).toBe('');
  expect(await readFile(join(tree, 'via-target.txt'), 'utf8')).toBe('');
}, 30_000);

// Follow-up (Yaniv, during Part A): the sandbox still let a test read every file outside the key folders and copy it into
// the worktree, where the agent reads it (Claude Code would have asked before reading outside its folder). Now the whole
// home folder, /Volumes, /tmp and the user temp area are unreadable, except the worktree, the run's temp folder, the
// repository's git folder and the toolchains tests need (those on PATH under home, the usual version managers).
it('the profile hides the home folder, /Volumes, /tmp and the user temp area, and opens only the toolchains and the git folder', () => {
  const text = sandboxProfile({ ...spec, hidden: ['/Users/me', '/Volumes', '/private/tmp'], readable: ['/Users/me/.nvm', '/Users/me/src/repo/.git'] });
  const hide = text.indexOf('(deny file-read-data file-read-xattr (subpath "/Users/me") (subpath "/Volumes") (subpath "/private/tmp"))');
  const open = text.indexOf('(allow file-read-data file-read-xattr (subpath "/Users/me/.nvm") (subpath "/Users/me/src/repo/.git"))');
  const keys = text.indexOf('(deny file-read-data file-read-xattr (subpath "/Users/me/.ssh")'), own = text.indexOf(`(allow file-read-data file-read-xattr (subpath "${spec.worktree}") (subpath "${spec.temp}"))`);
  expect(hide).toBeGreaterThan(0); expect(open).toBeGreaterThan(hide); expect(keys).toBeGreaterThan(open); expect(own).toBeGreaterThan(keys);
  expect(toolchainPaths('/Users/me', { PATH: '/Users/me/.nvm/versions/node/v22/bin:/Users/me/bin:/Users/me:/opt/homebrew/bin:/Users/me/.local/bin', PYENV_ROOT: '/Users/me/.pyenv', GOPATH: '/Users/me/go', HOME: '/Users/me' }))
    .toEqual(expect.arrayContaining(['/Users/me/.nvm/versions/node/v22', '/Users/me/bin', '/Users/me/.local/bin', '/Users/me/.pyenv', '/Users/me/go', '/Users/me/.cargo', '/Users/me/.gitconfig']));
  for (const wide of ['/Users/me', '/Users', '/', '/opt/homebrew/bin']) expect(toolchainPaths('/Users/me', { PATH: '/Users/me/bin:/Users/me:/opt/homebrew/bin', VIRTUAL_ENV: '/', HOME: '/Users/me' })).not.toContain(wide);
  const box = { worktree: '/private/var/w/tree', temp: '/private/var/w/tmp', home: '/Users/me', private: [], hidden: ['/Users/me'], readable: [] };
  expect(sandboxDenial("EPERM: operation not permitted, open '/Users/me/Documents/notes.txt'", box)).toBe('~/Documents/notes.txt');
});

it.skipIf(!MAC)('macOS (skipped elsewhere: sandbox-exec is macOS only): a test can\'t read ~/Documents or /tmp to copy them into the worktree; toolchains on PATH and the git folder still work', async () => {
  const dir = await temp(), home = join(dir, 'home'), tree = join(dir, 'tree'), tool = join(home, '.tools', 'v1');
  await mkdir(join(home, 'Documents'), { recursive: true }); await writeFile(join(home, 'Documents', 'notes.txt'), 'PRIVATE-NOTES\n');
  await mkdir(join(tool, 'bin'), { recursive: true }); await writeFile(join(tool, 'bin', 'mytool'), '#!/bin/sh\necho tool-ran\n'); await chmod(join(tool, 'bin', 'mytool'), 0o755);
  const loose = await realpath(await mkdtemp('/private/tmp/ai-b26-loose-')); roots.push(loose); await writeFile(join(loose, 'scratch.txt'), 'TMP-SECRET\n');
  await run('/usr/bin/git', ['init', '-q', '-b', 'main', '--', tree]); await git(tree, 'commit', '-q', '--allow-empty', '-m', 'first', '--');
  await writeFile(join(tree, 'probe.sh'), ['#!/bin/sh', 'cat "$HOME/Documents/notes.txt" > notes.txt', `cat "${loose}/scratch.txt" > tmp.txt`, 'ls "$HOME" > listing.txt', 'mytool > tool.txt', '/usr/bin/git log --format=%s > git.txt', 'exit 0', ''].join('\n'));
  await chmod(join(tree, 'probe.sh'), 0o755);
  const env = { ...buildTestEnv(process.env), HOME: home, PATH: `${join(tool, 'bin')}:/usr/bin:/bin` };
  const box = await prepareSandbox(tree, { home, private: [], loopback: false, env });
  try { await runTests(['./probe.sh'], tree, { ...env, ...box.env }, { timeoutMs: 20_000, sandbox: box }); }
  finally { await box.dispose(); }
  expect(await readFile(join(tree, 'notes.txt'), 'utf8')).toBe('');
  expect(await readFile(join(tree, 'tmp.txt'), 'utf8')).toBe('');
  expect(await readFile(join(tree, 'listing.txt'), 'utf8')).toBe('');
  expect(await readFile(join(tree, 'tool.txt'), 'utf8')).toBe('tool-ran\n');
  expect(await readFile(join(tree, 'git.txt'), 'utf8')).toBe('first\n');
}, 30_000);

it.skipIf(!MAC)('MEDIUM (TS review, macOS: sandbox-exec is macOS only): /test y works out what to run once, with the sandbox, so nothing fails after the sandbox is made and leaves its temp folder', async () => {
  const { m, agent } = await setup('#!/bin/sh\nexit 0\n');
  const plan = await m.testPlan(agent.id), target = vi.spyOn(m as unknown as { testTarget: (live: unknown) => Promise<unknown> }, 'testTarget');
  await m.runTestPlan(agent.id, plan.fingerprint);
  expect(target).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(result(m, agent.id)).toEqual({ state: 'pass' }), { timeout: 10_000 });
}, 20_000);
