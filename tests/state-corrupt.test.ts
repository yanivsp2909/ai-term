import { afterEach, expect, it } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getPaths, preparePaths, type Paths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { moveAside } from '../src/daemon/store.js';

const roots: string[] = [], managers: SessionManager[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.shutdown(); for (const root of roots.splice(0)) { await chmod(root, 0o700); await rm(root, { recursive: true, force: true }); } });
async function home(): Promise<Paths> { const root = await mkdtemp(join(tmpdir(), 'ai-term-corrupt-')); roots.push(root); const paths = getPaths(root); await preparePaths(paths); return paths; }
const now = new Date().toISOString();
const record = { id: randomUUID(), title: 'canary-title-B24', engine: 'shell', model: 'shell', auth: { kind: 'account' }, cwd: '/tmp', permission: 'ask', status: 'exited', statusDetail: 'exit 0', statusSince: now, createdAt: now, exitCode: 0, lastOutputAt: null, ctxPercent: null };
const aside = async (paths: Paths) => (await readdir(paths.root)).filter(name => name.startsWith('state.json.corrupt-'));
async function load(paths: Paths) { const m = new SessionManager(paths, new Logger(paths.log)); managers.push(m); await m.load(); return m; }

it.each([
  ['truncated JSON', 'parse', `{"sessions":[${JSON.stringify(record).slice(0, 40)}`],
  ['sessions of the wrong type', 'validate', JSON.stringify({ sessions: 'canary-title-B24' })],
  ['a record with wrong field types', 'validate', JSON.stringify({ sessions: [{ ...record, exitCode: 'zero', createdAt: 5 }] })],
  ['a record that fails the session check', 'validate', JSON.stringify({ sessions: [{ ...record, status: 'bogus' }] })],
  ['worktrees that are not a list (review L6)', 'validate', JSON.stringify({ sessions: [], worktrees: { path: '/x' } })],
])('%s: moved aside untouched (0600), daemon starts empty with one note, log names only the %s stage', async (_name, stage, text) => {
  const paths = await home();
  await writeFile(paths.state, text, { mode: 0o644 });
  const m = await load(paths);
  expect(m.list()).toEqual([]);
  const [name] = await aside(paths), moved = join(paths.root, name ?? '');
  expect(name).toMatch(/^state\.json\.corrupt-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/);
  expect(await readFile(moved, 'utf8')).toBe(text);
  expect((await lstat(moved)).mode & 0o777).toBe(0o600);
  // The new state.json is a fresh empty list; the user's copy was never written over.
  expect(JSON.parse(await readFile(paths.state, 'utf8'))).toEqual({ sessions: [], worktrees: [] });
  expect(m.notice).toBe(`couldn't read your agent list; saved it as ${moved}`); expect(m.warningText()).toBeNull();
  const log = await readFile(paths.log, 'utf8');
  expect(log).toContain(`Agent list could not be loaded (${stage}); moving it aside and starting empty`);
  expect(log).not.toContain('canary-title-B24'); expect(log).not.toMatch(/SyntaxError|JSON|position/);
});

it('an unreadable file is moved aside, not overwritten, and logged as the read stage', async () => {
  const paths = await home(), text = JSON.stringify({ sessions: [record] });
  await writeFile(paths.state, text, { mode: 0o600 }); await chmod(paths.state, 0o000);
  const m = await load(paths);
  expect(m.list()).toEqual([]);
  const [name] = await aside(paths), moved = join(paths.root, name ?? '');
  expect((await lstat(moved)).mode & 0o777).toBe(0o600);
  expect(await readFile(moved, 'utf8')).toBe(text);
  expect(await readFile(paths.log, 'utf8')).toContain('Agent list could not be loaded (read)');
  expect(m.notice).toContain(`saved it as ${moved}`);
});

it('a directory in place of state.json is moved aside as well', async () => {
  const paths = await home();
  await mkdir(paths.state);
  const m = await load(paths);
  expect(m.list()).toEqual([]);
  expect((await lstat(join(paths.root, (await aside(paths))[0] ?? ''))).isDirectory()).toBe(true);
});

it('when it cannot be moved aside, the daemon stops with a fixed reason and leaves the file exactly as it was', async () => {
  const paths = await home(), text = '{"sessions":[';
  await writeFile(paths.state, text, { mode: 0o600 });
  await chmod(paths.root, 0o500);
  const m = new SessionManager(paths, new Logger(paths.log)); managers.push(m);
  try { await expect(m.load()).rejects.toThrow('Agent list unreadable and not moved aside'); }
  finally { await chmod(paths.root, 0o700); }
  expect(await readFile(paths.state, 'utf8')).toBe(text);
  expect(await aside(paths)).toEqual([]);
});

it('a valid list still loads and is not moved', async () => {
  const paths = await home();
  await writeFile(paths.state, JSON.stringify({ sessions: [record] }), { mode: 0o600 });
  const m = await load(paths);
  expect(m.list().map(s => s.id)).toEqual([record.id]);
  expect(await aside(paths)).toEqual([]); expect(m.notice).toBeNull();
});

it('worktree records lost with the list leave their worktree undeletable (v0.3.2: never without a record)', async () => {
  const paths = await home(), worktree = join(await realpath(paths.root), 'worktrees', 'repo-0123456789', 'lost');
  await mkdir(worktree, { recursive: true, mode: 0o700 });
  const state = { sessions: [{ ...record, worktree, branch: 'ai/lost', title: 7 }], worktrees: [{ path: worktree, branch: 'ai/lost', repo: '/tmp/repo', baseCommit: 'a'.repeat(40), createdAt: now }] };
  await writeFile(paths.state, JSON.stringify(state), { mode: 0o600 });
  const m = await load(paths);
  expect(await m.checkWorktree(worktree)).toEqual({ path: worktree, refusal: "Not in AI Term's record" });
  await expect(m.deleteWorktree(worktree, 'f'.repeat(64), 'ai/lost')).rejects.toThrow("Not in AI Term's record");
  expect((await m.worktreeViews()).find(view => view.path === worktree)).toEqual({ path: worktree, refusal: "Not in AI Term's record" });
  expect((await lstat(worktree)).isDirectory()).toBe(true);
});

it('moveAside never replaces an existing moved-aside file with the same timestamp', async () => {
  const paths = await home(), at = new Date('2026-10-14T10:00:00.000Z');
  await writeFile(paths.state, 'first'); const first = await moveAside(paths.state, at);
  await writeFile(paths.state, 'second'); const second = await moveAside(paths.state, at);
  expect(second.path).toBe(`${first.path}-1`);
  expect(await readFile(first.path, 'utf8')).toBe('first'); expect(await readFile(second.path, 'utf8')).toBe('second');
});

it('the note reaches a homepage after sessions.list as a daemon.notice, never as a warning', async () => {
  const { DaemonServer } = await import('../src/daemon/server.js'), { Connection } = await import('../src/client/connection.js');
  const paths = await home(); await writeFile(paths.state, '{"sessions":[', { mode: 0o600 });
  const log = new Logger(paths.log), m = new SessionManager(paths, log), server = new DaemonServer(paths, m, log); managers.push(m);
  await m.load(); await server.listen();
  const client = await Connection.connect(paths, { entry: '/unused', autoStart: false }), events: unknown[] = [];
  try {
    client.on('event', event => events.push(event));
    await client.request({ kind: 'sessions.list' });
    await expect.poll(() => events).toContainEqual({ kind: 'daemon.notice', text: m.notice });
    expect(events.some(e => (e as { kind?: string }).kind === 'daemon.warning')).toBe(false);
  } finally { client.close(); await server.close(); }
});
