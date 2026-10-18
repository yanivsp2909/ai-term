import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Home } from './home.js';
import { KEY, LiveFailure, sleep, type Screen } from './screen.js';
import { STUB_MODEL, type StubOllama } from './stub-ollama.js';
import { git, makeRepo, type World } from './world.js';

// What tier 1's checks share: the world, the stub, the app repository and the homepage.
export interface Tier1 { world: World; stub: StubOllama; repo: string; ai: Screen; home: Home }
export const fail = async (t: Tier1, message: string): Promise<never> => { throw new LiveFailure(message, await t.ai.text()); };
// Waits for something the suite itself sees (the stub's log, a file), with the screen kept for the failure line.
export async function until(t: Tier1, test: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await test()) { if (Date.now() > deadline) await fail(t, `never saw ${what} within ${Math.round(timeoutMs / 1000)} s`); await sleep(100); }
}
// The bottom row: the next agent's model, engine, folder, auth, effort, mode and worktree.
export const bottomLine = async (t: Tier1) => (await t.ai.text()).split('\n').filter(line => line.trim()).at(-1) ?? '';
export async function waitBottom(t: Tier1, what: RegExp, label: string): Promise<void> {
  await until(t, async () => what.test(await bottomLine(t)), `${label} on the bottom line`, 10_000);
}
// The screen as text with every escape sequence taken out, for searching what reached it.
// eslint-disable-next-line no-control-regex -- taking escape sequences out is the point.
export const plain = (raw: string) => raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '').replace(/\x1b./g, '');
// The worktree folder of a branch, from git's own list in the repository.
export async function worktreeOf(repo: string, branch: string): Promise<string> {
  const list = await git(repo, 'worktree', 'list', '--porcelain');
  const path = list.split('\n\n').find(b => b.split('\n').includes(`branch refs/heads/${branch}`))?.split('\n').find(line => line.startsWith('worktree '))?.slice('worktree '.length);
  if (!path) throw new LiveFailure(`git lists no worktree on ${branch}`, list);
  return path;
}
// Stops an agent from the homepage (select it, s, y) unless it already exited; then it is selected and exited.
export async function stop(t: Tier1, title: string): Promise<void> {
  await t.home.select(title); await t.home.emptyBar();
  if (!/■ exited/.test(await t.home.card(title))) { t.ai.write('s'); await t.ai.waitFor(`stop ${title}? y/n`); t.ai.write('y'); }
  await t.home.waitStatus(title, /■ exited/, 15_000, 'exited');
}
// Renames the selected agent: r, the new name, ⏎.
export async function rename(t: Tier1, from: string, to: string): Promise<void> {
  await t.home.select(from); await t.home.emptyBar();
  t.ai.write('r'); await t.ai.waitFor('rename: type a name'); t.ai.write(KEY.ctrlU); await t.ai.type(to);
  await until(t, async () => (await t.home.card(to)) !== '', `a card named ${to}`);
}
export async function localPage(port: number): Promise<string | null> {
  try { const reply = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }); return await reply.text(); }
  catch (error) { if (error instanceof TypeError || error instanceof DOMException) return null; throw error; }
}
// The next whole minute with at least 40 s to spare for typing the queue entry, as HH:MM on this Mac's clock.
export function nextMinute(now = new Date()): string {
  const at = new Date(now.getTime() + 60_000 + (60 - now.getSeconds() < 40 ? 60_000 : 0));
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}
// An add-on popup's engine and key: e until it names AI Term's agent on the stub model (never a CLI or a real key).
export async function stubTarget(t: Tier1): Promise<void> {
  await t.ai.waitFor('e engine/key', 15_000);
  for (let i = 0; i < 8; i++) {
    if (new RegExp(`ai-term · ${STUB_MODEL}`).test(await t.ai.text())) return;
    t.ai.write('e'); await sleep(250);
  }
  await fail(t, `e never reached AI Term's agent on ${STUB_MODEL}`);
}
// A Node repository with a planted bad commit (5 of 8) whose test runner, like Vitest, must write a cache inside
// node_modules; node_modules is installed, never committed.
export async function bisectRepo(world: World): Promise<{ repo: string; bad: string; digest: string }> {
  const files: Record<string, string> = {
    '.gitignore': 'node_modules/\n', 'package.json': JSON.stringify({ name: 'live-bisect', private: true, scripts: { test: 'node test.js' } }),
    'test.js': ["const fs = require('node:fs');", "fs.mkdirSync('node_modules/.cache/live', { recursive: true }); fs.writeFileSync(`node_modules/.cache/live/${process.pid}.json`, '{}');",
      "process.exit(require('dep')(fs.readFileSync('state.txt', 'utf8').trim()) === '[ok]' ? 0 : 1);", ''].join('\n'), 'state.txt': 'ok\n' };
  const repo = await makeRepo(world, 'bisect', files);
  let bad = '';
  for (let n = 2; n <= 8; n++) {
    await writeFile(join(repo, 'state.txt'), n < 5 ? 'ok\n' : 'broken\n'); await writeFile(join(repo, `file${n}.txt`), `${n}\n`);
    await git(repo, 'add', '--', '.'); await git(repo, 'commit', '-qm', n === 5 ? 'planted: break the state' : `change ${n}`, '--');
    if (n === 5) bad = await git(repo, 'rev-parse', 'HEAD');
  }
  await mkdir(join(repo, 'node_modules', 'dep'), { recursive: true });
  await writeFile(join(repo, 'node_modules', 'dep', 'package.json'), JSON.stringify({ name: 'dep', main: 'index.js' }));
  await writeFile(join(repo, 'node_modules', 'dep', 'index.js'), "module.exports = s => '[' + s + ']';\n");
  return { repo, bad, digest: await treeDigest(join(repo, 'node_modules')) };
}
// Every entry's path, mode, size, link target and bytes, without following links.
export async function treeDigest(folder: string): Promise<string> {
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
// A file's text, or '' when it isn't there (any other read error stops the check).
export async function textOf(path: string): Promise<string> {
  try { return await readFile(path, 'utf8'); } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''; throw error; }
}
// A stand-in for Claude Code: it passes AI Term's install and login checks, then shows a trust question and waits,
// never reporting in, as the real CLI does before you answer it. Only the suite's own bin folder holds it.
export const FAKE_CLAUDE = `#!/bin/sh
case "$1" in
  --version) echo '2.1.302 (Claude Code)'; exit 0;;
  auth) echo '{"loggedIn":true,"authMethod":"claude.ai"}'; exit 0;;
esac
printf 'LIVE stand-in Claude Code\\n\\nDo you trust the files in this folder?\\n\\n> 1. Yes, proceed\\n  2. No, exit\\n'
exec /bin/sleep 600
`;
