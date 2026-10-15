import { constants, type Stats } from 'node:fs';
import { access, lstat, mkdir, readdir, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { isFsError } from '../shared/paths.js';
import { SandboxPathError } from './sandbox-error.js';
import { PERSISTENCE_DIRS, PERSISTENCE_FILES } from './sandbox-places.js';

// v0.8.1 Linux sandboxes through bubblewrap (bwrap): an unprivileged tool that builds a fresh mount, PID and network
// view for one command from argv alone (no profile language, so a path is just an argv element; still, only absolute,
// normalized paths without control characters go in). D56's test sandbox and D57 + B29's agent bash sandbox, Linux side.
// Only these fixed places: a bwrap found through PATH could be anyone's program.
export const BWRAP_PATHS: readonly string[] = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap'];
export async function findBwrap(candidates: readonly string[] = BWRAP_PATHS): Promise<string | null> {
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return path; }
    catch (error) { if (!isFsError(error, 'ENOENT') && !isFsError(error, 'EACCES') && !isFsError(error, 'ENOTDIR')) throw error; }
  }
  return null;
}
// eslint-disable-next-line no-control-regex -- refusing controls is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
export function bwrapPath(path: string): string {
  if (!path || !isAbsolute(path) || normalize(path) !== path || path.includes('//') || CONTROL.test(path) || path.length > 4096) throw new SandboxPathError("This folder can't be sandboxed (control characters, or not a plain absolute path)");
  return path;
}

// Test runs (D56): the whole system read-only, then hidden: home, /tmp, /run and the like become empty tmpfs (gone when
// the run ends); the toolchains and the repository's git folder come back read-only; key folders inside them are hidden
// again; last, the worktree and the run's temp folder are the only real places it can write. --unshare-all gives it its
// own network (only its own 127.0.0.1, never your machine's services or the internet), PIDs, IPC and user namespace;
// --new-session keeps it from typing into a terminal; --die-with-parent ends it with its run.
export interface BwrapTestSpec { worktree: string; temp: string; hidden: readonly string[]; readable: readonly string[]; secrets: readonly { path: string; dir: boolean }[] }
export function bwrapTestArgs(spec: BwrapTestSpec): string[] {
  const p = bwrapPath, worktree = p(spec.worktree), temp = p(spec.temp);
  return ['--die-with-parent', '--new-session', '--unshare-all', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
    ...spec.hidden.flatMap(path => ['--tmpfs', p(path)]),
    ...spec.readable.flatMap(path => ['--ro-bind', p(path), p(path)]),
    ...spec.secrets.flatMap(({ path, dir }) => dir ? ['--tmpfs', p(path)] : ['--ro-bind', '/dev/null', p(path)]),
    '--bind', worktree, worktree, '--bind', temp, temp, '--chdir', worktree];
}

