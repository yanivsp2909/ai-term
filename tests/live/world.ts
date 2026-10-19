import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Connection } from '../../src/client/connection.js';
import { getPaths } from '../../src/shared/paths.js';
import { removeTree } from '../../src/daemon/temp-clone.js';
import { LiveFailure, Screen, sleep } from './screen.js';

// One throwaway world per run: a temp folder holding a fake home (with a planted fake ~/.ssh and its own Downloads),
// AI Term's folder inside it, a temp folder for TMPDIR and a bin folder that offers only node, npm and npx. The real
// ~/.ai-term, ~/Downloads, your logins and your daemon are never named. Tier 2 keeps the temp AI Term folder but runs
// with your real home, so Claude Code and Codex find their own logins (AI Term never reads them).
const run = promisify(execFile);
export const REPO = resolve(import.meta.dirname, '..', '..');
export const ENTRY = join(REPO, 'dist', 'cli', 'index.js');
export const FAKE_KNOWN_HOSTS = 'live-suite.invalid ssh-ed25519 AAAAFAKEKEYFORTHELIVESUITEONLY\n';
export interface World { root: string; home: string; aiHome: string; tmp: string; bin: string; downloads: string; env: Record<string, string>; realHome: boolean }

export async function makeWorld(options: { realHome?: boolean } = {}): Promise<World> {
  // Short names on purpose: the daemon's socket path (<AI Term folder>/run/daemon.sock) must fit macOS's 104 bytes for a
  // unix socket, and the user temp folder alone takes 57 of them.
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'ail-')));
  const realHome = options.realHome === true, home = realHome ? homedir() : join(root, 'h');
  const aiHome = join(root, realHome ? 'a' : 'h/.ai-term'), tmp = join(root, 't'), bin = join(root, 'b');
  await mkdir(tmp); await mkdir(bin);
  // Only node, npm and npx on PATH beyond the system folders: no claude, codex, gh or tailscale, so tier 1 can't find
  // (or make AI Term ask about) a login.
  const node = process.execPath;
  for (const name of ['node', 'npm', 'npx']) {
    const target = name === 'node' ? node : join(dirname(node), name);
    // nvm and volta keep npm elsewhere: say so rather than leave a link that fails later in /bisect (review).
    try { await access(target); } catch { throw new LiveFailure(`${name} isn't next to this node (${dirname(node)}): the live suite needs node, npm and npx in one folder`); }
    await symlink(target, join(bin, name));
  }
  let downloads = join(home, 'Downloads');
  if (!realHome) {
    await mkdir(join(home, '.ssh'), { recursive: true, mode: 0o700 }); await writeFile(join(home, '.ssh', 'known_hosts'), FAKE_KNOWN_HOSTS, { mode: 0o600 });
    await mkdir(downloads);
    await writeFile(join(home, '.gitconfig'), '[user]\n\tname = Live Suite\n\temail = live@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
  } else downloads = join(root, 'Downloads-unused');
  const env: Record<string, string> = {
    HOME: home, AI_TERM_HOME: aiHome, TMPDIR: tmp, USER: userInfo().username, LOGNAME: userInfo().username,
    PATH: realHome ? process.env.PATH ?? '/usr/bin:/bin' : `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    // B34: macOS's zsh where it exists, else the first shell this machine has (Linux has no /bin/zsh by default).
    SHELL: ['/bin/zsh', '/bin/bash', '/bin/sh'].find(path => existsSync(path)) ?? '/bin/sh', TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8',
  };
  const world = { root, home, aiHome, tmp, bin, downloads, env, realHome };
  guard(world);
  return world;
}
// Refuse to run anywhere near the real AI Term folder, and with a fake home in tier 1.
function guard(world: World): void {
  const real = join(homedir(), '.ai-term');
  if (!world.aiHome.startsWith(`${world.root}/`) || world.aiHome === real || world.env.AI_TERM_HOME !== world.aiHome) throw new LiveFailure('the live suite must run with a temporary AI Term folder');
  if (!world.realHome && (world.home === homedir() || !world.home.startsWith(`${world.root}/`))) throw new LiveFailure('tier 1 must run with a temporary home folder');
}

// `ai` itself, the built one, in a PTY; the daemon starts by itself on its first connection, as it does for you.
// The world's env is checked again at every start (security review: one dropped HOME would point ~ at your real home).
export function startAi(world: World, cwd: string, args: readonly string[] = [], size = { cols: 120, rows: 40 }): Screen {
  guard(world);
  if (world.env.HOME !== world.home || world.env.TMPDIR !== world.tmp) throw new LiveFailure('the world\'s HOME or TMPDIR changed');
  return new Screen(process.execPath, [ENTRY, ...args], { env: world.env, cwd, ...size });
}
export async function connect(world: World): Promise<Connection> {
  return Connection.connect(getPaths(world.aiHome), { entry: ENTRY, autoStart: false });
}
// The run's daemon, started again in the same world (with the world's env, not the suite's own) if it died: tier 2 must
// still remove your key then.
export async function connectOrStart(world: World): Promise<Connection> {
  try { return await connect(world); } catch (error) { if (!(error instanceof Error)) throw error; }
  spawn(process.execPath, [ENTRY, 'daemon'], { env: world.env, detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; ; i++) {
    try { return await connect(world); } catch (error) { if (i >= 50) throw error; }
    await sleep(200);
  }
}
export async function aiCommand(world: World, args: readonly string[], cwd = world.root, timeout = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  try { const { stdout, stderr } = await run(process.execPath, [ENTRY, ...args], { env: world.env, cwd, timeout, maxBuffer: 4 * 1024 * 1024 }); return { code: 0, stdout, stderr }; }
  catch (error) {
    const e = error as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code !== 'number') throw error;
    return { code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('/usr/bin/git', ['-c', 'user.name=Live Suite', '-c', 'user.email=live@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, env: { PATH: '/usr/bin:/bin', HOME: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })).stdout.trim();
}
// A git repository of its own under the world, with one commit.
export async function makeRepo(world: World, name: string, files: Record<string, string> = { 'README.md': `# ${name}\n` }): Promise<string> {
  const repo = join(world.root, 'repos', name);
  await mkdir(repo, { recursive: true });
  await git(repo, 'init', '-q', '-b', 'main');
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(repo, path)), { recursive: true }); await writeFile(join(repo, path), content); }
  await git(repo, 'add', '--', '.'); await git(repo, 'commit', '-qm', 'first commit', '--');
  return realpath(repo);
}
// Whether this pid is the built ai's daemon running in this world (its env names the world's AI Term folder).
async function isWorldDaemon(world: World, pid: number): Promise<boolean> {
  try {
    const { stdout } = await run('/bin/ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], { env: { PATH: '/usr/bin:/bin' } });
    return stdout.includes(`${ENTRY} daemon`) && stdout.includes(`AI_TERM_HOME=${world.aiHome}`);
  } catch { return false; }
}
// Stops the throwaway daemon (and with it every agent it runs), then removes the world.
export async function endWorld(world: World): Promise<string[]> {
  const notes: string[] = [];
  const stop = await aiCommand(world, ['daemon', 'stop'], world.root, 30_000).catch((error: unknown) => ({ code: -1, stdout: '', stderr: String(error) }));
  if (stop.code !== 0) notes.push(`ai daemon stop exited ${stop.code}`);
  // A daemon that didn't answer is stopped by its pid file, and only if that pid is still this world's daemon (review: a
  // stale pid could name someone else's process by now): TERM, then KILL.
  let pidText = '';
  try { pidText = await readFile(getPaths(world.aiHome).pid, 'utf8'); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) notes.push(`the daemon's pid file couldn't be read (${error instanceof Error ? error.message : 'unknown error'})`); }
  const pid = Number(pidText.trim());
  if (Number.isInteger(pid) && pid > 1 && await isWorldDaemon(world, pid)) {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      try { process.kill(pid, signal); } catch { break; }
      for (let i = 0; i < 30 && await isWorldDaemon(world, pid); i++) await sleep(100);
      if (!await isWorldDaemon(world, pid)) break;
    }
    if (await isWorldDaemon(world, pid)) notes.push(`the daemon (pid ${pid}) is still running`);
  }
  await removeTree(world.root).catch((error: unknown) => { notes.push(`the temp folder ${world.root} could not be removed (${error instanceof Error ? error.message : 'unknown error'})`); });
  return notes;
}
