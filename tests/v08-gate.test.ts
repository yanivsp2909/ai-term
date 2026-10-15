import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBash, bashReport, persistencePaths } from '../src/agent/bash.js';
import { bashSandboxPlan, bwrapBashArgs } from '../src/daemon/bwrap.js';
import { buildBashEnv, buildAgentEnv } from '../src/daemon/env.js';
import { windowsTestCommand } from '../src/daemon/win-launch.js';
import { validateTestPlan } from '../src/shared/test-run.js';
import { PERSISTENCE_DIRS, PERSISTENCE_FILES } from '../src/daemon/sandbox-places.js';

// v0.8 release gate: security-reviewer, security-bounty-hunter, silent-failure-hunter and engineering:code-review, fresh
// context. Each test failed before its fix.
const MAC = process.platform === 'darwin', roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-v08-gate-'))); roots.push(dir); return dir; }

it.skipIf(!MAC)('HIGH (code review, reproduced): on macOS renaming a folder above a protected file (a dotfile link\'s target, the repository\'s .git, a custom AI Term folder) can\'t swap it out', async () => {
  const root = await temp(), home = join(root, 'home'), aiTerm = join(home, 'stuff', 'ai-term'), cwd = join(aiTerm, 'w'), git = join(home, 'proj', '.git');
  await mkdir(cwd, { recursive: true }); await mkdir(join(git, 'hooks'), { recursive: true }); await writeFile(join(git, 'config'), '[core]\n');
  await mkdir(join(home, 'dotfiles')); await writeFile(join(home, 'dotfiles', 'zshrc'), 'original\n'); await symlink(join(home, 'dotfiles', 'zshrc'), join(home, '.zshrc'));
  await writeFile(join(aiTerm, 'settings.json'), '{"budgets":{"daily":3}}');
  const result = await runBash(['cd ~', 'mv dotfiles d2 && echo evil >> d2/zshrc && mv d2 dotfiles', 'mv proj p2 && echo hook > p2/.git/hooks/pre-commit && mv p2 proj', 'mv stuff s2 && echo "{}" > s2/ai-term/settings.json && mv s2 stuff', 'true'].join('; '),
    { cwd, env: { ...buildBashEnv(process.env), HOME: home }, sandbox: { home: aiTerm, user: home, protect: [git], require: true } });
  expect(result.exitCode).toBe(0);
  expect(await readFile(join(home, 'dotfiles', 'zshrc'), 'utf8')).toBe('original\n');
  await expect(stat(join(git, 'hooks', 'pre-commit'))).rejects.toThrow();
  expect(await readFile(join(aiTerm, 'settings.json'), 'utf8')).toBe('{"budgets":{"daily":3}}');
}, 30_000);

it('MEDIUM (code review): ZDOTDIR and XDG_CONFIG_HOME reach the sandbox (not through the bash env); their startup and config places are protected', async () => {
  const env = buildAgentEnv({ PATH: '/usr/bin', HOME: '/h', ZDOTDIR: '/h/.config/zsh', XDG_CONFIG_HOME: '/h/cfg', XDG_RUNTIME_DIR: '/run/user/7' }, { secret: 'sk-ant-test0123456789abcdef0123', endpoint: null, entry: '/opt/ai/dist/cli/index.js' });
  expect(env).toMatchObject({ AITERM_ZDOTDIR: '/h/.config/zsh', AITERM_XDG_CONFIG_HOME: '/h/cfg', AITERM_XDG_RUNTIME_DIR: '/run/user/7' });
  expect(buildAgentEnv({ PATH: '/usr/bin', ZDOTDIR: 'relative' }, { secret: 'sk-ant-test0123456789abcdef0123', endpoint: null, entry: '/opt/ai/dist/cli/index.js' }).AITERM_ZDOTDIR).toBeUndefined();
  const dir = await temp();
  const places = await persistencePaths(dir, {}, { zdotdir: join(dir, 'z'), configHome: join(dir, 'cfg') });
  expect(places.files).toEqual(expect.arrayContaining([join(dir, 'z', '.zshrc'), join(dir, 'z', '.zshenv')]));
  expect(places.dirs).toEqual(expect.arrayContaining([join(dir, 'cfg', 'git'), join(dir, 'cfg', 'fish'), join(dir, 'cfg', 'autostart'), join(dir, 'cfg', 'systemd', 'user')]));
});