// Agent bash (D57 + B29): it may do what you could, with the network, except:
// - see other processes: its own PID namespace and /proc (no attaching to the agent or the daemon, whose memory holds the key);
// - read or write AI Term's folder (its own worktree excepted) or reach its sockets: a tmpfs over it;
// - reach your session's runtime folder (/run/user/<uid>): the D-Bus session bus there answers Secret Service requests,
//   which would hand out every saved key;
// - write a persistence spot. bwrap can't refuse creating a file, so home (and the folders holding protected places,
//   like ~/.config) is rebuilt: a tmpfs with each entry bound back, the protected ones read-only. A protected place that
//   doesn't exist yet can then be "created" only in that tmpfs, which vanishes with the command; so does anything new
//   at those levels.
export interface ShadowEntry { path: string; kind: 'dir' | 'file' | 'link' | 'shadowed'; target?: string; readOnly: boolean }
// pinned: each folder between a rebuilt one (or /) and a read-only place, bound onto itself so it is a mount point and
// can't be renamed: renaming ~/work/proj and copying it back would otherwise leave a writable .git/hooks at the old path
// (security review); macOS denies by path, which renames can't dodge.
export interface BwrapBashSpec { aiTermHome: string; cwd: string; runtime: string | readonly string[] | null; shadows: readonly { dir: string; entries: readonly ShadowEntry[] }[]; readOnly: readonly string[]; pinned?: readonly string[] }
export function bwrapBashArgs(spec: BwrapBashSpec): string[] {
  const p = bwrapPath, home = p(spec.aiTermHome), cwd = p(spec.cwd);
  const entry = (e: ShadowEntry): string[] => e.kind === 'shadowed' ? [] : e.kind === 'link' ? ['--symlink', e.target ?? '', p(e.path)] : [e.readOnly ? '--ro-bind' : '--bind', p(e.path), p(e.path)];
  return ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try', '--unshare-user-try',
    '--bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
    ...spec.shadows.flatMap(shadow => ['--tmpfs', p(shadow.dir), ...shadow.entries.flatMap(entry)]),
    ...(typeof spec.runtime === 'string' ? [spec.runtime] : spec.runtime ?? []).flatMap(path => ['--tmpfs', p(path)]),
    '--tmpfs', home, ...cwd.startsWith(`${home}/`) ? ['--bind', cwd, cwd] : [],
    ...(spec.pinned ?? []).flatMap(path => ['--bind', p(path), p(path)]),
    ...spec.readOnly.flatMap(path => ['--ro-bind', p(path), p(path)]),
    '--chdir', cwd];
}

