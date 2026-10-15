import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyText } from '../src/client/tui/clipboard.js';
import { openFolder } from '../src/client/tui/open-folder.js';
import { parseMeminfo, parseProcNetDev, sampleCommands } from '../src/daemon/sysstats.js';
import { Notifier, notifySendBody } from '../src/daemon/notifier.js';
import { keychainUnavailable } from '../src/daemon/keys.js';
import { bwrapTestArgs, bwrapBashArgs, bashSandboxPlan, findBwrap } from '../src/daemon/bwrap.js';
import { prepareSandbox, sandboxDenial } from '../src/daemon/test-sandbox.js';
import { agentSandbox, dontAskNote } from '../src/daemon/agent-sandbox.js';
import { modeValues } from '../src/client/tui/commands.js';
import { runBash } from '../src/agent/bash.js';
import { runTests } from '../src/daemon/test-run.js';
import { buildBashEnv, buildTestEnv } from '../src/daemon/env.js';
import { validateResponse } from '../src/shared/validate.js';
import { appBuilderConfig } from '../scripts/app-config.mjs';

// v0.8.1 Linux. The pure parts run everywhere; the bubblewrap ones only on Linux with bwrap installed (GitHub Actions'
// ubuntu-latest in the v0.8 gate), because this Mac has neither.
const LINUX = process.platform === 'linux', roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-linux-'))); roots.push(dir); return dir; }
const BWRAP = LINUX ? await findBwrap() : null;

function fakeCopy(calls: { file: string; args: string[]; input: string }[]) {
  return (file: string, args: string[], _options: { timeout: number }, callback: (error: Error | null) => void) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough() }), call = { file, args, input: '' };
    calls.push(call);
    child.stdin.on('data', (chunk: Buffer) => { call.input += chunk.toString(); });
    child.stdin.on('finish', () => { callback(null); child.emit('close', 0); });
    return child;
  };
}
it('clipboard: Linux uses wl-copy on Wayland, else xclip or xsel; none installed says which to install', async () => {
  const calls: { file: string; args: string[]; input: string }[] = [];
  const found = (names: string[]) => async (name: string) => names.includes(name) ? `/usr/bin/${name}` : null;
  await copyText('hello', fakeCopy(calls), { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, find: found(['wl-copy', 'xclip']) });
  await copyText('x11', fakeCopy(calls), { platform: 'linux', env: { DISPLAY: ':0' }, find: found(['wl-copy', 'xclip']) });
  await copyText('sel', fakeCopy(calls), { platform: 'linux', env: { DISPLAY: ':0' }, find: found(['xsel']) });
  expect(calls).toEqual([{ file: '/usr/bin/wl-copy', args: [], input: 'hello' }, { file: '/usr/bin/xclip', args: ['-selection', 'clipboard'], input: 'x11' }, { file: '/usr/bin/xsel', args: ['--clipboard', '--input'], input: 'sel' }]);
  await expect(copyText('x', fakeCopy(calls), { platform: 'linux', env: {}, find: found([]) })).rejects.toThrow('no clipboard tool: install wl-clipboard, xclip or xsel');
  await copyText('mac', fakeCopy(calls), { platform: 'darwin', env: {}, find: found([]) });
  expect(calls.at(-1)).toEqual({ file: '/usr/bin/pbcopy', args: [], input: 'mac' });
});

it('/open: Linux opens the folder with xdg-open (argv, -- not supported by it, so the path must be absolute)', async () => {
  const dir = await temp(), runs: { file: string; args: readonly string[] }[] = [];
  const where = await openFolder(dir, 'finder', async (file, args) => { runs.push({ file, args }); }, async name => name === 'xdg-open' ? '/usr/bin/xdg-open' : null, 'linux');
  expect(where).toBe('your file manager');
  expect(runs).toEqual([{ file: '/usr/bin/xdg-open', args: [dir] }]);
  await expect(openFolder(dir, 'finder', async () => {}, async () => null, 'linux')).rejects.toThrow("xdg-open isn't installed");
});

