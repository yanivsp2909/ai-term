import { COMMIT_ID, GitError, runGit } from './git.js';
import { GIT } from './git-path.js';
import { runTests, type TestOutcome } from './test-run.js';
import { tempClone } from './temp-clone.js';
import type { PreparedSandbox } from './test-sandbox.js';
import { MAX_TEST_WORDS, parseTestCommand, testCommandText } from '../shared/test-run.js';
import type { AddonResult } from '../shared/addon-results.js';

// v1.1 /bisect <test command> [good ref]: no model, no tokens. Your checkout is only read (rev-parse, rev-list); the
// bisect itself runs in a temporary clone (temp-clone.ts) under the test sandbox (D56), and always ends with
// `git bisect reset` and the clone removed.
export class BisectError extends Error {}
export const BISECT_DEFAULT_BACK = 32, BISECT_STEP_TIMEOUT_MS = 10 * 60_000, BISECT_TIMEOUT_MS = 60 * 60_000, BISECT_DIFF_LINES = 400;
export interface BisectPlan { command: string[]; good: string; bad: string; goodLabel: string; commits: number }
type Run = (command: readonly string[], cwd: string, env: Record<string, string>, box: PreparedSandbox | null, timeoutMs: number) => Promise<TestOutcome>;
export interface BisectOptions { repo: string; plan: BisectPlan; sandbox: (path: string) => Promise<PreparedSandbox | null>; unsandboxed: boolean; env: Record<string, string>; run?: Run; log: (text: string) => void }

const commitOf = async (cwd: string, ref: string): Promise<string | null> => {
  // A ref the user typed: --end-of-options keeps it from reading as an option, ^{commit} from naming a tree.
  try { const id = (await runGit(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])).trim(); return COMMIT_ID.test(id) ? id : null; }
  // rev-parse --verify --quiet exits 1 for a word that names no commit: that word is part of the command.
  catch (error) { if (error instanceof GitError) return null; throw error; }
};
// The words are the test command; a last word that names a commit is the good ref. Without one, the good side is the
// commit BISECT_DEFAULT_BACK first-parent steps back (or the first commit). The popup shows both before anything runs.
export async function bisectPlan(repo: string, args: string): Promise<BisectPlan> {
  const words = parseTestCommand(args);
  // git bisect run adds five words of its own in front of the command, within the runner's word limit.
  if (!words || words.length > MAX_TEST_WORDS - 5) throw new BisectError('/bisect <test command> [good ref] · no shell: pipes and && are plain words');
  const bad = await commitOf(repo, 'HEAD'); if (!bad) throw new BisectError('This repository has no commits to bisect');
  const last = words.length > 1 ? words.at(-1) ?? '' : '', named = last && !last.startsWith('-') ? await commitOf(repo, last) : null;
  const command = named ? words.slice(0, -1) : words;
  let good = named, goodLabel = named ? last : '';
  if (!good) {
    const back = (await runGit(repo, ['rev-list', '--first-parent', `--max-count=${BISECT_DEFAULT_BACK + 1}`, '--end-of-options', bad, '--'])).trim().split('\n');
    good = back.at(-1) ?? null; goodLabel = back.length > BISECT_DEFAULT_BACK ? `HEAD~${BISECT_DEFAULT_BACK}` : 'the first commit';
  }
  if (!good || good === bad) throw new BisectError('Nothing to bisect: the good ref is HEAD itself');
  try { await runGit(repo, ['merge-base', '--is-ancestor', '--end-of-options', good, bad]); }
  catch { throw new BisectError(`${goodLabel} isn't an ancestor of HEAD; pick an older good ref`); }
  const commits = Number((await runGit(repo, ['rev-list', '--count', '--end-of-options', `${good}..${bad}`, '--'])).trim());
  return { command, good, bad, goodLabel, commits };
}

