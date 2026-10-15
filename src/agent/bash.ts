import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { PERSISTENCE_DIRS, PERSISTENCE_FILES, SANDBOX_EXEC, SandboxPathError, sandboxPath } from '../daemon/test-sandbox.js';
import { bashSandboxPlan, bwrapBashArgs, findBwrap, runtimeDirs, ShadowError, type BwrapBashSpec } from '../daemon/bwrap.js';
import { BWRAP_PROBE } from '../daemon/agent-sandbox.js';
import { visible } from './display.js';
import { isFsError } from '../shared/paths.js';
import { ToolError } from './tools.js';
import { killGroup } from '../shared/kill-tree.js';
import { findGitBash } from './win-bash.js';
import { GIT } from '../daemon/git-path.js';

// A command line longer than this is refused before any approval: a person can still read it whole.
export const BASH_MAX_COMMAND_BYTES = 16 * 1024;
export const BASH_DEFAULT_TIMEOUT_MS = 120_000, BASH_MAX_TIMEOUT_MS = 600_000, BASH_OUTPUT_MAX_BYTES = 64 * 1024;
const KILL_GRACE_MS = 1000;
// blocked: a protected place the sandbox refused, as ~/path (B29), so the agent reads why rather than a bare EPERM.
export interface BashResult { exitCode: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; interrupted: boolean; cut: boolean; stopFailed: boolean; blocked?: string; unsandboxed?: string }
// sandbox: AI Term's own folder (~/.ai-term). Gate (Yaniv): on macOS a command runs under sandbox-exec with a profile that
// lets it do what you could, except read or write that folder (its settings, budgets, keys' metadata, other agents'
// files; the agent's own worktree in it stays open) or connect to AI Term's sockets there. Without sandbox-exec (another
// OS) it runs as before.
// protect: git folders whose hooks and config a command may not write (the repository a worktree shares its .git with:
// a hook planted there would run unsandboxed at your next commit).
// user: your home folder (B29), whose startup files and persistence folders a command may not write; os.homedir() unless
// a test passes a fake one.
// require: Don't ask (v0.8.1). A command never runs without its sandbox then: no sandbox-exec, no bubblewrap or another
// system refuses it. In Ask you approve each command, so it runs as before where no sandbox exists.
// platform, linux: process.platform and the real bubblewrap, unless a test says otherwise.
export interface BashOptions { cwd: string; env: Record<string, string>; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal; sandbox?: { home: string; protect?: readonly string[]; user?: string; require?: boolean; platform?: NodeJS.Platform; linux?: { bwrap: string | null; ready: () => Promise<boolean> }; shell?: ShellDirs } }
// Real paths (link targets included) of the places in PERSISTENCE_FILES and PERSISTENCE_DIRS; parents: the folders
// between your home and them (~/.config, ~/Library), which may not be renamed, removed or replaced by a link (security
// review: a ~/.config swapped for a link would lead ~/.config/git somewhere no rule names). Their other contents stay open.
export interface Persistence { files: readonly string[]; dirs: readonly string[]; parents?: readonly string[] }
export function bashProfile(home: string, cwd: string, protect: readonly string[] = [], persistence: Persistence = { files: [], dirs: [] }): string {
  const own = cwd.startsWith(`${home}/`) ? [`(allow file-read-data file-read-xattr file-write* (subpath "${sandboxPath(cwd)}"))`, `(allow network-outbound (remote unix-socket (subpath "${sandboxPath(cwd)}")))`] : [];
  const literals = [...persistence.files, ...persistence.parents ?? []];
  return ['(version 1)', '(allow default)',
    // No debugger attach (task ports) and no peeking into other processes: the agent's and daemon's memory hold the key and
    // AI Term's credentials (fix review). Their own child processes stay visible.
    '(deny mach-priv-task-port)', '(deny process-info* (target others))',
    `(deny file-read-data file-read-xattr file-write* (subpath "${sandboxPath(home)}"))`, `(deny network-outbound (remote unix-socket (subpath "${sandboxPath(home)}")))`, ...own,
    ...protect.map(dir => `(deny file-write* (subpath "${sandboxPath(join(dir, 'hooks'))}") (literal "${sandboxPath(join(dir, 'config'))}"))`),
    // B29, last so nothing above reopens them (rules are last-match-wins).
    ...literals.length + persistence.dirs.length ? [`(deny file-write* ${[...literals.map(path => `(literal "${sandboxPath(path)}")`), ...persistence.dirs.map(path => `(subpath "${sandboxPath(path)}")`)].join(' ')})`] : [], ''].join('\n');
}
// A path and, when it is a link, where it leads, even when that doesn't exist yet (a dangling dotfile link would create
// its target). Only a missing path falls back; any other failure refuses the command rather than leave a place open.
async function withTarget(path: string): Promise<string[]> {
  try { return [path, await realpath(path)]; } catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
  try { return [path, resolve(dirname(path), await readlink(path))]; } catch (error) { if (isFsError(error, 'ENOENT') || isFsError(error, 'EINVAL')) return [path]; throw error; }
}
// Each place under your home as given and as its real path (the sandbox matches real paths, and home may be a link).
// ZDOTDIR moves zsh's startup files, so they are protected there too.
// shell: the daemon's ZDOTDIR and XDG_CONFIG_HOME, handed to the agent apart from the bash env (gate: the bash env never
// carries them, so reading them there protected nothing).
export interface ShellDirs { zdotdir?: string; configHome?: string; runtime?: string }
const CONFIG_PLACES = ['git', 'fish', 'autostart', 'systemd/user', 'environment.d', 'plasma-workspace/env', 'autostart-scripts', 'i3', 'sway', 'hypr', 'openbox'];
export async function persistencePaths(user: string, env: Readonly<Record<string, string | undefined>> = {}, shell: ShellDirs = {}): Promise<Persistence> {
  const real = await realpath(user).catch((error: unknown) => { if (isFsError(error, 'ENOENT')) return user; throw error; });
  const homes = [...new Set([user, real])];
  const zdotdir = shell.zdotdir ?? env.ZDOTDIR, configHome = shell.configHome;
  const zdot = zdotdir && isAbsolute(zdotdir) ? ['.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zlogout'].map(name => join(normalize(zdotdir), name)) : [];
  const config = configHome && isAbsolute(configHome) ? CONFIG_PLACES.map(name => join(normalize(configHome), name)) : [];
  const all = async (paths: readonly string[]) => [...new Set((await Promise.all(paths.map(withTarget))).flat())];
  const under = (names: readonly string[]) => homes.flatMap(home => names.map(name => join(home, name)));
  const parents = [...new Set([...PERSISTENCE_FILES, ...PERSISTENCE_DIRS].flatMap(name => name.split('/').slice(0, -1).map((_, at, parts) => parts.slice(0, at + 1).join('/'))))];
  return { files: await all([...under(PERSISTENCE_FILES), ...zdot]), dirs: await all([...under(PERSISTENCE_DIRS), ...config]), parents: under(parents) };
}
// macOS (gate, reproduced): every folder above a protected place may not be renamed either, or renaming it and putting a
// copy back leaves a writable file at the protected path's old place (a dotfile link's target, .git/hooks, AI Term's
// folder). Home and the folders above it are left out: you can't rename those anyway.
export function ancestorLiterals(paths: readonly string[], user: string): string[] {
  const found = new Set<string>();
  for (const path of paths) for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) if (!(user === parent || user.startsWith(`${parent}/`))) found.add(parent);
  return [...found];
}
// The protected place a refusal names, as ~/path; null when the output names none (the command's own error then stands).
// A name may be relative to wherever the command had gone (`cd ~ && echo >> .zshrc`): it is tried from the folder and from
// home. macOS paths are case-insensitive, so the comparison is too.
const REFUSED = /Operation not permitted|EPERM|Read-only file system|EROFS|Device or resource busy|EBUSY/i, PATH_TOKEN = /[^\s:'",;()]*[./][^\s:'",;()]*/g;
export function blockedPlace(output: string, cwd: string, user: string, guarded: Persistence & { home?: string }): string | null {
  const fold = (path: string) => process.platform === 'darwin' ? path.toLowerCase() : path;
  const within = (path: string, dir: string) => fold(path) === fold(dir) || fold(path).startsWith(`${fold(dir)}/`);
  const inside = (path: string) => !within(path, cwd) && ([...guarded.files, ...guarded.parents ?? []].some(file => fold(file) === fold(path)) || [...guarded.dirs, ...guarded.home ? [guarded.home] : []].some(dir => within(path, dir)));
  for (const line of output.split('\n')) {
    if (!REFUSED.test(line)) continue;
    for (const token of line.match(PATH_TOKEN) ?? []) {
      const tries = token.startsWith('~/') ? [join(user, token.slice(2))] : isAbsolute(token) ? [normalize(token)] : [resolve(cwd, token), resolve(user, token)];
      const path = tries.find(inside);
      if (path) return within(path, user) ? `~/${path.slice(user.length + 1)}` : path;
    }
  }
  return null;
}
// The argv that runs a command line: sandboxed when it can be; a folder no profile can hold is refused, never run bare.
// guard: what a refusal is read against afterwards.
// unsandboxed: why an Ask command ran without a sandbox, reported with its result (gate: it was silent).
interface Argv { program: string; args: string[]; guard?: { user: string; cwd: string; places: Persistence & { home: string } }; unsandboxed?: string }
async function bashArgv(command: string, options: BashOptions): Promise<Argv> {
  const plain: Argv = { program: '/bin/sh', args: ['-c', command] };
  const platform = options.sandbox?.platform ?? process.platform, required = options.sandbox?.require === true;
  if (platform === 'win32') { if (required) throw new ToolError("bash can't run in don't ask without a sandbox: Windows has none AI Term can use"); return { ...await windowsArgv(command), ...options.sandbox ? { unsandboxed: 'Windows has none AI Term can use' } : {} }; }
  if (!options.sandbox) return plain;
  const without = (why: string): Argv => { if (required) throw new ToolError(`bash can't run in don't ask without a sandbox: ${why}`); return { ...plain, unsandboxed: why }; };
  if (platform === 'linux') return linuxArgv(command, options, without);
  if (platform !== 'darwin') return without('this system has none AI Term can use');
  try { await access(SANDBOX_EXEC, constants.X_OK); } catch { return without("macOS's sandbox-exec is missing"); }
  const user = options.sandbox.user ?? homedir();
  const missing = (fallback: string) => (error: unknown) => { if (isFsError(error, 'ENOENT')) return fallback; throw error; };
  let home: string, cwd: string, realUser: string, persistence: Persistence;
  let protect: string[];
  try {
    [home, cwd, realUser, persistence] = await Promise.all([realpath(options.sandbox.home).catch(missing(options.sandbox.home)), realpath(options.cwd), realpath(user).catch(missing(user)), persistencePaths(user, options.env, options.sandbox.shell)]);
    protect = await Promise.all((options.sandbox.protect ?? []).map(dir => realpath(dir).catch(missing(dir))));
  }
  catch { throw new ToolError("bash can't run here: AI Term couldn't check the folders its sandbox protects"); }
  persistence = { ...persistence, parents: [...new Set([...persistence.parents ?? [], ...ancestorLiterals([...persistence.files, ...persistence.dirs, ...protect, home], realUser), ...ancestorLiterals([...persistence.files, ...persistence.dirs, ...protect, home], user)])] };
  let profile: string;
  try { profile = bashProfile(home, cwd, protect, persistence); } catch (error) { if (error instanceof SandboxPathError) throw new ToolError("bash can't run here: AI Term can't sandbox a path with quotes, parentheses or control characters (this folder, or where one of your dotfile links leads)"); throw error; }
  return { program: SANDBOX_EXEC, args: ['-p', profile, '--', '/bin/sh', '-c', command], guard: { user: realUser, cwd, places: { ...persistence, home } } };
}

// Windows (v0.8.2): no sandbox (so Ask only); the command line goes to Git for Windows' bash.exe as one argv element, as
// /bin/sh -c elsewhere. Without Git for Windows there is no bash to run it with.
async function windowsArgv(command: string): Promise<Argv> {
  const bash = await findGitBash(GIT);
  if (!bash) throw new ToolError("bash needs Git for Windows (its bash.exe), which isn't installed");
  return { program: bash, args: ['-c', command] };
}
// Linux (v0.8.1): bubblewrap with D57 + B29's rules (src/daemon/bwrap.ts). A refused write there reads as a read-only
// file system, or busy for a folder that was rebuilt or pinned. Where bubblewrap can't start (user namespaces off, a
// container) or its plan can't be made, Ask runs the command you approved as before and Don't ask refuses (TS review).
// The probe is looked at once per agent: bash commands don't wait on it again.
// A probe that worked is kept for the agent's life; one that failed is tried again at the next command (gate: a passing
// hiccup kept Don't ask refusing until restart).
export function probeCacheMs(ok: boolean): number { return ok ? Infinity : 0; }
let linuxReady: Promise<boolean> | null = null;
const probeLinux = (bwrap: string): Promise<boolean> => {
  const probe = linuxReady ?? new Promise<boolean>(done => { execFile(bwrap, [...BWRAP_PROBE], { timeout: 10_000, env: { PATH: '/usr/bin:/bin' } }, error => done(!error)); });
  linuxReady = probe;
  void probe.then(ok => { if (probeCacheMs(ok) === 0 && linuxReady === probe) linuxReady = null; });
  return probe;
};
async function linuxArgv(command: string, options: BashOptions, without: (why: string) => Argv): Promise<Argv> {
  const sandbox = options.sandbox; if (!sandbox) return without('no sandbox was asked for');
  const bwrap = sandbox.linux ? sandbox.linux.bwrap : await findBwrap();
  if (!bwrap) return without("bubblewrap (bwrap) isn't installed");
  if (!await (sandbox.linux ? sandbox.linux.ready() : probeLinux(bwrap))) return without("bubblewrap couldn't start a sandbox here");
  const user = sandbox.user ?? homedir();
  let spec: BwrapBashSpec, persistence: Persistence, args: string[];
  try {
    const runtime = await runtimeDirs({ ...process.env, ...sandbox.shell?.runtime ? { XDG_RUNTIME_DIR: sandbox.shell.runtime } : {} });
    [spec, persistence] = await Promise.all([bashSandboxPlan({ user, aiTermHome: sandbox.home, cwd: options.cwd, protect: sandbox.protect ?? [], runtime, ...sandbox.shell ? { shell: sandbox.shell } : {} }), persistencePaths(user, options.env, sandbox.shell)]);
    args = bwrapBashArgs(spec);
  } catch (error) {
    return without(error instanceof ShadowError ? error.message.replace(/^bash can't run here: /, '') : error instanceof SandboxPathError ? 'a path it protects has control characters' : "AI Term couldn't check the folders its sandbox protects");
  }
  return { program: bwrap, args: [...args, '--', '/bin/sh', '-c', command], guard: { user: spec.shadows[0]?.dir ?? user, cwd: spec.cwd, places: { ...persistence, home: spec.aiTermHome } } };
}

// The bash tool runs the model's command line as one argv element of /bin/sh -c: running that line *is* the tool, and it is
// the one shell AI Term starts (S8). It gets its own process group so a timeout or Esc stops everything it started, a
// fixed env with no key (buildBashEnv), no stdin, and capped output.
// Process groups of commands still running, so the kill switch and a stop of the agent can end them all at once.
const running = new Set<number>();
export function killAllBash(): number {
  let count = 0;
  // The kill switch counts what it stopped; a failure taskkill reports later goes to stderr, never a silent miss.
  for (const pid of running) { try { killGroup(pid, 'SIGKILL', () => { process.stderr.write('ai agent: a command could not be stopped\n'); }); count++; } catch (error) { if (!isFsError(error, 'ESRCH')) count++; } }
  return count;
}
export async function runBash(command: string, options: BashOptions): Promise<BashResult> {
  const timeoutMs = Math.min(BASH_MAX_TIMEOUT_MS, Math.max(1000, options.timeoutMs ?? BASH_DEFAULT_TIMEOUT_MS)), maxBytes = options.maxBytes ?? BASH_OUTPUT_MAX_BYTES;
  const { program, args, guard, unsandboxed } = await bashArgv(command, options);
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: options.cwd, env: options.env, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    if (child.pid !== undefined) running.add(child.pid);
    let outBytes = 0, errBytes = 0, cut = false, timedOut = false, interrupted = false, settled = false, stopFailed = false;
    const take = (chunks: Buffer[], chunk: Buffer, used: number): number => {
      const room = maxBytes - used;
      if (room <= 0) { cut = true; return used; }
      if (chunk.length > room) { cut = true; chunks.push(chunk.subarray(0, room)); return maxBytes; }
      chunks.push(chunk); return used + chunk.length;
    };
    child.stdout.on('data', (chunk: Buffer) => { outBytes = take(out, chunk, outBytes); });
    child.stderr.on('data', (chunk: Buffer) => { errBytes = take(err, chunk, errBytes); });
    const stopGroup = (): void => {
      const pid = child.pid; if (pid === undefined) return;
      // ESRCH: the whole group already exited. Anything else means it may still run, and the report says so.
      const signal = (name: NodeJS.Signals): void => { try { killGroup(pid, name, () => { stopFailed = true; }); } catch (error) { if (!isFsError(error, 'ESRCH')) stopFailed = true; } };
      signal('SIGTERM'); setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => { timedOut = true; stopGroup(); }, timeoutMs);
    const onAbort = (): void => { interrupted = true; stopGroup(); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.on('error', error => { if (child.pid !== undefined) running.delete(child.pid); if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); reject(error); });
    child.on('close', (code, signal) => {
      if (child.pid !== undefined) running.delete(child.pid);
      if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort);
      const stdout = Buffer.concat(out).toString('utf8'), stderr = Buffer.concat(err).toString('utf8');
      const blocked = guard ? blockedPlace(`${stderr}\n${stdout}`, guard.cwd, guard.user, guard.places) : null;
      resolve({ exitCode: code, signal, stdout, stderr, timedOut, interrupted, cut, stopFailed, ...blocked ? { blocked } : {}, ...unsandboxed ? { unsandboxed } : {} });
    });
  });
}

