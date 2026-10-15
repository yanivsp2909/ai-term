import { execFile } from 'node:child_process';
import { constants, type Stats } from 'node:fs';
import { access, lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { isFsError } from '../shared/paths.js';
import { bwrapPath, bwrapTestArgs, findBwrap } from './bwrap.js';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { MAX_BLOCKED_WHAT } from '../shared/test-run.js';

// B26 (D56): code an agent wrote never runs outside a sandbox without asking. On macOS auto-test runs the whole test
// process tree under sandbox-exec (Seatbelt; a sandbox is inherited by every child and can't be dropped). The profile is
// deny-by-default and built only from validated absolute paths: writes only in the agent's worktree and a per-run temp
// folder, no network (127.0.0.1 only when the project allows it), no signals or process info outside the run, and no
// reads of the credential folders below. Without a working sandbox the caller never runs tests by itself.
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export { SandboxPathError } from './sandbox-error.js';
export { PERSISTENCE_DIRS, PERSISTENCE_FILES } from './sandbox-places.js';
import { SandboxPathError } from './sandbox-error.js';
// Under your home folder. Read-data is denied (contents and listings); names and sizes stay visible, because path
// resolution (realpath, getcwd) needs them and would otherwise fail inside the worktree, which lives in ~/.ai-term.
export const SECRET_PATHS: readonly string[] = ['.ssh', '.aws', '.gnupg', '.netrc', '.npmrc', '.docker', '.kube', '.config/gh', 'Library/Keychains', '.ai-term', '.claude', '.claude.json', '.codex',
  '.git-credentials', '.config/git/credentials', '.config/gcloud', '.azure', '.pypirc', '.gem/credentials', '.cargo/credentials', '.cargo/credentials.toml', '.terraform.d',
  // Credential files inside toolchain folders that stay readable (Part A review).
  '.m2/settings.xml', '.m2/settings-security.xml', '.gradle/gradle.properties', '.gradle/init.d', '.config/mise/config.toml', '.bunfig.toml', '.pub-cache/credentials.json'];
// hidden: folders whose contents tests can't read (your home, /Volumes, /tmp, the user temp area); readable: what inside
// them stays open (the toolchains tests run, the repository's git folder). Key folders and private stay closed either way.
export interface SandboxSpec { worktree: string; temp: string; home: string; private: readonly string[]; loopback: boolean; hidden?: readonly string[]; readable?: readonly string[] }
// Toolchains under your home a test command may need to read (version managers, language homes, git's own config). The
// key folders stay unreadable inside them (.cargo/credentials, .gem/credentials, .config/git/credentials).
const TOOLCHAINS = ['.nvm', '.volta', '.fnm', '.local/share/fnm', '.pyenv', '.rbenv', '.rustup', '.cargo', 'go', '.gradle', '.m2', '.bun', '.deno', '.local/share/pnpm', 'Library/pnpm',
  '.asdf', '.local/share/mise', '.config/mise', '.local/bin', '.local/lib', '.sdkman', '.conda', 'miniconda3', 'anaconda3', 'miniforge3', '.jenv', '.gem', '.swiftpm', 'Library/Python',
  '.node-gyp', 'Library/Caches/node-gyp', 'Library/Caches/ms-playwright', 'Library/Caches/Cypress', '.cache/ms-playwright', '.pub-cache', '.gitconfig', '.config/git', '.gitignore_global'];
const TOOLCHAIN_VARS = ['JAVA_HOME', 'GOPATH', 'GOROOT', 'GOMODCACHE', 'CARGO_HOME', 'RUSTUP_HOME', 'NVM_DIR', 'VOLTA_HOME', 'PNPM_HOME', 'BUN_INSTALL', 'DENO_DIR', 'PYENV_ROOT', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'POETRY_HOME', 'PIPX_HOME', 'GEM_HOME', 'RBENV_ROOT', 'ANDROID_HOME', 'ANDROID_SDK_ROOT'];
// The folders under home to keep readable for these tests: the list above, the env's toolchain homes, and each PATH entry
// under home (a `bin` folder with its parent, where its libraries live, unless that parent sits right under home: ~/bin or
// ~/Documents/bin open only themselves). Never home itself or anything above it.
export function toolchainPaths(home: string, env: Readonly<Record<string, string | undefined>>): string[] {
  const under = (path: string) => isAbsolute(path) && normalize(path) === path && path.startsWith(`${home}/`);
  const found = [...TOOLCHAINS.map(name => join(home, name)), ...TOOLCHAIN_VARS.map(name => env[name] ?? ''), ...(env.GEM_PATH ?? '').split(':')];
  for (const entry of (env.PATH ?? '').split(':')) {
    const path = entry.replace(/\/+$/, '');
    if (!under(path)) continue;
    const parent = path.endsWith('/bin') ? path.slice(0, -'/bin'.length) : '';
    found.push(parent && under(parent) && parent.slice(home.length + 1).includes('/') ? parent : path);
  }
  return [...new Set(found.filter(under))];
}
// prefix: the argv that goes before the test command (sandbox-exec -p <profile> --, or bwrap <args> --).
export interface PreparedSandbox { profile: string; spec: SandboxSpec; env: { TMPDIR: string; TMP: string; TEMP: string; XDG_CACHE_HOME: string; npm_config_cache: string; GOCACHE: string }; program: string; prefix: readonly string[]; dispose(): Promise<void> }

// A profile string is SBPL (a Scheme dialect): a quote, backslash or parenthesis inside a path could end the string and
// add rules, so any path holding one (or a control character) is refused rather than escaped.
// eslint-disable-next-line no-control-regex -- refusing controls is the point.
const UNSAFE = /["'()\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
export function sandboxPath(path: string): string {
  if (!path || !isAbsolute(path) || UNSAFE.test(path) || normalize(path) !== path || path.includes('//') || path.length > 1024) throw new SandboxPathError('This folder can\'t be sandboxed (quotes, parentheses or control characters in its path)');
  return path;
}
const q = (path: string) => `"${sandboxPath(path)}"`;
export function sandboxProfile(spec: SandboxSpec): string {
  const worktree = q(spec.worktree), temp = q(spec.temp), home = sandboxPath(spec.home);
  const secrets = [...SECRET_PATHS.map(name => q(join(home, name))), ...spec.private.map(q)];
  return [
    '(version 1)', '(deny default)', '(import "system.sb")',
    '(allow process-fork)', '(allow process-exec*)',
    '(allow signal (target same-sandbox))', '(allow process-info* (target same-sandbox))',
    '(allow sysctl-read)', '(allow file-ioctl)', '(allow ipc-posix-shm)', '(allow ipc-posix-sem)',
    '(allow mach-lookup (global-name "com.apple.system.notification_center") (global-name "com.apple.system.logger"))',
    '(allow file-read*)',
    // Rules apply last-match-wins: hide, open the toolchains, close the key folders again, open this run's own folders.
    ...spec.hidden?.length ? [`(deny file-read-data file-read-xattr ${spec.hidden.map(path => `(subpath ${q(path)})`).join(' ')})`] : [],
    ...spec.readable?.length ? [`(allow file-read-data file-read-xattr ${spec.readable.map(path => `(subpath ${q(path)})`).join(' ')})`] : [],
    `(deny file-read-data file-read-xattr ${secrets.map(path => `(subpath ${path})`).join(' ')})`,
    // The agent's own worktree is inside ~/.ai-term: readable again (only it, not the other agents' worktrees).
    `(allow file-read-data file-read-xattr (subpath ${worktree}) (subpath ${temp}))`,
    // Not xcrun's cache in the user temp folder (gate): tools outside the sandbox trust it, so a test could point them at its
    // own program. xcrun works without it (it notes the cache it couldn't write).
    `(allow file-write* (subpath ${worktree}) (subpath ${temp}) (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))`,
    // Unix sockets only inside this run's own temp folder (test runners talk to their workers): nothing outside listens there.
    `(allow network-bind network-inbound network-outbound (local unix-socket (subpath ${temp})) (remote unix-socket (subpath ${temp})))`,
    ...spec.loopback ? ['(allow network-bind network-inbound (local ip "localhost:*"))', '(allow network-outbound (remote ip "localhost:*"))'] : [],
    '',
  ].join('\n');
}

// What the sandbox stopped, read from the run's output (the kernel's own record isn't readable without reading every
// app's log): a path the profile denies, or network. A refusal inside the run's own folders is the test's business.
const NETWORK = /\b(?:connect|listen|bind) (?:EPERM|ENETUNREACH)\b|Network is unreachable|Could not resolve host|getaddrinfo (?:ENOTFOUND|EAI_AGAIN)|\bsocket\b.*Operation not permitted|\.(?:connect|bind|listen)\(.*\n.*Operation not permitted/i;
// Linux (bubblewrap): a write outside the run's folders is a read-only file system.
const PATHS: readonly RegExp[] = [/EPERM: operation not permitted, \w+ '([^']+)'/, /EROFS: read-only file system, \w+ '([^']+)'/, /cannot \w+ '([^']+)': Read-only file system/, /(?:^|: )((?:\/|\.\.?\/)[^:\n]*): Read-only file system/m, /Errno 1\] Operation not permitted: '([^']+)'/, /(?:^|: )((?:\/|\.\.?\/)[^:\n]*): Operation not permitted/m];
// eslint-disable-next-line no-control-regex -- control characters never reach the card.
const shown = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?');
const real = (path: string) => path.startsWith('/var/') || path.startsWith('/tmp/') || path.startsWith('/etc/') ? `/private${path}` : path;
const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
export function sandboxDenial(output: string, spec: Pick<SandboxSpec, 'worktree' | 'temp' | 'home'>): string | null {
  const own = [spec.worktree, spec.temp].map(real);
  const found: { at: number; what: string }[] = [];
  for (const pattern of PATHS) for (const match of output.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))) {
    const raw = match[1]; if (!raw) continue;
    const path = resolve(spec.worktree, raw), canonical = real(path);
    if (own.some(root => within(canonical, root))) continue;
    // The path alone: a refusal there may be a read or a write, and the output doesn't always say which.
    const home = real(spec.home);
    found.push({ at: match.index, what: shown(within(canonical, home) ? `~${canonical.slice(home.length)}` : path) });
  }
  const network = output.match(NETWORK);
  if (network?.index !== undefined) found.push({ at: network.index, what: 'network' });
  found.sort((a, b) => a.at - b.at);
  // Long paths keep their end (the file's name).
  const first = found[0]?.what, chars = first ? [...first] : [];
  return first ? chars.length <= MAX_BLOCKED_WHAT ? first : `…${chars.slice(chars.length - MAX_BLOCKED_WHAT + 1).join('')}` : null;
}

// Whether this Mac can sandbox the run: macOS, sandbox-exec present, and the profile itself accepted (a probe runs
// /usr/bin/true under it; a profile the system rejects fails here, before any test code runs).
// prefix (Linux): the whole bwrap argv, probed with `/bin/sh -c :` in place of the tests (NixOS has no /bin/true).
export async function sandboxReady(profile: string, exec = SANDBOX_EXEC, prefix?: readonly string[]): Promise<boolean> {
  if (process.platform === 'linux' && prefix?.length) {
    const [program, ...args] = prefix;
    try { await access(program ?? '', constants.X_OK); } catch { return false; }
    return new Promise(done => { execFile(program ?? '', [...args, '/bin/sh', '-c', ':'], { timeout: 10_000, env: { PATH: '/usr/bin:/bin' } }, error => done(!error)); });
  }
  if (process.platform !== 'darwin') return false;
  try { await access(exec, constants.X_OK); } catch { return false; }
  return new Promise(done => { execFile(exec, ['-p', profile, '--', '/usr/bin/true'], { timeout: 10_000, env: { PATH: '/usr/bin:/bin' } }, error => done(!error)); });
}
// A fresh 0700 temp folder for the run (TMPDIR, caches), the profile, and its removal afterwards. Throws SandboxPathError
// when a path can't go into a profile; the caller then treats the run as having no sandbox.
// env: the test's env, for the toolchains on its PATH; readable: more folders to keep open (the repository's git folder).
export async function prepareSandbox(worktree: string, options: { home: string; private: readonly string[]; loopback: boolean; program?: string; env?: Readonly<Record<string, string | undefined>>; readable?: readonly string[]; log?: (text: string) => void; platform?: NodeJS.Platform }): Promise<PreparedSandbox> {
  const temp = await mkdtemp(join(await realpath(tmpdir()), 'ai-term-test-'));
  if ((options.platform ?? process.platform) === 'linux') return prepareLinux(worktree, temp, options);
  try {
    const realHome = await realpath(options.home).catch(() => options.home);
    // The sandbox matches real paths: a key folder that is a link elsewhere is denied at its target too.
    const targets = await Promise.all([...options.private, ...SECRET_PATHS.map(name => join(options.home, name))].map(path => realpath(path).catch(() => path)));
    // Hidden: home, external volumes, /tmp and this user's temp area (other apps' files); the run's temp folder reopens.
    const userTemp = dirname(temp).match(/^\/private\/var\/folders\/[^/]+\/[^/]+(?=\/)/)?.[0];
    // Paths a profile can't hold (quotes and the like) are left closed rather than refusing the whole sandbox.
    let dropped = false;
    const usable = (paths: readonly string[]) => paths.filter(path => { try { sandboxPath(path); return true; } catch { dropped = true; return false; } });
    const readable = usable([...new Set((await Promise.all([...toolchainPaths(options.home, options.env ?? {}), ...toolchainPaths(realHome, options.env ?? {}), ...options.readable ?? []]
      .map(async path => [path, await realpath(path).catch(() => path)]))).flat())]);
    const spec: SandboxSpec = { worktree: await realpath(worktree), temp, home: realHome, private: [...new Set([...options.private, ...targets])].filter(path => !SECRET_PATHS.some(name => join(realHome, name) === path)), loopback: options.loopback,
      hidden: [...new Set([realHome, '/Volumes', '/private/tmp', '/private/var/tmp', ...userTemp ? [userTemp] : []])], readable };
    // Fixed words: the path itself may be anything.
    if (dropped) options.log?.('Test sandbox: a folder with quotes, parentheses or control characters in its path stays closed to tests');
    const profile = sandboxProfile(spec), program = options.program ?? SANDBOX_EXEC;
    return { profile, spec, program, prefix: [program, '-p', profile, '--'], env: { TMPDIR: temp, TMP: temp, TEMP: temp, XDG_CACHE_HOME: join(temp, 'cache'), npm_config_cache: join(temp, 'npm-cache'), GOCACHE: join(temp, 'go-build') }, dispose: () => rm(temp, { recursive: true, force: true }) };
  } catch (error) { await rm(temp, { recursive: true, force: true }); throw error; }
}

// Linux (v0.8.1): the same rules through bubblewrap (bwrap.ts bwrapTestArgs). What exists decides the argv: bwrap can
// only hide or reopen a path that is there. Hidden: home, other homes, /tmp, /var/tmp, /run (the D-Bus and Docker
// sockets live there; a socket isn't stopped by a network namespace), /media and /mnt. A hidden file reads as missing,
// so only writes (a read-only file system) and network show as blocked. 127.0.0.1 is always the run's own: your
// machine's services stay closed whatever the project allows.
const missingPath = (error: unknown): null => { if (isFsError(error, 'ENOENT') || isFsError(error, 'ENOTDIR') || isFsError(error, 'EACCES')) return null; throw error; };
async function prepareLinux(worktree: string, temp: string, options: { home: string; private: readonly string[]; loopback: boolean; program?: string; env?: Readonly<Record<string, string | undefined>>; readable?: readonly string[]; log?: (text: string) => void }): Promise<PreparedSandbox> {
  try {
    const program = options.program ?? await findBwrap();
    if (!program) throw new SandboxPathError("bubblewrap (bwrap) isn't installed");
    const realHome = await realpath(options.home).catch(() => options.home);
    const real = async (path: string) => { const resolved = await realpath(path).catch(missingPath); return resolved ? { path: resolved, info: await lstat(resolved) } : null; };
    const existing = async (paths: readonly string[]) => (await Promise.all(paths.map(real))).filter((found): found is { path: string; info: Stats } => found !== null);
    const hidden = (await existing([realHome, '/home', '/root', '/tmp', '/var/tmp', '/run', '/media', '/mnt'])).filter(found => found.info.isDirectory()).map(found => found.path);
    let dropped = false;
    const usable = (paths: readonly string[]) => paths.filter(path => { try { bwrapPath(path); return true; } catch { dropped = true; return false; } });
    // PATH folders under a hidden root that isn't your home (Linuxbrew's /home/linuxbrew, NixOS's /run/current-system)
    // come back read-only too (gate), with their parent when they are a bin folder.
    const elsewhere = (options.env?.PATH ?? '').split(':').filter(entry => isAbsolute(entry) && normalize(entry) === entry && !entry.startsWith(`${realHome}/`) && ['/home/', '/run/', '/root/'].some(root => entry.startsWith(root))).map(entry => entry.endsWith('/bin') ? dirname(entry) : entry);
    const readable = usable([...new Set((await existing([...toolchainPaths(options.home, options.env ?? {}), ...toolchainPaths(realHome, options.env ?? {}), ...elsewhere, ...options.readable ?? []])).map(found => found.path))]);
    const secrets = await existing([...SECRET_PATHS.map(name => join(options.home, name)), ...options.private]);
    if (dropped) options.log?.('Test sandbox: a folder with control characters in its path stays closed to tests');
    const tree = await realpath(worktree);
    const args = bwrapTestArgs({ worktree: tree, temp, hidden: [...new Set([...hidden].sort((a, b) => a.length - b.length))], readable, secrets: [...new Map(secrets.map(found => [found.path, { path: found.path, dir: found.info.isDirectory() }])).values()] });
    const spec: SandboxSpec = { worktree: tree, temp, home: realHome, private: options.private, loopback: false, hidden, readable };
    return { profile: '', spec, program, prefix: [program, ...args, '--'], env: { TMPDIR: temp, TMP: temp, TEMP: temp, XDG_CACHE_HOME: join(temp, 'cache'), npm_config_cache: join(temp, 'npm-cache'), GOCACHE: join(temp, 'go-build') }, dispose: () => rm(temp, { recursive: true, force: true }) };
  } catch (error) { await rm(temp, { recursive: true, force: true }); throw error; }
}
