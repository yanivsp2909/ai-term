import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { worktreeDiff } from '../src/daemon/diff.js';

// Found by B34 (a test that failed only under load): git trusts an index entry whose size and whole-second times match
// the file, unless the entry is as new as the index file itself ("racily clean"), when it reads the file again. The
// private git dir of a diff copied the index with a fresh mtime, so a same-size edit made in the second the index was
// written looked unchanged there while `git diff` in the worktree saw it.
const run = promisify(execFile), roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => run('/usr/bin/git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd });

it('a same-size edit made in the second the index was written still shows in the diff', async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ai-racy-'))); roots.push(temp);
  const dir = join(temp, 'repo'); await mkdir(dir);
  // Start right after a second begins, so the commit (which writes the index) and the edit share that second.
  await new Promise(done => setTimeout(done, 1000 - (Date.now() % 1000) + 20));
  await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n');
  await run('/usr/bin/git', ['init', '-q', '-b', 'main', '--', dir]); await git(dir, 'add', '--', 'a.ts'); await git(dir, 'commit', '-qm', 'initial', '--');
  await writeFile(join(dir, 'a.ts'), 'export const a = 2;\n');
  const base = (await git(dir, 'rev-parse', 'HEAD')).stdout.trim();
  expect(Date.now() % 1000, 'the setup took the whole second; rerun').toBeGreaterThan(20);
  // The diff runs in a later second, as it would once the agent's turn is over.
  await new Promise(done => setTimeout(done, 1100));
  expect((await git(dir, 'diff', '--name-only')).stdout.trim()).toBe('a.ts');
  const diff = await worktreeDiff(dir, base);
  expect(diff.files.map(file => file.path)).toEqual(['a.ts']);
}, 15_000);
