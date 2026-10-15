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
export const MERGE_ERRORS = ['origin has more than one push URL; push it yourself', 'Your checkout is in the middle of a merge, cherry-pick, revert or rebase; finish it yourself first', 'Your checkout has uncommitted changes; commit or stash them yourself first', 'This repo uses git filters or merge drivers; merge it yourself',
  'Nothing to merge; the branch has no commits beyond the base', 'Changed since you looked; run /merge again', 'Changed since you looked; run /pr again',
  'Secret scan found possible secrets; type override to go on anyway', 'Merge conflict; it was undone and your checkout is as it was', 'Git refused the merge; your checkout is as it was',
  'Merge unavailable; git could not read the repository', 'This repo has no origin remote', 'gh is missing or not logged in', 'Push failed; nothing was opened',
  'gh pr create failed; the branch is pushed', 'This agent has no worktree branch to merge', 'Merge conflict; undoing it failed: run git merge --abort in your checkout',
  "Your checkout's git folder isn't a plain .git folder; merge it yourself", 'This remote uses the git:// protocol; push it yourself'] as const;
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
    // --text: a file with a NUL byte or a -diff attribute is scanned as text too (git would only say "Binary files differ").
    const options = ['--no-ext-diff', '--no-textconv', '--no-color', '--text', '--unified=0'], read = { env: git.env, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 };
    const patch = await runGit(t.worktree, [...git.args, 'diff', ...options, '--end-of-options', fork, branchCommit, '--'], 'Git check failed', read);
    // Every commit that leaves, one by one: a secret added and then removed is still in the history a PR or merge carries.
    const history = await runGit(t.worktree, [...git.args, 'log', '-p', '--no-merges', '--format=', ...options, '--end-of-options', `${fork}..${branchCommit}`, '--'], 'Git check failed', read);
    const seen = new Set<string>(), all = [...scanPatch(patch, MAX_HITS + 1), ...scanPatch(history, MAX_HITS + 1)].filter(hit => { const key = `${hit.file}\0${hit.line}\0${hit.kind}`; if (seen.has(key)) return false; seen.add(key); return true; });
    return { hits: all.slice(0, MAX_HITS), more: Math.max(0, all.length - MAX_HITS) };
  } finally { await git.dispose(); }
}
interface MergeState { plan: MergePlan; baseCommit: string; branchCommit: string }
async function mergeState(t: MergeTarget): Promise<MergeState> {
  checkTarget(t); await plainGitFolder(t);
  // A merge, cherry-pick, revert or rebase of yours in progress is yours to finish: never merged into, never aborted.
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    try { await lstat(join(t.repo, '.git', name)); throw new MergeError('Your checkout is in the middle of a merge, cherry-pick, revert or rebase; finish it yourself first'); }
    catch (error) { if (error instanceof MergeError || !isFsError(error, 'ENOENT')) throw error; }
  }
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
// Your own config's credential settings (system, then global, includes followed, URL-scoped ones too: `gh auth
// setup-git` writes those) and ssh command, re-applied after an empty helper resets the list, so the repo's config
// (which an agent can write) can't put its own command in their place for this push. Also off: the ext transport,
// askpass, core.gitProxy, submodule pushes (they'd run with each submodule's config) and signed pushes (gpg.program).
async function ownCredential(args: string[]): Promise<string[]> {
  const out = await runGit('/', ['config', '--includes', ...args, '--get-regexp', '^credential\\.'], 'Git check failed', { env: { GIT_CONFIG_NOSYSTEM: '0' } }).catch(() => '');
  return out.split('\n').filter(Boolean).map(line => { const at = line.indexOf(' '); return at < 0 ? `${line}=true` : `${line.slice(0, at)}=${line.slice(at + 1)}`; });
}
export async function pushGuardArgs(user: UserGit): Promise<string[]> {
  const credentials = [...await ownCredential(['--system']), ...await ownCredential(['--file', user.globalConfig])];
  const ssh = (await runGit('/', ['config', '--file', user.globalConfig, '--get-all', 'core.sshCommand']).then(out => out.split('\n').filter(Boolean), () => [] as string[])).at(-1) ?? 'ssh';
  return ['-c', `core.sshCommand=${ssh}`, '-c', 'credential.helper=', ...credentials.flatMap(pair => ['-c', pair]), '-c', 'protocol.ext.allow=never', '-c', 'core.askPass=/usr/bin/false',
    '-c', 'core.gitProxy=', '-c', 'push.recurseSubmodules=no', '-c', 'push.gpgSign=false'];
}
async function ghStatus(user: UserGit): Promise<{ state: PrPlan['gh']; path: string | null }> {
  const path = await resolveExecutable('gh', user.env.PATH ?? '');
  if (!path) return { state: 'missing', path: null };
  const ok = await new Promise<boolean>(resolve => execFile(path, ['auth', 'status'], { env: { ...user.env, ...PINNED_ENV }, timeout: 15_000 }, error => resolve(!error)));
  return { state: ok ? 'ready' : 'logged out', path };
}
// host/owner/repo from an https, ssh or scp-style URL (credentials and .git dropped); null for anything else (a local path).
export function githubRepo(url: string): string | null {
  const match = url.match(/^(?:https?:\/\/(?:[^/@]*@)?|ssh:\/\/(?:[^/@]*@)?|[A-Za-z0-9._-]+@)([A-Za-z0-9.-]+)(?::\d+)?[:/]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}/${match[3]}` : null;
}
async function prState(t: MergeTarget, user: UserGit): Promise<{ plan: PrPlan; gh: string | null; remote: string; ghArgs: string[] }> {
  checkTarget(t); await plainGitFolder(t);
  // Read from your checkout with your global config, so the URL shown is where the push really goes (insteadOf included).
  // --all: git pushes to every push URL (or every url) of origin, so more than one means a push you didn't see; refused.
  const remotes = (await userRun(t.repo, [`--git-dir=${join(t.repo, '.git')}`, 'remote', 'get-url', '--push', '--all', '--', 'origin'], user).catch(() => '')).split('\n').map(line => line.trim()).filter(Boolean);
  if (remotes.length > 1) throw new MergeError('origin has more than one push URL; push it yourself');
  const remote = remotes[0] ?? '';
  if (!remote) throw new MergeError('This repo has no origin remote');
  // git:// runs core.gitProxy (a command the repo config could name) and carries no authentication: not pushed by AI Term.
  if (/^git:\/\//i.test(remote)) throw new MergeError('This remote uses the git:// protocol; push it yourself');
  const baseCommit = await commitOf(t.repo, `refs/heads/${t.base}`), branchCommit = await commitOf(t.repo, `refs/heads/${t.branch}`), gh = await ghStatus(user), found = await scan(t, baseCommit, branchCommit);
  // The client sees the URL with any password masked; gh is pinned to the GitHub repository that URL names, so the PR
  // opens where the push goes (not where the repo config's other remotes would point gh).
  const shown = remote.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/:@]+):[^/@]*@/i, '$1:…@'), repo = githubRepo(remote), ghArgs = [...(repo ? ['--repo', repo] : []), '--head', t.branch, '--base', t.base, '--fill'];
  const plan: PrPlan = { title: t.title, branch: t.branch, base: t.base, remote: shown, gh: gh.state, commands: [`cd ${t.worktree}`, `git push -u -- origin ${t.branch}`, `gh pr create --head ${t.branch} --base ${t.base} --fill`], hits: found.hits, moreHits: found.more, ...(t.scan ? {} : { scanOff: true as const }), fingerprint: '' };
  plan.fingerprint = sha('pr', branchCommit, remote, found, t.scan, gh.state);
  plan.commands = [`cd ${t.repo}`, `git push -u -- origin refs/heads/${t.branch}:refs/heads/${t.branch}`, `gh pr create ${ghArgs.join(' ')}`];
  return { plan, gh: gh.path, remote, ghArgs };
}
export async function prPlan(t: MergeTarget, user: UserGit): Promise<PrPlan> { return (await prState(t, user)).plan; }
export async function openPr(t: MergeTarget, fingerprint: string, override: boolean, user: UserGit): Promise<{ url: string }> {
  const { plan, gh, remote, ghArgs } = await prState(t, user);
  if (plan.fingerprint !== fingerprint) throw new MergeError('Changed since you looked; run /pr again');
  if (plan.gh !== 'ready' || !gh) throw new MergeError('gh is missing or not logged in');
  if (plan.hits.length && !override) throw new MergeError('Secret scan found possible secrets; type override to go on anyway');
  // From your checkout's own .git (the worktree's .git file is the agent's), with an explicit refspec. --receive-pack:
  // git keeps the FIRST receivepack value it reads (the repo's), so -c can't pin it; a local remote runs it here, hooks
  // off; a remote host is sent the standard command (GitHub's ssh accepts only that).
  const local = /^(?:\/|\.|file:)/.test(remote) || !/[:@]/.test(remote), receivePack = local ? 'git -c core.hooksPath=/dev/null receive-pack' : 'git-receive-pack';
  try { await userRun(t.repo, [`--git-dir=${join(t.repo, '.git')}`, ...await pushGuardArgs(user), 'push', `--receive-pack=${receivePack}`, '--no-recurse-submodules', '--no-signed', '--no-follow-tags', '-u', '--', 'origin', `refs/heads/${t.branch}:refs/heads/${t.branch}`], user); }
  catch (error) { throw new MergeError('Push failed; nothing was opened', { cause: error }); }
  // gh runs in your checkout too, its own git calls pinned to that .git folder and work tree, fsmonitor, hooks and askpass off.
  const out = await new Promise<string | null>(resolve => execFile(gh, ['pr', 'create', ...ghArgs], { cwd: t.repo, env: { ...user.env, ...PINNED_ENV, GIT_DIR: join(t.repo, '.git'), GIT_WORK_TREE: t.repo }, timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve(error ? null : stdout)));
  const url = out?.split('\n').map(line => line.trim()).filter(line => /^https:\/\/\S{1,500}$/.test(line)).at(-1);
  if (!url) throw new MergeError('gh pr create failed; the branch is pushed');
  return { url };
}