// A rebuilt folder holds at most this many entries: past it the command is refused rather than run with a home half put
// back (or an argv too long to start).
export const MAX_SHADOW_ENTRIES = 2000;
export class ShadowError extends Error {}
const missing = <T>(fallback: T) => (error: unknown): T => { if (isFsError(error, 'ENOENT') || isFsError(error, 'ENOTDIR')) return fallback; throw error; };
// What the bash sandbox needs, read from disk: the folders to rebuild (home, and each real folder between home and a
// protected place), their entries, and the read-only places (protected ones that exist, their link targets, the
// repository's hooks and config). Nothing else is created on disk.
// lstat: a test's stand-in. An entry that can't be looked at (a dead network mount: ENOTCONN, EIO) is left out of the
// rebuilt folder rather than refusing every command (TS review); left out, it is simply not there inside.
export async function bashSandboxPlan(options: { user: string; aiTermHome: string; cwd: string; protect: readonly string[]; runtime: string | readonly string[] | null; lstat?: (path: string) => Promise<Stats> }): Promise<BwrapBashSpec> {
  const look = options.lstat ?? ((path: string) => lstat(path));
  const user = await realpath(options.user).catch(missing(options.user));
  const aiTermHome = await realpath(options.aiTermHome).catch(missing(options.aiTermHome)), cwd = await realpath(options.cwd);
  const files = PERSISTENCE_FILES.map(name => join(user, name)), dirs = PERSISTENCE_DIRS.map(name => join(user, name)), places = new Set([...files, ...dirs]);
  // Each existing folder between home and a protected place, by its real path (a ~/.config that is a link is rebuilt
  // where it leads, so the protected places under it are covered whichever way they are reached).
  // real folder → the home path it stands for, so its entries are matched against the protected places by that path.
  const shadowDirs = new Map([[user, user]]);
  for (const place of places) {
    for (let parent = dirname(place); parent !== user && parent.startsWith(`${user}/`); parent = dirname(parent)) {
      const real = await realpath(parent).catch(missing(null));
      if (real && real !== user && (await lstat(real)).isDirectory() && !shadowDirs.has(real)) shadowDirs.set(real, parent);
    }
  }
  const readOnly = new Set<string>();
  for (const place of places) {
    const info = await lstat(place).catch(missing(null)); if (!info) continue;
    // A link's target is protected too (dotfiles kept in a repository); a dangling one isn't recreated at all below.
    if (info.isSymbolicLink()) { const target = await realpath(place).catch(missing(null)); if (target) readOnly.add(target); }
  }
  const shadows: { dir: string; entries: ShadowEntry[] }[] = [];
  for (const [dir, logical] of [...shadowDirs].sort(([a], [b]) => a.split('/').length - b.split('/').length)) {
    const names = await readdir(dir);
    if (names.length > MAX_SHADOW_ENTRIES) throw new ShadowError(`bash can't run here: a folder AI Term rebuilds for the sandbox has more than ${MAX_SHADOW_ENTRIES} entries`);
    const entries: ShadowEntry[] = [];
    for (const name of names) {
      const path = join(dir, name);
      if (path === aiTermHome) continue;
      let info: Stats;
      try { info = await look(path); } catch { continue; }
      const isPlace = places.has(join(logical, name));
      if (shadowDirs.has(path)) { entries.push({ path, kind: 'shadowed', readOnly: false }); continue; }
      if (info.isSymbolicLink()) {
        const target = await readlink(path), dangling = (await realpath(path).catch(missing(null))) === null;
        if (isPlace && dangling) continue;
        entries.push({ path, kind: 'link', target, readOnly: isPlace }); continue;
      }
      entries.push({ path, kind: info.isDirectory() ? 'dir' : 'file', readOnly: isPlace });
    }
    shadows.push({ dir, entries });
  }
  // A repository without a hooks folder gets an empty one (as git init makes), so there is something to make read-only:
  // otherwise the agent could create it and plant a hook (security review). The one thing this plan writes.
  for (const dir of options.protect) await mkdir(join(dir, 'hooks'), { mode: 0o755 }).catch((error: unknown) => { if (!isFsError(error, 'EEXIST')) throw error; });
  for (const dir of options.protect) for (const name of ['hooks', 'config']) {
    const path = await realpath(join(dir, name)).catch(missing(null)); if (path) readOnly.add(path);
  }
  // Ancestors to pin: below the deepest rebuilt folder holding the place (its entries are mount points already), or
  // below / when none holds it; a folder that holds a rebuilt one or AI Term's folder is left alone (pinning it would
  // cover them).
  const rebuilt = [...shadowDirs.keys()], inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
  const pinned = new Set<string>();
  for (const place of readOnly) {
    const top = rebuilt.filter(dir => inside(place, dir) && dir !== place).sort((a, b) => b.length - a.length)[0];
    const below = top ? place.slice(top.length + 1).split('/') : place.split('/').filter(Boolean);
    for (let depth = top ? 2 : 1; depth < below.length; depth++) {
      const folder = top ? join(top, ...below.slice(0, depth)) : `/${below.slice(0, depth).join('/')}`;
      if (rebuilt.some(dir => dir !== folder && inside(dir, folder)) || inside(aiTermHome, folder)) continue;
      pinned.add(folder);
    }
  }
  return { aiTermHome, cwd, runtime: options.runtime, shadows, readOnly: [...readOnly], pinned: [...pinned].sort((a, b) => a.split('/').length - b.split('/').length) };
}
// The session's runtime folders (D-Bus, the keyring's control socket, ssh-agent): XDG_RUNTIME_DIR from AI Term's own
// environment (the bash env never has it) and the usual /run/user/<uid>, each by its real path, when they exist.
export async function runtimeDirs(env: Readonly<Record<string, string | undefined>>, uid: number | undefined = process.getuid?.()): Promise<string[]> {
  const given = env.XDG_RUNTIME_DIR, found = new Set<string>();
  for (const path of [...given && isAbsolute(given) ? [normalize(given)] : [], ...uid !== undefined ? [`/run/user/${uid}`] : []]) {
    const real = await realpath(path).catch(missing(null));
    if (real && (await lstat(real)).isDirectory()) found.add(resolve(real));
  }
  return [...found];
}