// What the model reads back: exit status first, then the two streams, each marked if it was cut.
export function bashReport(result: BashResult, timeoutMs: number): string {
  const status = result.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s; the command and everything it started were stopped` : result.interrupted ? 'interrupted by the user' : result.exitCode !== null ? `exit ${result.exitCode}` : `stopped by ${result.signal ?? 'a signal'}`;
  const parts = [status];
  if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
  if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
  if (result.stopFailed) parts.push('(some processes it started could not be stopped)');
  if (result.unsandboxed) parts.push(`(ran without a sandbox: ${result.unsandboxed})`);
  if (result.blocked) parts.push(`✗ blocked by sandbox: ${result.blocked} · agent commands can't change startup files, login items, ~/.ssh, git's global settings, or Claude Code's, Codex's or AI Term's own files`);
  if (result.cut) parts.push(`(output cut at ${BASH_OUTPUT_MAX_BYTES} bytes per stream)`);
  return parts.join('\n');
}

export function checkCommand(command: unknown): string {
  if (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command) > BASH_MAX_COMMAND_BYTES) throw new ToolError(`command must be text up to ${BASH_MAX_COMMAND_BYTES} bytes`);
  return command;
}
export function bashPreview(command: string, timeoutMs: number): { title: string; body: string } {
  return { title: `bash · ${Math.round(timeoutMs / 1000)}s limit`, body: visible(command) };
}
