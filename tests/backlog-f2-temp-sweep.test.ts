import { afterEach, expect, it } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OWNER_FILE, ownTempFolder, sweepTemp } from '../src/daemon/temp-sweep.js';
import { tempClone } from '../src/daemon/temp-clone.js';

// Backlog F2 (v0.7 gate LOW, B33 suggestion): a daemon that died mid-run left its temporary copies and clones behind.
// At start the daemon removes only AI Term's own: a folder with one of its names, a real folder (never a link) owned by
// you, holding AI Term's owner file for a process that no longer runs. Nothing else is touched, and no link is followed.
const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { await exec('/bin/chmod', ['-R', 'u+rwX', root]).catch(() => undefined); await rm(root, { recursive: true, force: true }); } });
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-f2-'))); roots.push(dir); return dir; }
const present = async (path: string) => { try { await lstat(path); return true; } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; } };
const DEAD = 999_999;
async function folder(dir: string, name: string, owner: number | null): Promise<string> {
  const path = join(dir, name); await mkdir(path); await writeFile(join(path, 'file.txt'), 'x');
  if (owner !== null) await writeFile(join(path, OWNER_FILE), `ai-term ${owner}\n`);
  return path;
}

it("removes only AI Term's own leftovers from a dead run, and never follows a link", async () => {
  const dir = await temp(), outside = await temp(), logs: string[] = [];
  await writeFile(join(outside, 'yours.txt'), 'keep me');
  const dead = await folder(dir, 'ai-term-clone-aaaaaa', DEAD);
  await symlink(join(outside, 'yours.txt'), join(dead, 'link-out')); await mkdir(join(dead, 'repo', 'node_modules'), { recursive: true }); await chmod(join(dead, 'repo', 'node_modules'), 0o500);
  const deadTest = await folder(dir, 'ai-term-test-bbbbbb', DEAD), deadDeps = await folder(dir, 'ai-term-deps-cccccc', DEAD), deadDiff = await folder(dir, 'ai-term-diff-dddddd', DEAD);
  const live = await folder(dir, 'ai-term-clone-eeeeee', process.pid);
  const unmarked = await folder(dir, 'ai-term-clone-ffffff', null);
  const otherName = await folder(dir, 'ai-term-desktop-gggggg', DEAD), lookalike = await folder(dir, 'ai-term-clone-too-long-name', DEAD);
  const forged = await folder(dir, 'ai-term-test-hhhhhh', null); await writeFile(join(forged, OWNER_FILE), 'someone else 12\n');
  const markerLink = await folder(dir, 'ai-term-test-iiiiii', null); await writeFile(join(outside, 'marker'), `ai-term ${DEAD}\n`); await symlink(join(outside, 'marker'), join(markerLink, OWNER_FILE));
  // A link with AI Term's name, to a folder that looks like a dead run's: neither the link nor its target is touched.
  const target = await folder(outside, 'target', DEAD); await symlink(target, join(dir, 'ai-term-clone-jjjjjj'));
  const removed = await sweepTemp({ dir, log: text => logs.push(text) });
  expect(removed).toBe(4);
  for (const path of [dead, deadTest, deadDeps, deadDiff]) expect(await present(path), path).toBe(false);
  for (const path of [live, unmarked, otherName, lookalike, forged, markerLink, join(dir, 'ai-term-clone-jjjjjj'), target, join(target, OWNER_FILE)]) expect(await present(path), path).toBe(true);
  expect(await readFile(join(outside, 'yours.txt'), 'utf8')).toBe('keep me');
  expect(logs).toEqual(['Temp sweep: removed 4 temporary folders a stopped AI Term left behind']);
  // Nothing of its own to remove: nothing is logged.
  expect(await sweepTemp({ dir, log: text => logs.push(text) })).toBe(0); expect(logs).toHaveLength(1);
});

it("a process that still runs, or one AI Term can't signal, keeps its folders", async () => {
  const dir = await temp();
  const kept = await folder(dir, 'ai-term-clone-kkkkkk', 4242);
  expect(await sweepTemp({ dir, log: () => {}, alive: pid => pid === 4242 })).toBe(0);
  expect(await present(kept)).toBe(true);
});

it("AI Term's temp folders carry its owner file from the moment they are made", async () => {
  const dir = await temp(), made = await ownTempFolder('test', dir);
  expect(made.startsWith(join(dir, 'ai-term-test-'))).toBe(true);
  expect(await readFile(join(made, OWNER_FILE), 'utf8')).toBe(`ai-term ${process.pid}\n`);
  expect((await lstat(join(made, OWNER_FILE))).mode & 0o777).toBe(0o600);
  // /bisect's and /perf's copy: its folder is one of them.
  const repo = join(dir, 'repo'); await mkdir(repo); await exec('/usr/bin/git', ['init', '-q', '-b', 'main', '--', repo]);
  await exec('/usr/bin/git', ['-c', 'user.name=T', '-c', 'user.email=t@e.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'c', '--allow-empty'], { cwd: repo });
  const head = (await exec('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim(), copy = await tempClone(repo, head);
  try { expect(await readFile(join(dirname(copy.path), OWNER_FILE), 'utf8')).toBe(`ai-term ${process.pid}\n`); } finally { await copy.dispose(); }
});

it('every temp folder AI Term makes goes through ownTempFolder, and the daemon sweeps at start', async () => {
  const sources = async (folder: string): Promise<string[]> => (await readdir(folder, { recursive: true })).filter(name => name.endsWith('.ts')).map(name => join(folder, name));
  for (const file of await sources('src/daemon')) {
    const text = await readFile(file, 'utf8');
    expect(text.match(/mkdtemp\([^)]*'ai-term-(?:clone|test|deps|diff)-'/g) ?? [], file).toEqual([]);
  }
  expect(await readFile('src/daemon/main.ts', 'utf8')).toContain('sweepTemp(');
});
