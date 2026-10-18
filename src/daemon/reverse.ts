import { access, open, realpath, stat, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { findServer } from '../agent/lsp.js';
import { sandboxedArgv } from '../agent/bash.js';
import { ToolError } from '../agent/tools.js';
import { addonFile } from '../agent/addon-bundle.js';
import { SANDBOX_EXEC, SECRET_PATHS, sandboxPath, SandboxPathError } from './test-sandbox.js';
import { SECRET_FILE } from '../shared/review.js';
import { isFsError, privateDirectory } from '../shared/paths.js';
import { buildBashEnv } from './env.js';
import { AddonError } from './addon-error.js';

// v1.0.7 /reverse <target>: one agent gets the REA reverse-engineering MCP server (github.com/morluto/rea, MIT) for that
// agent only. REA is yours to install; AI Term only finds it (PATH, or the path /reverse path set) and never installs,
// updates or registers it anywhere. Its server runs as `rea mcp` (stdio, per REA's README and server.json) under the agent
// sandbox (D57) with the tighter rules below.
export class ReverseError extends AddonError {}
export const REA_MISSING = "REA isn't installed · install it yourself with npm install --global rea-agents, or point to it with /reverse path <path>";
export const REA_BAD_PATH = "The REA path you set isn't an executable file · /reverse path <path> sets it again";
export const REVERSE_NO_SANDBOX = "/reverse runs REA only inside macOS's sandbox, and this system has none AI Term can use for it";
const USAGE = '/reverse <target> · an app, binary or folder that is yours or that you may analyze', NO_TARGET = 'No such target · check the path (quotes are optional)';
const SECRET_TARGET = 'A credential or env file cannot be a target', OWN_TARGET = "AI Term's own folder can't be a target", KEY_TARGET = "A key folder can't be a target";
const ODD_TARGET = "This target's path has quotes, parentheses or control characters, which the sandbox can't name";
const NO_PROFILE = "REA's sandbox couldn't be set up for this folder; nothing started", CHANGED_PROFILE = "REA's sandbox profile file changed; nothing started";
// Every refusal is one of these fixed lines, so the daemon passes it to the popup (never a path or a system message).
export const REVERSE_ERRORS: readonly string[] = [REA_MISSING, REA_BAD_PATH, REVERSE_NO_SANDBOX, USAGE, NO_TARGET, SECRET_TARGET, OWN_TARGET, KEY_TARGET, ODD_TARGET, NO_PROFILE, CHANGED_PROFILE];
const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
const missing = (error: unknown): false => { if (isFsError(error, 'ENOENT') || isFsError(error, 'EACCES') || isFsError(error, 'ENOTDIR')) return false; throw error; };

// setting: settings.reversePath, an absolute path you chose. Otherwise the first `rea` on PATH that isn't inside the folder
// the agent works in (a repository can't plant its own REA), as the language servers are found.
export async function findRea(setting: string | undefined, path: string, cwd: string): Promise<string> {
  if (setting !== undefined) {
    if (!isAbsolute(setting) || normalize(setting) !== setting || /[\p{C}]/u.test(setting)) throw new ReverseError(REA_BAD_PATH);
    const usable = await access(setting, constants.X_OK).then(async () => (await stat(setting)).isFile(), missing);
    if (!usable) throw new ReverseError(REA_BAD_PATH);
    return setting;
  }
  const found = await findServer('rea', path, cwd);
  if (!found) throw new ReverseError(REA_MISSING);
  return found;
}

// The file or folder to analyze, as its real path: it must exist, and never be a credential file, a key folder or AI
// Term's own folder (REA could read those for the model). Quotes around the path are dropped; spaces are part of it.
export async function reverseTarget(cwd: string, args: string, root: string, home = homedir()): Promise<string> {
  const typed = args.trim().replace(/^(["'])(.*)\1$/s, '$2');
  if (!typed) throw new ReverseError(USAGE);
  const wanted = resolve(cwd, typed);
  if (SECRET_FILE.test(wanted.replaceAll('\\', '/'))) throw new ReverseError(SECRET_TARGET);
  if (!await lstat(wanted).then(() => true, missing)) throw new ReverseError(NO_TARGET);
  const real = await realpath(wanted);
  if (SECRET_FILE.test(real)) throw new ReverseError(SECRET_TARGET);
  const own = [root, await realpath(root).catch(() => root)];
  if (own.some(folder => inside(real, folder) || inside(folder, real))) throw new ReverseError(OWN_TARGET);
  const keys = await Promise.all(SECRET_PATHS.map(name => join(home, name)).map(async path => [path, await realpath(path).catch(() => path)]));
  if (keys.flat().some(folder => inside(real, folder))) throw new ReverseError(KEY_TARGET);
  try { sandboxPath(real); } catch (error) { if (error instanceof SandboxPathError) throw new ReverseError(ODD_TARGET); throw error; }
  return real;
}

// Added after the agent sandbox's own rules (last match wins). Reviews: REA reads attacker-written binaries and may run
// them, so its sandbox is tighter than bash's: no key folder or secret-named file is readable; it writes only its own
// state (~/.rea, per REA's README) and a private temp folder, so the target, your repository (its .git hooks included)
// and every persistence spot stay unwritten, and no hard link reaches the target; no IP traffic in or out (127.0.0.1
// included: AI Term's endpoints and your local services), no name lookups (a lookup alone carries data out), no unix
// socket but the system log, and no app or script that would fetch or act for it (open, osascript, LaunchServices,
// Apple Events, URL sessions).
const SECRET_NAMES = String.raw`/(\.env(\.[^/]*)?|\.envrc|id_(rsa|dsa|ecdsa|ed25519)|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.pgpass|credentials(\.[a-z]+)?|[^/]*\.(pem|key|p12|pfx|ppk|kdbx))$`;
export function reverseRules(spec: { secrets: readonly string[]; writable: readonly string[] }): string[] {
  const q = (path: string) => `"${sandboxPath(path)}"`;
  return [`(deny file-read-data file-read-xattr ${spec.secrets.map(path => `(subpath ${q(path)})`).join(' ')})`, `(deny file-read-data (regex #"${SECRET_NAMES}"))`,
    '(deny file-write* (subpath "/"))',
    `(allow file-write* ${spec.writable.map(path => `(subpath ${q(path)})`).join(' ')} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))`,
    '(deny file-link)',
    '(deny network-outbound (remote unix-socket))', '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/syslog")))',
    '(deny network-outbound (remote ip "*:*"))', '(deny network-inbound (local ip "*:*"))', '(deny network-bind (local ip "*:*"))',
    '(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/usr/bin/osacompile"))',
    '(deny mach-lookup (global-name "com.apple.dnssd.service") (global-name "com.apple.mDNSResponder") (global-name "com.apple.nsurlsessiond") (global-name "com.apple.nsurlsessiond.NSURLSessionProxyService") (global-name "com.apple.networkd") (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.coreservices.appleevents"))', ''];
}
// The file REA really is (its link followed), so the popup's approval covers that file and not just its path.
export async function reaIdentity(path: string): Promise<string> {
  const info = await stat(await realpath(path));
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
}
// PATH may be longer than one MCP argument (2048 bytes): REA's folder, node's and the system's go first, then yours in
// order while they fit (review: a dropped PATH left a node-script REA unable to start).
function shortPath(path: string, rea: string): string {
  const wanted = [dirname(rea), dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin', ...path.split(':').filter(entry => isAbsolute(entry))];
  const kept: string[] = [];
  for (const entry of new Set(wanted)) if (Buffer.byteLength(`PATH=${[...kept, entry].join(':')}`) <= 2048) kept.push(entry);
  return kept.join(':');
}
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/;
export interface ReverseServer { command: string; args: string[] }
// The server's argv, for whichever engine starts it: /usr/bin/env -i clears the engine's own env (a CLI's status
// credentials, an AI Term variable), then the bash env's allowlist (no key, token or AI Term name), then sandbox-exec with
// the profile in a private file (a profile is too long for one MCP argument), then `rea mcp`.
export async function reverseServer(options: { rea: string; target: string; cwd: string; root: string; home?: string; env: NodeJS.ProcessEnv; platform?: NodeJS.Platform }): Promise<ReverseServer> {
  if ((options.platform ?? process.platform) !== 'darwin') throw new ReverseError(REVERSE_NO_SANDBOX);
  const env = buildBashEnv(options.env);
  // A folder the agent sandbox can't protect (quotes in a path it guards, a link it can't follow) refuses the start.
  const argv = await sandboxedArgv([options.rea, 'mcp'], { cwd: options.cwd, env, sandbox: { home: options.root, require: true, platform: 'darwin', ...options.home ? { user: options.home } : {} } }).catch((error: unknown) => { if (error instanceof ToolError) throw new ReverseError(NO_PROFILE); throw error; });
  const base = argv.program === SANDBOX_EXEC && argv.args[0] === '-p' ? argv.args[1] : undefined;
  if (!base) throw new ReverseError(REVERSE_NO_SANDBOX);
  const home = options.home ?? homedir(), realHome = await realpath(home).catch(() => home);
  const secrets = [...new Set((await Promise.all(SECRET_PATHS.flatMap(name => [join(home, name), join(realHome, name)]).map(async path => [path, await realpath(path).catch(() => path)]))).flat())];
  // REA's own temp folder: one per user, private, never a link (so its path, and the profile, stay the same per user).
  const temp = join(await realpath(tmpdir()), `ai-term-rea-${process.getuid?.() ?? 0}`); await privateDirectory(temp);
  const info = await lstat(temp);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new ReverseError(NO_PROFILE);
  let profile: string;
  try { profile = base + reverseRules({ secrets, writable: [join(home, '.rea'), join(realHome, '.rea'), temp] }).join('\n'); } catch (error) { if (error instanceof SandboxPathError) throw new ReverseError(ODD_TARGET); throw error; }
  const folder = join(options.root, 'reverse'); await privateDirectory(folder);
  const name = `${createHash('sha256').update(profile).digest('hex')}.sb`, file = join(folder, name);
  try { const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { await handle.writeFile(profile); } finally { await handle.close(); } }
  catch (error) {
    if (!isFsError(error, 'EEXIST')) throw error;
    // Content-addressed: an existing file must hold exactly this profile, private and not a link, or nothing starts.
    const existing = await lstat(file);
    if (!existing.isFile() || (existing.mode & 0o077) !== 0 || existing.nlink !== 1 || await addonFile(folder, name, 256 * 1024) !== profile) throw new ReverseError(CHANGED_PROFILE);
  }
  const values = { ...env, PATH: shortPath(env.PATH ?? '', options.rea), TMPDIR: temp };
  // Any other value that can't be one plain argument refuses the start rather than starting REA without it.
  if (Object.entries(values).some(([key, value]) => !ENV_NAME.test(key) || /[\p{C}]/u.test(value) || Buffer.byteLength(`${key}=${value}`) > 2048)) throw new ReverseError(NO_PROFILE);
  const pairs = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  return { command: '/usr/bin/env', args: ['-i', ...pairs, SANDBOX_EXEC, '-f', file, '--', options.rea, 'mcp'] };
}