it('HIGH (security review, bounty): Linux agent bash can\'t reach a D-Bus bus or X11 display under /tmp, nor read ~/.dbus or ~/.Xauthority', async () => {
  const dir = await temp(), home = join(dir, 'home'), aiTerm = join(home, '.ai-term'), cwd = join(aiTerm, 'w'), tmp = join(dir, 'tmp');
  await mkdir(cwd, { recursive: true }); await mkdir(join(home, '.dbus', 'session-bus'), { recursive: true }); await writeFile(join(home, '.Xauthority'), 'cookie');
  await mkdir(join(tmp, '.X11-unix'), { recursive: true }); await writeFile(join(tmp, 'dbus-AbCd'), ''); await writeFile(join(tmp, 'other'), '');
  const plan = await bashSandboxPlan({ user: home, aiTermHome: aiTerm, cwd, protect: [], runtime: null, tmp });
  const entries = plan.shadows[0]?.entries.map(entry => entry.path) ?? [];
  expect(entries).not.toContain(join(home, '.dbus')); expect(entries).not.toContain(join(home, '.Xauthority'));
  const args = bwrapBashArgs(plan).join(' ');
  expect(args).toContain(`--tmpfs ${join(tmp, '.X11-unix')}`);
  expect(args).toContain(`--ro-bind /dev/null ${join(tmp, 'dbus-AbCd')}`);
  expect(args).not.toContain(join(tmp, 'other'));
});

it('MEDIUM (bounty): a rebuilt folder reached through a link has its parents pinned too, and pins come before what they hold', async () => {
  const dir = await temp(), home = join(dir, 'home'), aiTerm = join(home, '.ai-term'), cwd = join(aiTerm, 'w');
  await mkdir(cwd, { recursive: true }); await mkdir(join(home, 'dot', 'files', 'cfg', 'git'), { recursive: true }); await symlink(join(home, 'dot', 'files', 'cfg'), join(home, '.config'));
  const plan = await bashSandboxPlan({ user: home, aiTermHome: aiTerm, cwd, protect: [], runtime: null });
  expect(plan.pinned).toEqual(expect.arrayContaining([join(home, 'dot', 'files')]));
  const args = bwrapBashArgs(plan).join(' ');
  expect(args.indexOf(`--bind ${join(home, 'dot', 'files')} ${join(home, 'dot', 'files')}`)).toBeLessThan(args.indexOf(`--tmpfs ${join(home, 'dot', 'files', 'cfg')}`));
  expect(args.indexOf(`--bind ${join(home, 'dot', 'files')} ${join(home, 'dot', 'files')}`)).toBeGreaterThan(args.indexOf(`--tmpfs ${home} `));
});

it('MEDIUM (security review): on Windows a test or MCP command not found on PATH is refused, never run by bare name from the worktree', async () => {
  await expect(windowsTestCommand(['cargo', 'test'], 'C:\\nowhere')).rejects.toThrow("isn't on PATH");
});

it('LOW (security review): a test plan or project setting with a Windows path validates', () => {
  const plan = { title: 'fixer', command: ['npm', 'test'], cwd: 'C:\\Users\\me\\.ai-term\\worktrees\\r\\a', changed: [], fingerprint: 'a'.repeat(64), sandbox: false, loopback: false };
  if (process.platform === 'win32') expect(validateTestPlan(plan)).toMatchObject({ cwd: plan.cwd });
  expect(() => validateTestPlan({ ...plan, cwd: 'relative' })).toThrow();
});

it('MEDIUM (silent failures): a command that ran without a sandbox in Ask says so, with why', async () => {
  const dir = await temp();
  const result = await runBash('echo hi', { cwd: dir, env: buildBashEnv(process.env), sandbox: { home: join(dir, 'h'), platform: 'linux', linux: { bwrap: null, ready: async () => false } } });
  expect(result.unsandboxed).toBe("bubblewrap (bwrap) isn't installed");
  expect(bashReport(result, 10_000)).toContain("(ran without a sandbox: bubblewrap (bwrap) isn't installed)");
});

it('MEDIUM (silent failures): a failed bubblewrap probe is looked at again on the next command, not cached for the agent\'s life', async () => {
  const { probeCacheMs } = await import('../src/agent/bash.js');
  expect(probeCacheMs(true)).toBe(Infinity); expect(probeCacheMs(false)).toBe(0);
});

it('MEDIUM (silent failures): a client whose daemon exits during start says so at once; a client without the daemon\'s sandbox answer offers Ask only', async () => {
  const text = await readFile(join(process.cwd(), 'src', 'client', 'connection.ts'), 'utf8');
  expect(text).toContain('Daemon stopped during start');
  const home = await readFile(join(process.cwd(), 'src', 'client', 'tui', 'homepage.ts'), 'utf8');
  expect(home).not.toContain('status.agentSandbox??{dontAsk:true}');
});

it('LOW (code review): the persistence list adds ~/.bash_aliases, oh-my-zsh custom scripts and D-Bus service files', () => {
  expect(PERSISTENCE_FILES).toContain('.bash_aliases');
  expect(PERSISTENCE_DIRS).toEqual(expect.arrayContaining(['.oh-my-zsh/custom', '.local/share/dbus-1/services']));
});