it('system stats on Linux: /proc/meminfo (total − available) and /proc/net/dev (loopback skipped), ps with -A', () => {
  expect(parseMeminfo('MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:    6000000 kB\n')).toBe(10_000_000 * 1024);
  expect(parseMeminfo('MemTotal: x kB\n')).toBeNull();
  const net = parseProcNetDev('Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo: 500 5 0 0 0 0 0 0 500 5 0 0 0 0 0 0\n  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\n');
  expect(net && Object.fromEntries(net)).toEqual({ eth0: { rx: 1000, tx: 2000 } });
  expect(parseProcNetDev('garbage')).toBeNull();
  const linux = sampleCommands('linux');
  expect(linux.ps.args).toEqual(['-Ao', 'pid=,ppid=,rss=,%cpu=']);
  expect([linux.memory.file, ...linux.memory.args]).toEqual(['/bin/cat', '/proc/meminfo']);
  expect([linux.net.file, ...linux.net.args]).toEqual(['/bin/cat', '/proc/net/dev']);
  expect(sampleCommands('darwin').memory.file).toBe('/usr/bin/vm_stat');
});

it('notifications on Linux: notify-send with argv, markup escaped; without it the state says none, and no click-through', async () => {
  expect(notifySendBody('<b>fix & ship</b> needs you')).toBe('&lt;b&gt;fix &amp; ship&lt;/b&gt; needs you');
  const launched: { file: string; args: readonly string[] }[] = [];
  const log = { error: vi.fn() };
  const notifier = new Notifier(null, log, async () => true, (file, args, done) => { launched.push({ file, args }); done(null); }, () => true, Date.now, undefined, { platform: 'linux', notifySend: '/usr/bin/notify-send' });
  expect(notifier.state()).toBe('ready');
  notifier.transition({ id: '11111111-1111-4111-8111-111111111111', title: 'fix <it>' } as never, { status: 'working', statusDetail: null } as never, { status: 'waiting', statusDetail: null } as never, false);
  await vi.waitFor(() => expect(launched).toHaveLength(1));
  expect(launched[0]?.file).toBe('/usr/bin/notify-send');
  expect(launched[0]?.args.slice(0, 3)).toEqual(['--app-name=AI Term', '--', 'AI Term']);
  expect(launched[0]?.args[3]).toContain('fix &lt;it&gt;');
  expect(new Notifier(null, log, async () => true, undefined, undefined, Date.now, undefined, { platform: 'linux', notifySend: null }).state()).toBe('none');
  expect(validateResponse({ id: '11111111-1111-4111-8111-111111111111', ok: true, engines: { claudeCode: { installed: false }, codex: { installed: false } }, notifier: 'none' })).toMatchObject({ notifier: 'none' });
});

it('keys on Linux: no Secret Service refuses with one clear line, never a file', () => {
  expect(keychainUnavailable('linux')).toBe('No Secret Service keyring (none running, or it is locked); API keys need one, and AI Term never stores them in a file');
  expect(keychainUnavailable('darwin')).toBe('OS keychain unavailable');
});

