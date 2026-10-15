import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isFsError } from '../shared/paths.js';
import { isPlainBranch, isWorktreeBranch } from '../shared/validate.js';
import { MAX_HITS, scanPatch, type SecretHit } from '../shared/secret-scan.js';
import type { MergePlan, PrPlan } from '../shared/merge.js';
import { COMMIT_ID, EMPTY_TREE_ID, GitError, isolatedGitDir, runGit } from './git.js';
import { resolveExecutable } from './engines.js';

// v0.7.3 /merge and /pr. The merge runs in YOUR checkout, so it is the one place AI Term changes it: only when that
// checkout is clean and on the base branch, only `git merge --no-ff -- ai/<slug>`, and a conflict is aborted at once.
// Never checkout, reset, stash, rebase or force; no other branch. Your checkout shares its git config with the agent's
// worktree, so a repo whose config or attributes name a filter or merge driver (commands git would run) is refused:
// you merge it yourself. Your own global git config (identity, credentials, ssh) is used as is.
export class MergeError extends Error {}
export const MERGE_ERRORS = ['Your checkout has uncommitted changes; commit or stash them yourself first', 'This repo uses git filters or merge drivers; merge it yourself',
  'Nothing to merge; the branch has no commits beyond the base', 'Changed since you looked; run /merge again', 'Changed since you looked; run /pr again',
  'Secret scan found possible secrets; type override to go on anyway', 'Merge conflict; it was undone and your checkout is as it was', 'Git refused the merge; your checkout is as it was',
  'Merge unavailable; git could not read the repository', 'This repo has no origin remote', 'gh is missing or not logged in', 'Push failed; nothing was opened',
  'gh pr create failed; the branch is pushed', 'This agent has no worktree branch to merge', 'Merge conflict; undoing it failed: run git merge --abort in your checkout',
  "Your checkout's git folder isn't a plain .git folder; merge it yourself"] as const;
