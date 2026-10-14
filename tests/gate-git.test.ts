import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile, realpath, utimes, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { listWorktrees } from '../src/daemon/git.js';
vi.mock('../src/daemon/engines.js', () => ({ checkEngine: async () => ({ installed: true, path: process.execPath, loggedIn: true, authMethod: 'subscription' }) }));

// v0.3 gate, security review: submodule entries (gitlinks) in an agent's worktree.
const run = promisify(execFile), roots: string[] = [], managers: SessionManager[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.shutdown(); for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => run('/usr/bin/git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args], { cwd });
const exists = (path: string) => access(path).then(() => true, () => false);
// A repo whose HEAD has a gitlink at `link` (the submodule's commit need not exist), and one agent whose worktree has it.
async function withGitlink(link: string) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ai-gate-git-'))); roots.push(temp);
  const repo = join(temp, 'repo'), home = join(temp, 'home'); await mkdir(repo); await mkdir(home, { mode: 0o700 });
  await writeFile(join(repo, 'README'), 'base'); await writeFile(join(repo, '.gitmodules'), `[submodule "x"]\n\tpath = ${link}\n\turl = ./nowhere\n`);
  await git(repo, 'init', '-b', 'main', '--'); await git(repo, 'add', '--', 'README', '.gitmodules');
  await git(repo, 'update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},${link}`);
  await git(repo, 'commit', '-m', 'base', '--');
  const paths = getPaths(home); await preparePaths(paths);
  const m = new SessionManager(paths, new Logger(paths.log)); managers.push(m); await m.load();
  const agent = await m.create({ engine: 'codex', model: null, auth: { kind: 'account' }, cwd: repo, permission: 'ask', title: 'sub' });
  await expect.poll(() => m.get(agent.id).status).toMatch(/exited|error/);
  const tree = agent.worktree ?? ''; if (!tree) throw new Error('no worktree');
  return { temp, repo, m, tree, branch: agent.branch ?? '' };
}

it('HIGH-1: a filter an agent writes into a submodule inside its worktree never runs when AI Term checks that worktree', async () => {
  const { temp, m, tree, branch } = await withGitlink('sub'), sub = join(tree, 'sub'), mark = join(temp, 'MARK');
  // Everything below writes only inside the agent's own worktree.
  await git(sub, 'init', '-b', 'main', '--'); await writeFile(join(sub, 'f'), 'x'); await writeFile(join(sub, '.gitattributes'), 'f filter=pwn\n');
  await git(sub, 'add', '--', 'f', '.gitattributes'); await git(sub, 'commit', '-m', 'f', '--');
  await git(sub, 'config', 'filter.pwn.clean', `sh -c 'echo ran >> ${mark}; cat'`);
  const later = new Date(Date.now() + 60_000); await utimes(join(sub, 'f'), later, later);
  const view = await m.checkWorktree(tree);
  expect(await exists(mark)).toBe(false);
  // MEDIUM-1: a populated submodule goes with the worktree, so it counts as loss and the typed-name delete can remove it.
  expect(view.loss?.changed).toBeGreaterThan(0); expect(view.refusal).toBeUndefined();
  await m.deleteWorktree(tree, view.fingerprint ?? '', branch);
  expect(await exists(tree)).toBe(false); expect(await exists(mark)).toBe(false);
});

it('HIGH-2: files in an unpopulated submodule folder count as loss, so one keypress can never delete them', async () => {
  const { repo, m, tree, branch } = await withGitlink('vendor/lib');
  await writeFile(join(tree, 'vendor', 'lib', 'IMPORTANT.txt'), 'work');
  const view = await m.checkWorktree(tree);
  expect(view.loss?.changed).toBeGreaterThan(0);
  await expect(m.deleteWorktree(tree, view.fingerprint ?? '')).rejects.toThrow('Type the branch name to confirm');
  expect(await readFile(join(tree, 'vendor', 'lib', 'IMPORTANT.txt'), 'utf8')).toBe('work');
  expect(await listWorktrees(repo)).toHaveLength(2);
  void branch;
});

it('an untouched empty submodule folder is no loss, and the worktree deletes as before', async () => {
  const { m, tree } = await withGitlink('vendor/lib');
  const view = await m.checkWorktree(tree);
  expect(view.loss).toMatchObject({ changed: 0, untracked: 0, commits: 0 });
  await m.deleteWorktree(tree, view.fingerprint ?? '');
  expect(await exists(tree)).toBe(false);
});

it('L3: reading HEAD never runs gpg.program, even when the repo config asks to show signatures', async () => {
  const { headCommit } = await import('../src/daemon/git.js'), { chmod } = await import('node:fs/promises');
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ai-gate-gpg-'))); roots.push(temp);
  const repo = join(temp, 'repo'), mark = join(temp, 'MARK'), gpg = join(temp, 'gpg'); await mkdir(repo);
  await writeFile(join(repo, 'README'), 'base'); await git(repo, 'init', '-b', 'main', '--'); await git(repo, 'add', '--', 'README'); await git(repo, 'commit', '-m', 'base', '--');
  const tree = (await git(repo, 'rev-parse', 'HEAD^{tree}')).stdout.trim();
  const body = `tree ${tree}\nauthor T <t@example.invalid> 0 +0000\ncommitter T <t@example.invalid> 0 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n x\n -----END PGP SIGNATURE-----\n\nsigned\n`;
  const signed = await new Promise<string>((resolve, reject) => { const child = execFile('/usr/bin/git', ['hash-object', '-w', '-t', 'commit', '--stdin'], { cwd: repo }, (e, out) => e ? reject(e) : resolve(out.trim())); child.stdin?.end(body); });
  await git(repo, 'update-ref', 'refs/heads/main', signed);
  await writeFile(gpg, `#!/bin/sh\necho ran >> ${mark}\nexit 1\n`); await chmod(gpg, 0o755);
  await git(repo, 'config', 'log.showSignature', 'true'); await git(repo, 'config', 'gpg.program', gpg);
  expect(await headCommit(repo)).toBe(signed);
  expect(await exists(mark)).toBe(false);
});