it('bubblewrap test profile: home, /tmp and /run hidden, toolchains and the git folder read-only, key folders hidden again, only the worktree and temp folder writable, its own network', () => {
  const args = bwrapTestArgs({ worktree: '/home/me/.ai-term/worktrees/r/a b', temp: '/tmp/ai-term-test-1', hidden: ['/home/me', '/tmp', '/run'], readable: ['/home/me/.nvm', '/home/me/src/app/.git'], secrets: [{ path: '/home/me/.nvm/.npmrc', dir: false }, { path: '/home/me/.config/gh', dir: true }] });
  const text = args.join(' ');
  expect(args.slice(0, 3)).toEqual(['--die-with-parent', '--new-session', '--unshare-all']);
  expect(args).not.toContain('--share-net');
  expect(text).toContain('--ro-bind / / --dev /dev --proc /proc');
  expect(text).toContain('--tmpfs /home/me --tmpfs /tmp --tmpfs /run');
  expect(text).toContain('--ro-bind /home/me/.nvm /home/me/.nvm --ro-bind /home/me/src/app/.git /home/me/src/app/.git');
  expect(text).toContain('--ro-bind /dev/null /home/me/.nvm/.npmrc --tmpfs /home/me/.config/gh');
  expect(args.slice(-8)).toEqual(['--bind', '/home/me/.ai-term/worktrees/r/a b', '/home/me/.ai-term/worktrees/r/a b', '--bind', '/tmp/ai-term-test-1', '/tmp/ai-term-test-1', '--chdir', '/home/me/.ai-term/worktrees/r/a b']);
  expect(() => bwrapTestArgs({ worktree: 'relative', temp: '/tmp/x', hidden: [], readable: [], secrets: [] })).toThrow();
  expect(() => bwrapTestArgs({ worktree: '/a\nb', temp: '/tmp/x', hidden: [], readable: [], secrets: [] })).toThrow();
});

it('bubblewrap bash profile: its own process view, AI Term\'s folder and runtime sockets hidden, home rebuilt so persistence spots are read-only and new ones can\'t be made', () => {
  const args = bwrapBashArgs({ aiTermHome: '/home/me/.ai-term', cwd: '/home/me/.ai-term/worktrees/r/a', runtime: '/run/user/1000', shadows: [{ dir: '/home/me', entries: [{ path: '/home/me/src', kind: 'dir', readOnly: false }, { path: '/home/me/.zshrc', kind: 'file', readOnly: true }, { path: '/home/me/proj', kind: 'link', target: '/data/proj', readOnly: false }] }], readOnly: ['/home/me/dotfiles/zshrc', '/home/me/src/app/.git/hooks', '/home/me/src/app/.git/config'] });
  const text = args.join(' ');
  expect(text).toContain('--unshare-pid');
  expect(args).not.toContain('--unshare-net');
  expect(text).toContain('--bind / / --dev /dev --proc /proc');
  expect(text).toContain('--tmpfs /home/me --bind /home/me/src /home/me/src --ro-bind /home/me/.zshrc /home/me/.zshrc --symlink /data/proj /home/me/proj');
  expect(text).toContain('--tmpfs /run/user/1000 --tmpfs /home/me/.ai-term --bind /home/me/.ai-term/worktrees/r/a /home/me/.ai-term/worktrees/r/a');
  expect(text.indexOf('--ro-bind /home/me/dotfiles/zshrc')).toBeGreaterThan(text.indexOf('--bind /home/me/.ai-term/worktrees'));
  expect(args.slice(-2)).toEqual(['--chdir', '/home/me/.ai-term/worktrees/r/a']);
});

it('bash sandbox plan: every entry of home comes back except AI Term\'s folder; persistence spots and link targets read-only; a missing one is never created on disk', async () => {
  const dir = await temp(), home = join(dir, 'home'), aiTerm = join(home, '.ai-term'), cwd = join(aiTerm, 'w');
  await mkdir(cwd, { recursive: true }); await mkdir(join(home, 'src')); await mkdir(join(home, '.config', 'git'), { recursive: true }); await mkdir(join(home, 'dotfiles'));
  await writeFile(join(home, 'dotfiles', 'zshrc'), ''); await symlink(join(home, 'dotfiles', 'zshrc'), join(home, '.zshrc')); await writeFile(join(home, '.bashrc'), '');
  const plan = await bashSandboxPlan({ user: home, aiTermHome: aiTerm, cwd, protect: [], runtime: null });
  const top = plan.shadows.find(shadow => shadow.dir === home), config = plan.shadows.find(shadow => shadow.dir === join(home, '.config'));
  expect(top?.entries.map(entry => entry.path).sort()).toEqual([join(home, '.bashrc'), join(home, '.config'), join(home, '.zshrc'), join(home, 'dotfiles'), join(home, 'src')]);
  expect(top?.entries.find(entry => entry.path === join(home, '.bashrc'))?.readOnly).toBe(true);
  expect(top?.entries.find(entry => entry.path === join(home, '.zshrc'))).toMatchObject({ kind: 'link', readOnly: true });
  expect(top?.entries.find(entry => entry.path === join(home, '.config'))?.kind).toBe('shadowed');
  expect(config?.entries.find(entry => entry.path === join(home, '.config', 'git'))?.readOnly).toBe(true);
  expect(plan.readOnly).toContain(join(home, 'dotfiles', 'zshrc'));
  await expect(stat(join(home, '.zlogin'))).rejects.toThrow();
});