export const CHECKOUT_NOT_ON_BASE = /^Your checkout is not on [A-Za-z0-9._/-]{1,200}; switch to it yourself first$/;
// The user's own git: where their global config is, and the environment git, ssh and gh need (PATH, HOME, the ssh
// agent socket). Never a key: these processes run as you, with what you set up yourself.
export interface UserGit { globalConfig: string; env: Record<string, string> }
export interface MergeTarget { title: string; repo: string; worktree: string; branch: string; base: string; scan: boolean }
const BIG = 16 * 1024 * 1024;
const userRun = (cwd: string, args: string[], user: UserGit, timeout = 120_000) => runGit(cwd, args, 'Git check failed', { env: { ...user.env, ...PINNED_ENV, GIT_CONFIG_GLOBAL: user.globalConfig }, timeout, maxBuffer: BIG });
const sha = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
// Your checkout, named outright: the shared config's core.worktree (which an agent can set) can't send a status, merge
// or abort to another folder, and the git folder is its own .git, never one a .git file points at.
const checkout = (t: MergeTarget) => [`--git-dir=${join(t.repo, '.git')}`, `--work-tree=${t.repo}`];
// Commands git runs for credentials and fsmonitor: off, whatever any config says (environment config beats the repo's).
const PINNED_ENV: Record<string, string> = { GIT_ASKPASS: '/usr/bin/false', GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null', GIT_CONFIG_KEY_2: 'core.askPass', GIT_CONFIG_VALUE_2: '/usr/bin/false' };
async function plainGitFolder(t: MergeTarget): Promise<void> {
  let info;
  try { info = await lstat(join(t.repo, '.git')); } catch (error) { if (isFsError(error, 'ENOENT')) throw new MergeError("Your checkout's git folder isn't a plain .git folder; merge it yourself"); throw error; }
  if (!info.isDirectory()) throw new MergeError("Your checkout's git folder isn't a plain .git folder; merge it yourself");
}

function checkTarget(t: MergeTarget): void { if (!isWorktreeBranch(t.branch) || !isPlainBranch(t.base)) throw new MergeError('This agent has no worktree branch to merge'); }
async function commitOf(repo: string, ref: string): Promise<string> {
  const id = (await runGit(repo, [`--git-dir=${join(repo, '.git')}`, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])).trim();
  if (!COMMIT_ID.test(id)) throw new MergeError('Merge unavailable; git could not read the repository');
  return id;
}
// Commands git could run during a merge or checkout in your checkout: refused before anything runs.
async function drivers(repo: string, base: string, branch: string): Promise<boolean> {
  let configured = '';
  try { configured = await runGit(repo, [`--git-dir=${join(repo, '.git')}`, 'config', '--name-only', '--get-regexp', '^(filter|merge)\\.']); } catch (error) { if (!(error instanceof GitError)) throw error; }
  if (configured.trim()) return true;
  try { if ((await lstat(join(repo, '.git', 'info', 'attributes'))).size > 0) return true; } catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
  for (const commit of [base, branch]) {
    const names = (await runGit(repo, [`--git-dir=${join(repo, '.git')}`, 'ls-tree', '-r', '-z', '--name-only', '--full-tree', '--end-of-options', commit], 'Git check failed', { maxBuffer: BIG })).split('\0').filter(name => name === '.gitattributes' || name.endsWith('/.gitattributes'));
    for (const name of names) if (/\b(?:filter|merge)=/.test(await runGit(repo, [`--git-dir=${join(repo, '.git')}`, 'cat-file', 'blob', `${commit}:${name}`], 'Git check failed', { maxBuffer: BIG }))) return true;
  }
  return false;
}
// What leaves: the branch's changes since it forked from the base, from the trees alone (no work tree, no filter).
async function scan(t: MergeTarget, baseCommit: string, branchCommit: string): Promise<{ hits: SecretHit[]; more: number }> {
  if (!t.scan) return { hits: [], more: 0 };
  const git = await isolatedGitDir(t.worktree, undefined, { repo: t.repo });
  try {
    const fork = (await runGit(t.worktree, [...git.args, 'merge-base', '--end-of-options', baseCommit, branchCommit], 'Git check failed', { env: git.env })).trim();
    if (!COMMIT_ID.test(fork)) throw new MergeError('Merge unavailable; git could not read the repository');
    const patch = await runGit(t.worktree, [...git.args, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=0', '--end-of-options', fork, branchCommit, '--'], 'Git check failed', { env: git.env, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
    const all = scanPatch(patch, MAX_HITS + 1);
    return { hits: all.slice(0, MAX_HITS), more: Math.max(0, all.length - MAX_HITS) };
  } finally { await git.dispose(); }
}
interface MergeState { plan: MergePlan; baseCommit: string; branchCommit: string }
async function mergeState(t: MergeTarget): Promise<MergeState> {
  checkTarget(t); await plainGitFolder(t);
  const head = (await runGit(t.repo, [...checkout(t), 'symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim();
  if (head !== `refs/heads/${t.base}`) throw new MergeError(`Your checkout is not on ${t.base}; switch to it yourself first`);
  const baseCommit = await commitOf(t.repo, `refs/heads/${t.base}`), branchCommit = await commitOf(t.repo, `refs/heads/${t.branch}`);
  if (await drivers(t.repo, baseCommit, branchCommit)) throw new MergeError('This repo uses git filters or merge drivers; merge it yourself');
  // Attributes off as a second guard: with no driver configured nothing could run anyway.
  const dirty = await runGit(t.repo, [...checkout(t), `--attr-source=${EMPTY_TREE_ID}`, '-c', 'core.attributesFile=/dev/null', 'status', '--porcelain', '--untracked-files=no', '--ignore-submodules=all', '--']);
  if (dirty.trim()) throw new MergeError('Your checkout has uncommitted changes; commit or stash them yourself first');
  const ahead = Number((await runGit(t.repo, [...checkout(t), 'rev-list', '--count', '--end-of-options', `${baseCommit}..${branchCommit}`])).trim());
  if (!ahead) throw new MergeError('Nothing to merge; the branch has no commits beyond the base');
  const found = await scan(t, baseCommit, branchCommit);
  const plan: MergePlan = { title: t.title, branch: t.branch, base: t.base, repo: t.repo, ahead, commands: [`cd ${t.repo}`, `git merge --no-ff --no-edit --no-gpg-sign -- ${t.branch}`], hits: found.hits, moreHits: found.more, ...(t.scan ? {} : { scanOff: true as const }), fingerprint: '' };
  plan.fingerprint = sha('merge', baseCommit, branchCommit, found, t.scan);
  return { plan, baseCommit, branchCommit };
}
export async function mergePlan(t: MergeTarget): Promise<MergePlan> { return (await mergeState(t)).plan; }
export async function merge(t: MergeTarget, fingerprint: string, override: boolean, user: UserGit): Promise<{ commit: string }> {
  const { plan, baseCommit } = await mergeState(t).catch((error: unknown) => { throw error instanceof MergeError && error.message.startsWith('Nothing to merge') ? new MergeError('Changed since you looked; run /merge again') : error; });
  if (plan.fingerprint !== fingerprint) throw new MergeError('Changed since you looked; run /merge again');
  if (plan.hits.length && !override) throw new MergeError('Secret scan found possible secrets; type override to go on anyway');
  // Checked again last, right before git runs: a driver added since the plan refuses (a background process could still
  // race this; agents are refused while they run or ask).
  if (await drivers(t.repo, baseCommit, await commitOf(t.repo, `refs/heads/${t.branch}`))) throw new MergeError('This repo uses git filters or merge drivers; merge it yourself');
  try { await userRun(t.repo, [...checkout(t), `--attr-source=${EMPTY_TREE_ID}`, '-c', 'core.attributesFile=/dev/null', 'merge', '--no-ff', '--no-edit', '--no-gpg-sign', '--', t.branch], user); }
  catch (failure) {
    // Never left mid-merge: a conflict is aborted at once.
    let conflicted = false;
    try { await lstat(join(t.repo, '.git', 'MERGE_HEAD')); conflicted = true; } catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
    if (conflicted) {
      try { await userRun(t.repo, [...checkout(t), 'merge', '--abort'], user); } catch (error) { throw new MergeError('Merge conflict; undoing it failed: run git merge --abort in your checkout', { cause: error }); }
      throw new MergeError('Merge conflict; it was undone and your checkout is as it was', { cause: failure });
    }
    if (await commitOf(t.repo, 'HEAD') !== baseCommit) throw new MergeError('Merge unavailable; git could not read the repository', { cause: failure });
    throw new MergeError('Git refused the merge; your checkout is as it was', { cause: failure });
  }
  return { commit: await commitOf(t.repo, 'HEAD') };
}

// ---- /pr ----
// Your global config's own credential helpers and ssh command, so the repo's config (which an agent can write) can't
// put its own command in their place for this push; the ext transport is off and receive-pack pinned on the command.
async function pushGuards(user: UserGit): Promise<string[]> {
  const read = (key: string) => runGit('/', ['config', '--file', user.globalConfig, '--get-all', key]).then(out => out.split('\n').filter(Boolean), () => [] as string[]);
  const helpers = await read('credential.helper'), ssh = (await read('core.sshCommand')).at(-1) ?? 'ssh';
  return ['-c', `core.sshCommand=${ssh}`, '-c', 'credential.helper=', ...helpers.flatMap(h => ['-c', `credential.helper=${h}`]), '-c', 'protocol.ext.allow=never', '-c', 'core.askPass=/usr/bin/false'];
}
async function ghStatus(user: UserGit): Promise<{ state: PrPlan['gh']; path: string | null }> {
  const path = await resolveExecutable('gh', user.env.PATH ?? '');
  if (!path) return { state: 'missing', path: null };
  const ok = await new Promise<boolean>(resolve => execFile(path, ['auth', 'status'], { env: { ...user.env, ...PINNED_ENV }, timeout: 15_000 }, error => resolve(!error)));
  return { state: ok ? 'ready' : 'logged out', path };
}
async function prState(t: MergeTarget, user: UserGit): Promise<{ plan: PrPlan; gh: string | null }> {
  checkTarget(t); await plainGitFolder(t);
  // Read from your checkout with your global config, so the URL shown is where the push really goes (insteadOf included).
  const remote = (await userRun(t.repo, [`--git-dir=${join(t.repo, '.git')}`, 'remote', 'get-url', '--push', '--', 'origin'], user).catch(() => '')).trim();
  if (!remote) throw new MergeError('This repo has no origin remote');
  const baseCommit = await commitOf(t.repo, `refs/heads/${t.base}`), branchCommit = await commitOf(t.repo, `refs/heads/${t.branch}`), gh = await ghStatus(user), found = await scan(t, baseCommit, branchCommit);
  const plan: PrPlan = { title: t.title, branch: t.branch, base: t.base, remote, gh: gh.state, commands: [`cd ${t.worktree}`, `git push -u -- origin ${t.branch}`, `gh pr create --head ${t.branch} --base ${t.base} --fill`], hits: found.hits, moreHits: found.more, ...(t.scan ? {} : { scanOff: true as const }), fingerprint: '' };
  plan.fingerprint = sha('pr', branchCommit, remote, found, t.scan, gh.state);
  plan.commands = [`cd ${t.repo}`, `git push -u -- origin refs/heads/${t.branch}:refs/heads/${t.branch}`, `gh pr create --head ${t.branch} --base ${t.base} --fill`];
  return { plan, gh: gh.path };
}
export async function prPlan(t: MergeTarget, user: UserGit): Promise<PrPlan> { return (await prState(t, user)).plan; }
export async function openPr(t: MergeTarget, fingerprint: string, override: boolean, user: UserGit): Promise<{ url: string }> {
  const { plan, gh } = await prState(t, user);
  if (plan.fingerprint !== fingerprint) throw new MergeError('Changed since you looked; run /pr again');
  if (plan.gh !== 'ready' || !gh) throw new MergeError('gh is missing or not logged in');
  if (plan.hits.length && !override) throw new MergeError('Secret scan found possible secrets; type override to go on anyway');
  // From your checkout's own .git (the worktree's .git file is the agent's), with an explicit refspec. --receive-pack:
  // git keeps the FIRST receivepack value it reads (the repo's), so -c can't pin it; a local remote runs it here, hooks
  // off; a remote host is sent the standard command (GitHub's ssh accepts only that).
  const local = /^(?:\/|\.|file:)/.test(plan.remote) || !/[:@]/.test(plan.remote), receivePack = local ? 'git -c core.hooksPath=/dev/null receive-pack' : 'git-receive-pack';
  try { await userRun(t.repo, [`--git-dir=${join(t.repo, '.git')}`, ...await pushGuards(user), 'push', `--receive-pack=${receivePack}`, '-u', '--', 'origin', `refs/heads/${t.branch}:refs/heads/${t.branch}`], user); }
  catch (error) { throw new MergeError('Push failed; nothing was opened', { cause: error }); }
  // gh runs in your checkout too, its own git calls pinned to that .git folder and work tree, fsmonitor, hooks and askpass off.
  const out = await new Promise<string | null>(resolve => execFile(gh, ['pr', 'create', '--head', t.branch, '--base', t.base, '--fill'], { cwd: t.repo, env: { ...user.env, ...PINNED_ENV, GIT_DIR: join(t.repo, '.git'), GIT_WORK_TREE: t.repo }, timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve(error ? null : stdout)));
  const url = out?.split('\n').map(line => line.trim()).filter(line => /^https:\/\/\S{1,500}$/.test(line)).at(-1);
  if (!url) throw new MergeError('gh pr create failed; the branch is pushed');
  return { url };
}
