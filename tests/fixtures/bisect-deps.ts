import { afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareSandbox, sandboxReady, type PreparedSandbox } from '../../src/daemon/test-sandbox.js';
import { buildBisectEnv } from '../../src/daemon/env.js';
import { repoCommonDir } from '../../src/daemon/git.js';

// /bisect with installed dependencies (B32, B33), shared by the tests that run it: a Node repository with a planted bad
// commit and an installed node_modules, a digest of a folder, a temp folder of the test's own, and the test sandbox.
const run = promisify(execFile);
export const MAC = process.platform === 'darwin';
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
export const git = async (cwd: string, ...args: string[]) => (await run('/usr/bin/git', [...ID, ...args], { cwd })).stdout.trim();
export const noClone = async () => ({ ok: false as const, why: 'this disk can\'t clone' });
// Registers its own cleanup. locked: a test that made a folder read-only or a file unreadable gives it back first.
export function useBisectRepos() {
  const roots: string[] = [], locked: { path: string; mode: number }[] = [];
  afterEach(async () => { for (const { path, mode } of locked.splice(0)) await chmod(path, mode).catch(() => undefined); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  // A Node project whose test needs a dependency that only the installed node_modules has; commit `bad` of `total` breaks
  // it. The test also tries to write into node_modules/dep first (ignored when refused). cache: like Vitest, the runner
  // writes node_modules/.cache and stops with an error when it can't.
  async function nodeRepo(bad = 6, total = 10, cache = false) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-bisect-deps-'))); roots.push(root);
    const repo = join(root, 'repo'); await mkdir(repo);
    await git(root, 'init', '-q', '-b', 'main', '--', repo);
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
    await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'demo', private: true, scripts: { test: 'node test.js' } }));
    await writeFile(join(repo, 'test.js'), [
      "const fs = require('node:fs');",
      "try { fs.writeFileSync('node_modules/dep/planted.txt', 'x'); } catch {}",
      ...cache ? ["try { fs.mkdirSync('node_modules/.cache/demo', { recursive: true }); fs.writeFileSync(`node_modules/.cache/demo/${process.pid}.json`, '{}'); } catch { process.exit(3); }"] : [],
      "const wrap = require('dep');",
      "process.exit(wrap(fs.readFileSync('state.txt', 'utf8').trim()) === '[ok]' ? 0 : 1);", ''].join('\n'));
    const commits: string[] = [];
    for (let n = 1; n <= total; n++) {
      await writeFile(join(repo, 'state.txt'), n < bad ? 'ok\n' : 'broken\n'); await writeFile(join(repo, `file${n}.txt`), `${n}\n`);
      await git(repo, 'add', '--', '.'); await git(repo, 'commit', '-qm', n === bad ? 'planted: break the state' : `change ${n}`, '--');
      commits.push(await git(repo, 'rev-parse', 'HEAD'));
    }
    // Installed, never committed: what `npm install` leaves behind.
    await mkdir(join(repo, 'node_modules', 'dep'), { recursive: true });
    await writeFile(join(repo, 'node_modules', 'dep', 'package.json'), JSON.stringify({ name: 'dep', main: 'index.js' }));
    await writeFile(join(repo, 'node_modules', 'dep', 'index.js'), "module.exports = s => '[' + s + ']';\n");
    return { root, repo, commits, badCommit: commits[bad - 1] ?? '' };
  }
  // A temp folder of the test's own: other files' workers make ai-term-clone-* folders in the shared one at the same time.
  async function ownTemp<T>(body: (temp: string) => Promise<T>): Promise<T> {
    const temp = await realpath(await mkdtemp(join(tmpdir(), 'ai-bisect-deps-tmp-'))), saved = process.env.TMPDIR; roots.push(temp);
    process.env.TMPDIR = temp;
    try { return await body(temp); } finally { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; }
  }
  return { roots, locked, nodeRepo, ownTemp };
}
// Every entry under a folder, without following links: its path, kind, mode and size, a link's target, a file's bytes.
export async function digest(folder: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name), info = await lstat(path);
      hash.update(`${path.slice(folder.length)}\0${info.mode}\0${info.size}\0`);
      if (info.isSymbolicLink()) hash.update(await readlink(path)); else if (info.isDirectory()) await walk(path); else hash.update(await readFile(path));
    }
  };
  await walk(folder); return hash.digest('hex');
}
export const sandboxFor = (repo: string) => async (path: string, readable: readonly string[] = []): Promise<PreparedSandbox | null> => {
  const box = await prepareSandbox(path, { home: homedir(), private: [], loopback: false, env: buildBisectEnv(process.env), readable: [await repoCommonDir(repo), ...readable] });
  if (await sandboxReady(box.profile, box.program, box.prefix)) return box;
  await box.dispose(); return null;
};
