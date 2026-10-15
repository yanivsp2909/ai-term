import { afterEach, expect, it, vi } from 'vitest';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { SettingsStore } from '../src/daemon/settings.js';
import type { SessionInfo } from '../src/shared/protocol.js';

// v0.7.3 /merge and /pr. /merge merges ai/<slug> into the base branch in YOUR checkout, only when that checkout is clean
// and on the base branch, with exactly `git merge --no-ff -- ai/<slug>`; a conflict is aborted at once. /pr pushes the
// branch to origin and runs `gh pr create` in the worktree. Both scan for secrets first and refuse on a hit unless the
// user typed override. Tests use temp repos, a temp bare origin and a stub gh; nothing reaches GitHub.
const run = promisify(execFile), roots: string[] = [], managers: SessionManager[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.shutdown(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
const git = (cwd: string, ...args: string[]) => run('/usr/bin/git', [...ID, ...args], { cwd });
async function setup() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ai-merge-'))); roots.push(temp);
  const repo = join(temp, 'repo'), origin = join(temp, 'origin.git'), home = join(temp, 'home'), bin = join(temp, 'bin');
  await mkdir(repo); await mkdir(home, { mode: 0o700 }); await mkdir(bin);
  await run('/usr/bin/git', ['init', '-q', '-b', 'main', '--', repo]); await writeFile(join(repo, 'readme.md'), 'hello\n');
  await git(repo, 'add', '--', '.'); await git(repo, 'commit', '-qm', 'initial', '--');
  await run('/usr/bin/git', ['init', '-q', '--bare', '--', origin]); await git(repo, 'remote', 'add', '--', 'origin', origin);
  // A gitconfig of the user's own (identity), as git would find it at HOME.
  await writeFile(join(temp, 'gitconfig'), '[user]\n\tname = Yaniv\n\temail = yaniv@example.invalid\n');
  const paths = getPaths(home); await preparePaths(paths);
  const m = new SessionManager(paths, new Logger(paths.log)); managers.push(m); await m.load();
  m.setUserGit({ globalConfig: join(temp, 'gitconfig'), env: { PATH: `${bin}:/usr/bin:/bin`, HOME: temp } });
  const agent = await m.create({ engine: 'codex', model: 'gpt-test', auth: { kind: 'account' }, cwd: repo, permission: 'ask', title: 'fixer' });
  const live = (m as unknown as { sessions: Map<string, { info: SessionInfo }> }).sessions.get(agent.id);
  if (!live) throw new Error('no live'); live.info.status = 'done';
  const tree = agent.worktree ?? '';
  return { temp, repo, origin, home, bin, m, agent, tree };
}
const work = async (tree: string, name: string, text: string) => { await writeFile(join(tree, name), text); await git(tree, 'add', '--', name); await git(tree, 'commit', '-qm', `add ${name}`, '--'); };

it('/merge shows the exact commands, merges with --no-ff into a clean checkout on the base branch, and touches nothing else', async () => {
  const { repo, m, agent, tree } = await setup();
  await work(tree, 'feature.ts', 'export const x = 1;\n');
  const plan = await m.mergePlan(agent.id);
  expect(plan).toMatchObject({ title: 'fixer', branch: 'ai/fixer', base: 'main', ahead: 1, hits: [], commands: [`cd ${repo}`, 'git merge --no-ff --no-edit --no-gpg-sign -- ai/fixer'] });
  const branchesBefore = (await git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', '--', 'refs/heads/')).stdout;
  await m.merge(agent.id, plan.fingerprint, false);
  expect(await readFile(join(repo, 'feature.ts'), 'utf8')).toBe('export const x = 1;\n');
  expect((await git(repo, 'log', '-1', '--format=%P%n%an')).stdout.split('\n').filter(Boolean)[0]?.split(' ')).toHaveLength(2);
  expect((await git(repo, 'log', '-1', '--format=%an')).stdout.trim()).toBe('Yaniv');
  const branchesAfter = (await git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', '--', 'refs/heads/')).stdout;
  expect(branchesAfter.split('\n').filter(l => !l.startsWith('refs/heads/main '))).toEqual(branchesBefore.split('\n').filter(l => !l.startsWith('refs/heads/main ')));
});

it('/merge refuses a dirty checkout or one on another branch, and never switches or stashes for you', async () => {
  const { repo, m, agent, tree } = await setup();
  await work(tree, 'f.ts', 'x\n');
  await writeFile(join(repo, 'readme.md'), 'my own edit\n');
  await expect(m.mergePlan(agent.id)).rejects.toThrow('Your checkout has uncommitted changes; commit or stash them yourself first');
  await git(repo, 'checkout', '-q', '--', 'readme.md'); await git(repo, 'checkout', '-qb', 'other');
  await expect(m.mergePlan(agent.id)).rejects.toThrow('Your checkout is not on main; switch to it yourself first');
  expect((await git(repo, 'branch', '--show-current')).stdout.trim()).toBe('other');
});

it('a conflict is aborted at once: your checkout is left exactly as it was', async () => {
  const { repo, m, agent, tree } = await setup();
  await work(tree, 'readme.md', 'agent version\n');
  await writeFile(join(repo, 'readme.md'), 'my version\n'); await git(repo, 'commit', '-qam', 'mine', '--');
  const head = (await git(repo, 'rev-parse', 'HEAD')).stdout;
  const plan = await m.mergePlan(agent.id);
  await expect(m.merge(agent.id, plan.fingerprint, false)).rejects.toThrow('Merge conflict; it was undone and your checkout is as it was');
  expect((await git(repo, 'rev-parse', 'HEAD')).stdout).toBe(head);
  expect((await git(repo, 'status', '--porcelain')).stdout).toBe('');
  await expect(access(join(repo, '.git', 'MERGE_HEAD'))).rejects.toThrow();
});

it('a repo whose config or attributes name a filter or merge driver is never merged by AI Term', async () => {
  const { temp, repo, m, agent, tree } = await setup();
  const marker = join(temp, 'driver-ran');
  await writeFile(join(tree, '.gitattributes'), '* merge=evil filter=evil\n'); await git(tree, 'add', '--', '.gitattributes'); await git(tree, 'commit', '-qm', 'attrs', '--');
  await git(repo, 'config', 'merge.evil.driver', `/usr/bin/touch ${marker}`); await git(repo, 'config', 'filter.evil.smudge', `/usr/bin/touch ${marker}; /bin/cat`);
  await expect(m.mergePlan(agent.id)).rejects.toThrow('This repo uses git filters or merge drivers; merge it yourself');
  await expect(access(marker)).rejects.toThrow();
});

it('a secret blocks the merge until override is typed; the hit names file and line, never the value', async () => {
  const { repo, m, agent, tree } = await setup();
  await work(tree, 'config.ts', `export const key = "sk-ant-api03-${'Z'.repeat(40)}";\n`);
  const plan = await m.mergePlan(agent.id);
  expect(plan.hits).toEqual([{ file: 'config.ts', line: 1, kind: 'secret assignment', length: expect.any(Number) }]);
  expect(JSON.stringify(plan)).not.toContain('ZZZZ');
  await expect(m.merge(agent.id, plan.fingerprint, false)).rejects.toThrow('Secret scan found possible secrets; type override to go on anyway');
  await expect(access(join(repo, 'config.ts'))).rejects.toThrow();
  await m.merge(agent.id, plan.fingerprint, true);
  await access(join(repo, 'config.ts'));
});

it('the scan can be turned off (D55); a plan is bound to what it showed', async () => {
  const { home, m, agent, tree } = await setup();
  await work(tree, 'config.ts', `export const key = "sk-ant-api03-${'Z'.repeat(40)}";\n`);
  await new SettingsStore(home).set({ secretScan: false });
  const plan = await m.mergePlan(agent.id);
  expect(plan).toMatchObject({ hits: [], scanOff: true });
  await work(tree, 'more.ts', 'y\n');
  await expect(m.merge(agent.id, plan.fingerprint, false)).rejects.toThrow('Changed since you looked; run /merge again');
});

it('/pr pushes ai/<slug> to origin and runs gh pr create in the worktree with argv only; gh missing or logged out is a one-line note', async () => {
  const { origin, bin, m, agent, tree } = await setup();
  await work(tree, 'feature.ts', 'x\n');
  expect((await m.prPlan(agent.id)).gh).toBe('missing');
  const log = join(bin, 'gh.log');
  await writeFile(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${log}\nif [ "$1" = auth ]; then exit \${GH_STUB_AUTH:-0}; fi\necho https://github.com/yaniv/ai-term/pull/7\n`); await chmod(join(bin, 'gh'), 0o755);
  const plan = await m.prPlan(agent.id);
  expect(plan).toMatchObject({ gh: 'ready', branch: 'ai/fixer', base: 'main', remote: origin, commands: [`cd ${tree}`, 'git push -u -- origin ai/fixer', 'gh pr create --head ai/fixer --base main --fill'] });
  const result = await m.pr(agent.id, plan.fingerprint, false);
  expect(result.url).toBe('https://github.com/yaniv/ai-term/pull/7');
  expect((await git(origin, 'for-each-ref', '--format=%(refname)')).stdout).toContain('refs/heads/ai/fixer');
  expect((await readFile(log, 'utf8')).split('\n')).toEqual(expect.arrayContaining(['pr', 'create', '--head', 'ai/fixer', '--base', 'main', '--fill']));
});

it('a push never runs a command the repo config names (ssh command, credential helper, receive-pack)', async () => {
  const { temp, repo, bin, m, agent, tree } = await setup();
  const marker = join(temp, 'push-ran');
  await work(tree, 'feature.ts', 'x\n');
  await writeFile(join(bin, 'gh'), '#!/bin/sh\nif [ "$1" = auth ]; then exit 0; fi\necho https://github.com/yaniv/ai-term/pull/8\n'); await chmod(join(bin, 'gh'), 0o755);
  for (const [key, value] of [['core.sshCommand', `/usr/bin/touch ${marker}`], ['credential.helper', `!/usr/bin/touch ${marker}`], ['remote.origin.receivepack', `/usr/bin/touch ${marker}`]]) await git(repo, 'config', key ?? '', value ?? '');
  const plan = await m.prPlan(agent.id);
  await m.pr(agent.id, plan.fingerprint, false);
  await expect(access(marker)).rejects.toThrow();
});