it('Linux test denials read as blocked: a read-only file system or an unreachable network, never a failure count', () => {
  const box = { worktree: '/home/me/.ai-term/w', temp: '/tmp/ai-term-test-1', home: '/home/me' };
  expect(sandboxDenial("Error: EROFS: read-only file system, open '/usr/lib/evil'", box)).toBe('/usr/lib/evil');
  expect(sandboxDenial('touch: cannot touch \'/etc/x\': Read-only file system', box)).toBe('/etc/x');
  expect(sandboxDenial('Error: connect ENETUNREACH 1.2.3.4:443', box)).toBe('network');
  expect(sandboxDenial('curl: (6) Could not resolve host: example.com', box)).toBe('network');
});

it('Ask only without a sandbox: Windows never has one; a missing sandbox gives the one-line reason; the mode choice drops don\'t ask for AI Term\'s agent only', async () => {
  expect(await agentSandbox('win32')).toEqual({ dontAsk: false, note: "don't ask needs a sandbox, and Windows has none AI Term can use" });
  expect(await agentSandbox('linux', { bwrap: null })).toEqual({ dontAsk: false, note: "don't ask needs bubblewrap (bwrap), which isn't installed" });
  expect(await agentSandbox('linux', { bwrap: '/usr/bin/bwrap', probe: async () => false })).toEqual({ dontAsk: false, note: "don't ask needs a sandbox, and bubblewrap couldn't start one here" });
  expect(await agentSandbox('linux', { bwrap: '/usr/bin/bwrap', probe: async () => true })).toEqual({ dontAsk: true });
  expect(dontAskNote({ dontAsk: false, note: 'x' })).toBe('x');
  expect(modeValues('ai-term', false)).toEqual(['ask']);
  expect(modeValues('ai-term', true)).toEqual(['ask', 'dontAsk']);
  expect(modeValues('codex', false)).toEqual(['ask', 'dontAsk']);
});

it('agent bash in Don\'t ask never runs without its sandbox; in Ask it runs after your yes as before', async () => {
  const dir = await temp();
  await expect(runBash('echo hi', { cwd: dir, env: buildBashEnv(process.env), sandbox: { home: join(dir, 'h'), require: true, platform: 'win32' } })).rejects.toThrow("bash can't run in don't ask without a sandbox");
});

it('desktop packages: an AppImage and a .deb on Linux, nothing signed; the macOS helper only on macOS', () => {
  const linux = appBuilderConfig({ platform: 'linux', root: '/r', out: '/o', version: '44.7.2', arch: 'x64' });
  expect(linux.linux).toMatchObject({ target: [{ target: 'AppImage' }, { target: 'deb' }] });
  expect(linux.extraFiles ?? []).toEqual([]);
  expect(JSON.stringify(linux)).not.toMatch(/identity|notarize|CSC/);
  const mac = appBuilderConfig({ platform: 'darwin', root: '/r', out: '/o', version: '44.7.2', arch: 'arm64' });
  expect(mac.extraFiles).toEqual([{ from: '/r/build/notifier/AI Term.app', to: 'Helpers/AI Term.app' }]);
});

