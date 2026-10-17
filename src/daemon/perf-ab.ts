import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TestOutcome } from './test-run.js';
import type { AbView } from '../shared/addon-results.js';
import { isFsError } from '../shared/paths.js';
import { resolveInside } from '../agent/jail.js';
import { SECRET_FILE } from '../shared/review.js';

// v1.1 /perf's A/B: the same benchmark on the code before (a temporary copy at the agent's start) and after (its
// worktree), back to back on this machine. Rounds alternate the order (ABBA…) so warm caches and drift don't favor a side;
// the medians are what the popup shows. A run that doesn't pass stops the A/B: a failing benchmark measures nothing.
export const AB_ROUNDS = 5, AB_RUN_TIMEOUT_MS = 2 * 60_000;
export interface AbSide { cwd: string; run(): Promise<TestOutcome> }
export async function runAb(before: AbSide, after: AbSide, options: { rounds?: number; now?: () => number; sandbox: boolean }): Promise<Extract<AbView, { state: 'done' | 'failed' }>> {
  const rounds = options.rounds ?? AB_ROUNDS, now = options.now ?? (() => performance.now()), times = { before: [] as number[], after: [] as number[] };
  for (let round = 0; round < rounds; round++) {
    for (const name of round % 2 === 0 ? ['before', 'after'] as const : ['after', 'before'] as const) {
      const side = name === 'before' ? before : after, start = now(), outcome = await side.run(), took = now() - start;
      if (outcome.state !== 'pass') return { state: 'failed', reason: `The benchmark didn't pass on the ${name} code (${outcome.state === 'fail' ? 'it failed' : outcome.state})` };
      times[name].push(took);
    }
  }
  const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] ?? 0 : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2; };
  return { state: 'done', rounds, beforeMs: Math.round(median(times.before)), afterMs: Math.round(median(times.after)), sandbox: options.sandbox };
}
// A new benchmark file from the worktree into the before copy, so both sides run the same harness. Only a regular file
// under bench/ (the model's result says which), at most 1 MB; a path through a link out of either folder is refused. When
// the old code has the file already, each side keeps its own.
export const AB_FILE_MAX = 1024 * 1024;
export async function copyBenchFile(from: string, to: string, file: string): Promise<void> {
  if (!/^bench\//.test(file) || file.split('/').includes('..')) throw new Error('Only new benchmark files under bench/ are copied');
  if (SECRET_FILE.test(file)) throw new Error('A credential or env file is never copied');
  const target = await resolveInside(to, file);
  try { await lstat(target); return; } catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
  // Read through one descriptor opened without following links, so the file checked is the file copied (review).
  const real = await resolveInside(from, file);
  if (real !== join(await realpath(from), file)) throw new Error('A benchmark file is never copied through a link');
  const source = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await source.stat();
    // One link only: a hard link to a file elsewhere would pass the no-follow checks (follow-up review).
    if (!info.isFile() || info.nlink !== 1 || info.size > AB_FILE_MAX) throw new Error('A benchmark file must be a regular file of at most 1 MB, with one link');
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    if (await resolveInside(to, dirname(file)) !== dirname(target)) throw new Error('The benchmark folder changed while it was copied');
    const output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, info.mode & 0o755);
    try { await output.writeFile(await source.readFile()); } finally { await output.close(); }
  } finally { await source.close(); }
}
