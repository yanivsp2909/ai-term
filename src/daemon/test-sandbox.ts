import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { MAX_BLOCKED_WHAT } from '../shared/test-run.js';

// B26 (D56): code an agent wrote never runs outside a sandbox without asking. On macOS auto-test runs the whole test
// process tree under sandbox-exec (Seatbelt; a sandbox is inherited by every child and can't be dropped). The profile is
// deny-by-default and built only from validated absolute paths: writes only in the agent's worktree and a per-run temp
// folder, no network (127.0.0.1 only when the project allows it), no signals or process info outside the run, and no
// reads of the credential folders below. Without a working sandbox the caller never runs tests by itself.
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export class SandboxPathError extends Error {}
// Under your home folder. Read-data is denied (contents and listings); names and sizes stay visible, because path
// resolution (realpath, getcwd) needs them and would otherwise fail inside the worktree, which lives in ~/.ai-term.
export const SECRET_PATHS: readonly string[] = ['.ssh', '.aws', '.gnupg', '.netrc', '.npmrc', '.docker', '.kube', '.config/gh', 'Library/Keychains', '.ai-term', '.claude', '.claude.json', '.codex',
  '.git-credentials', '.config/git/credentials', '.config/gcloud', '.azure', '.pypirc', '.gem/credentials', '.cargo/credentials', '.cargo/credentials.toml', '.terraform.d'];
export interface SandboxSpec { worktree: string; temp: string; home: string; private: readonly string[]; loopback: boolean }
export interface PreparedSandbox { profile: string; spec: SandboxSpec; env: { TMPDIR: string; TMP: string; TEMP: string; XDG_CACHE_HOME: string; npm_config_cache: string; GOCACHE: string }; program: string; dispose(): Promise<void> }

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
    `(deny file-read-data file-read-xattr ${secrets.map(path => `(subpath ${path})`).join(' ')})`,
    // The agent's own worktree is inside ~/.ai-term: readable again (only it, not the other agents' worktrees).
    `(allow file-read-data file-read-xattr (subpath ${worktree}))`,
    // xcrun (behind make, cc, git on some setups) caches into the user temp folder whatever TMPDIR says.
    `(allow file-write* (subpath ${worktree}) (subpath ${temp}) (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/") (regex #"^/private/var/folders/[^/]+/[^/]+/T/xcrun_db"))`,
    // Unix sockets only inside this run's own temp folder (test runners talk to their workers): nothing outside listens there.
    `(allow network-bind network-inbound network-outbound (local unix-socket (subpath ${temp})) (remote unix-socket (subpath ${temp})))`,
    ...spec.loopback ? ['(allow network-bind network-inbound (local ip "localhost:*"))', '(allow network-outbound (remote ip "localhost:*"))'] : [],
    '',
  ].join('\n');
}

// What the sandbox stopped, read from the run's output (the kernel's own record isn't readable without reading every
// app's log): a path the profile denies, or network. A refusal inside the run's own folders is the test's business.
const NETWORK = /\b(?:connect|listen|bind) EPERM\b|Could not resolve host|getaddrinfo (?:ENOTFOUND|EAI_AGAIN)|\bsocket\b.*Operation not permitted|\.(?:connect|bind|listen)\(.*\n.*Operation not permitted/i;
const PATHS: readonly RegExp[] = [/EPERM: operation not permitted, \w+ '([^']+)'/, /Errno 1\] Operation not permitted: '([^']+)'/, /(?:^|: )((?:\/|\.\.?\/)[^:\n]*): Operation not permitted/m];
// eslint-disable-next-line no-control-regex -- control characters never reach the card.
const shown = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?');
const real = (path: string) => path.startsWith('/var/') || path.startsWith('/tmp/') || path.startsWith('/etc/') ? `/private${path}` : path;
const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
export function sandboxDenial(output: string, spec: Pick<SandboxSpec, 'worktree' | 'temp' | 'home' | 'private'>): string | null {
  const own = [spec.worktree, spec.temp].map(real), secrets = [...SECRET_PATHS.map(name => join(spec.home, name)), ...spec.private].map(real);
  const found: { at: number; what: string }[] = [];
  for (const pattern of PATHS) for (const match of output.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))) {
    const raw = match[1]; if (!raw) continue;
    const path = resolve(spec.worktree, raw), canonical = real(path);
    if (own.some(root => within(canonical, root))) continue;
    // Reads are allowed everywhere else, so a refusal outside the key folders was a write; inside them it could be either.
    const home = real(spec.home), named = shown(within(canonical, home) ? `~${canonical.slice(home.length)}` : path);
    found.push({ at: match.index, what: secrets.some(root => within(canonical, root)) ? named : `write ${named}` });
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
export async function sandboxReady(profile: string, exec = SANDBOX_EXEC): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try { await access(exec, constants.X_OK); } catch { return false; }
  return new Promise(done => { execFile(exec, ['-p', profile, '--', '/usr/bin/true'], { timeout: 10_000, env: { PATH: '/usr/bin:/bin' } }, error => done(!error)); });
}
// A fresh 0700 temp folder for the run (TMPDIR, caches), the profile, and its removal afterwards. Throws SandboxPathError
// when a path can't go into a profile; the caller then treats the run as having no sandbox.
export async function prepareSandbox(worktree: string, options: { home: string; private: readonly string[]; loopback: boolean; program?: string }): Promise<PreparedSandbox> {
  const temp = await mkdtemp(join(await realpath(tmpdir()), 'ai-term-test-'));
  try {
    const realHome = await realpath(options.home).catch(() => options.home);
    // The sandbox matches real paths: a key folder that is a link elsewhere is denied at its target too.
    const targets = await Promise.all([...options.private, ...SECRET_PATHS.map(name => join(options.home, name))].map(path => realpath(path).catch(() => path)));
    const spec: SandboxSpec = { worktree: await realpath(worktree), temp, home: realHome, private: [...new Set([...options.private, ...targets])].filter(path => !SECRET_PATHS.some(name => join(realHome, name) === path)), loopback: options.loopback };
    const profile = sandboxProfile(spec);
    return { profile, spec, program: options.program ?? SANDBOX_EXEC, env: { TMPDIR: temp, TMP: temp, TEMP: temp, XDG_CACHE_HOME: join(temp, 'cache'), npm_config_cache: join(temp, 'npm-cache'), GOCACHE: join(temp, 'go-build') }, dispose: () => rm(temp, { recursive: true, force: true }) };
  } catch (error) { await rm(temp, { recursive: true, force: true }); throw error; }
}