const realRun: Run = (command, cwd, env, box, timeoutMs) => runTests(command, cwd, { ...env, ...box?.env }, { timeoutMs, ...(box ? { sandbox: box } : {}) });
const why = (outcome: TestOutcome): string => outcome.state === 'timeout' ? 'it timed out' : outcome.state === 'blocked' ? `the sandbox stopped it (${outcome.what})` : outcome.state === 'nosandbox' ? 'the sandbox refused to start' : "it couldn't start";
// git's own text from the copy, made safe to show: no escape sequences, no carriage returns, lines cut to 400 bytes.
const shown = (text: string): string[] => text.replace(/\r/g, '').split('\n').slice(0, BISECT_DIFF_LINES).map(l => Buffer.from(l.replace(/[\p{C}]/gu, c => c === '\t' ? '\t' : '?')).subarray(0, 400).toString('utf8').replace(/�$/, ''));

export async function runBisect(options: BisectOptions): Promise<Extract<AddonResult, { kind: 'bisect' }>> {
  const { plan, log } = options, run = options.run ?? realRun, env = options.env;
  const copy = await tempClone(options.repo, plan.bad);
  let box: PreparedSandbox | null = null, started = false;
  try {
    box = await options.sandbox(copy.path);
    if (!box && !options.unsandboxed) throw new BisectError('No sandbox here · open /bisect again and press Y to run the test command with your rights');
    const test = async (at: string): Promise<TestOutcome> => {
      await runGit(copy.path, ['checkout', '--quiet', '--detach', '--end-of-options', at]);
      return run(plan.command, copy.path, env, box, BISECT_STEP_TIMEOUT_MS);
    };
    const atBad = await test(plan.bad);
    if (atBad.state === 'pass') throw new BisectError(`${testCommandText(plan.command)} passes at HEAD; nothing to bisect`);
    if (atBad.state !== 'fail') throw new BisectError(`The test command didn't run at HEAD: ${why(atBad)}`);
    const atGood = await test(plan.good);
    if (atGood.state === 'fail') throw new BisectError(`${testCommandText(plan.command)} also fails at ${plan.goodLabel}; pick an older good ref`);
    if (atGood.state !== 'pass') throw new BisectError(`The test command didn't run at ${plan.goodLabel}: ${why(atGood)}`);
    started = true;
    // bisect start reads its own argv and refuses --end-of-options; both ids are checked commit hashes, and -- ends them.
    await runGit(copy.path, ['bisect', 'start', plan.bad, plan.good, '--']);
    // git runs each step itself (exit 0 good, 125 skip, other bad) inside the sandbox, with the same argv as above.
    const gitArgv = [GIT ?? 'git', '-c', 'core.hooksPath=/dev/null', 'bisect', 'run', ...plan.command];
    const outcome = await run(gitArgv, copy.path, env, box, BISECT_TIMEOUT_MS);
    if (outcome.state !== 'pass') throw new BisectError(outcome.state === 'fail' ? 'git bisect run could not decide (a step skipped or the command failed to start)' : `git bisect run stopped: ${why(outcome)}`);
    const commit = (await runGit(copy.path, ['rev-parse', '--verify', '--end-of-options', 'refs/bisect/bad'])).trim();
    if (!COMMIT_ID.test(commit)) throw new BisectError('git bisect run finished without a first bad commit');
    const [subject = '', author = '', date = ''] = (await runGit(copy.path, ['log', '-1', '--no-color', '--format=%s%x00%an%x00%cI', '--end-of-options', commit, '--'])).replace(/\n$/, '').split('\0');
    const steps = (await runGit(copy.path, ['bisect', 'log'])).split('\n').filter(l => /^git bisect (?:good|bad|skip) /.test(l)).length;
    const diff = await runGit(copy.path, ['show', '--no-color', '--no-ext-diff', '--no-textconv', '--stat', '--patch', '--format=', '--end-of-options', commit, '--'], 'Git check failed', { maxBuffer: 16 * 1024 * 1024 });
    const one = (v: string) => shown(v)[0] || '(none)';
    return { kind: 'bisect', commit, subject: one(subject), author: one(author), date: one(date), steps, diff: shown(diff) };
  } finally {
    // Always: the copy's bisect state is reset, then the copy is removed (it holds no work of yours).
    if (started) await runGit(copy.path, ['bisect', 'reset']).catch(() => log('Bisect: git bisect reset failed in the temporary copy; the copy is removed anyway'));
    await box?.dispose().catch(() => log('Test sandbox: its temp folder could not be removed'));
    await copy.dispose().catch(() => log('Bisect: the temporary copy could not be removed'));
  }
}