// --- Real bubblewrap (Linux with bwrap only) ---
it.skipIf(!BWRAP)('Linux bwrap: tests write only their worktree and temp folder; home, key folders and other agents are unreadable; no network', async () => {
  const dir = await temp(), home = join(dir, 'home'), tree = join(home, '.ai-term', 'worktrees', 'r', 'a'), other = join(home, '.ai-term', 'worktrees', 'r', 'b');
  await mkdir(tree, { recursive: true }); await mkdir(other, { recursive: true }); await mkdir(join(home, '.ssh')); await mkdir(join(home, 'Documents'));
  await writeFile(join(home, '.ssh', 'id_test'), 'SECRET'); await writeFile(join(home, 'Documents', 'x'), 'PRIVATE'); await writeFile(join(other, 'y'), 'OTHER');
  await writeFile(join(tree, 'probe.sh'), `#!/bin/sh\ncat "$HOME/.ssh/id_test" > ssh.txt 2>/dev/null\ncat "$HOME/Documents/x" > docs.txt 2>/dev/null\ncat "${other}/y" > other.txt 2>/dev/null\necho ok > "$TMPDIR/t" && echo tmp > tmp.txt\necho pwned > "$HOME/pwned" 2>/dev/null\necho pwned > /usr/pwned 2>/dev/null\n(getent hosts example.com || true) > net.txt\nexit 0\n`);
  await chmod(join(tree, 'probe.sh'), 0o755);
  const env = { ...buildTestEnv(process.env), HOME: home }, box = await prepareSandbox(tree, { home, private: [join(home, '.ai-term')], loopback: false, env });
  try { expect(await runTests(['./probe.sh'], tree, { ...env, ...box.env }, { timeoutMs: 20_000, sandbox: box })).toEqual({ state: 'pass' }); } finally { await box.dispose(); }
  for (const name of ['ssh.txt', 'docs.txt', 'other.txt', 'net.txt']) expect(await readFile(join(tree, name), 'utf8'), name).toBe('');
  expect(await readFile(join(tree, 'tmp.txt'), 'utf8')).toBe('tmp\n');
  await expect(stat(join(home, 'pwned'))).rejects.toThrow(); await expect(access('/usr/pwned', constants.F_OK)).rejects.toThrow();
}, 60_000);

it.skipIf(!BWRAP)('Linux bwrap: agent bash can\'t see AI Term\'s folder or other processes, can\'t write or create startup files, and works with the network and its own folder', async () => {
  const dir = await temp(), home = join(dir, 'home'), aiTerm = join(home, '.ai-term'), cwd = join(aiTerm, 'worktrees', 'r', 'a');
  await mkdir(cwd, { recursive: true }); await mkdir(join(aiTerm, 'run'), { recursive: true }); await writeFile(join(aiTerm, 'settings.json'), '{"budgets":{"daily":3}}'); await writeFile(join(home, '.bashrc'), 'original\n');
  const result = await runBash([`cat "${aiTerm}/settings.json" > read.txt 2>/dev/null`, `echo '{}' > "${aiTerm}/settings.json" 2>/dev/null`, 'ls /proc | grep -c "^[0-9]" > procs.txt', 'echo evil >> ~/.bashrc', 'echo evil > ~/.zlogin', 'mkdir -p ~/.config/fish && echo evil > ~/.config/fish/config.fish', 'echo own > own.txt', 'true'].join('; '),
    { cwd, env: { ...buildBashEnv(process.env), HOME: home }, sandbox: { home: aiTerm, user: home, require: true } });
  expect(result.exitCode).toBe(0);
  expect(await readFile(join(cwd, 'read.txt'), 'utf8')).toBe('');
  expect(await readFile(join(aiTerm, 'settings.json'), 'utf8')).toBe('{"budgets":{"daily":3}}');
  expect(Number(await readFile(join(cwd, 'procs.txt'), 'utf8'))).toBeLessThan(10);
  expect(await readFile(join(home, '.bashrc'), 'utf8')).toBe('original\n');
  await expect(stat(join(home, '.zlogin'))).rejects.toThrow(); await expect(stat(join(home, '.config', 'fish'))).rejects.toThrow();
  expect(await readFile(join(cwd, 'own.txt'), 'utf8')).toBe('own\n');
}, 60_000);
