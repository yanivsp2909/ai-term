import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import pty from 'node-pty';
import * as engines from '../src/daemon/engines.js';
import { allocatePort, DEV_PORTS, devEnv, devLines, DevServers } from '../src/daemon/dev-servers.js';
import { prepareSandbox } from '../src/daemon/test-sandbox.js';
import { buildTestEnv } from '../src/daemon/env.js';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { cardText } from '../src/client/tui/agent-card.js';
import { validateRequest } from '../src/shared/validate.js';
import type { SessionInfo } from '../src/shared/protocol.js';

// v0.9.2 dev servers per worktree. The prompt's text for this part never arrived (it was cut off inside the queue part);
// this is the spec chosen for it, the cautious way: D55 off by default (/settings y); /dev-cmd sets the project's dev
// command; /dev [agent] shows what runs, where, on which port and in which sandbox, and starts it only on y; each worktree
// gets its own port (4100–4199) on 127.0.0.1; D56: agent code runs in the sandbox (127.0.0.1 only, writes only in the
// worktree and a temp folder) or, where none can hold a reachable server, after you say so each time; x stops it; it
// never starts or restarts by itself.
const MAC = process.platform === 'darwin', roots: string[] = [], managers: SessionManager[] = [], servers: DevServers[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.stopAll(); for (const m of managers.splice(0)) await m.shutdown(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-dev-'))); roots.push(dir); return dir; }
const run = promisify(execFile);

it('each worktree gets its own port from a fixed range, kept while it lives, never one already taken', () => {
  expect(DEV_PORTS).toEqual({ first: 4100, last: 4199 });
  expect(allocatePort('/w/a', new Map(), () => true)).toBe(4100);
  expect(allocatePort('/w/b', new Map([['/w/a', 4100]]), () => true)).toBe(4101);
  expect(allocatePort('/w/a', new Map([['/w/a', 4100]]), () => true)).toBe(4100);
  expect(allocatePort('/w/c', new Map(), port => port !== 4100)).toBe(4101);
  expect(allocatePort('/w/new', new Map(Array.from({ length: 100 }, (_, i) => [`/w/${i}`, 4100 + i])), () => true)).toBeNull();
});

it('the dev env: PORT and HOST=127.0.0.1, no browser opened, no keys, not CI', () => {
  const env = devEnv({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-x', HOME: '/h' }, 4101);
  expect(env).toMatchObject({ PORT: '4101', HOST: '127.0.0.1', BROWSER: 'none' });
  expect(env.ANTHROPIC_API_KEY).toBeUndefined(); expect(env.CI).toBeUndefined();
});

it('the /dev popup says what runs, where, on which port, and whether in the sandbox; a running one shows its last lines and x', () => {
  const base = { title: 'fixer', command: ['npm', 'run', 'dev'], cwd: '/w/a', port: 4100, fingerprint: 'a'.repeat(64), tail: [] as string[] };
  const lines = devLines({ ...base, sandbox: true, running: false }).map(line => line.text);
  expect(lines).toContain('$ npm run dev');
  expect(lines).toContain('in /w/a · http://127.0.0.1:4100 · PORT=4100');
  expect(lines.join('\n')).toContain('sandbox: listens on 127.0.0.1 only · writes only in this worktree and a temp folder · no internet');
  expect(lines.at(-1)).toBe('y starts it · n or Esc starts nothing');
  const bare = devLines({ ...base, sandbox: false, why: "no sandbox: on Linux a sandboxed server can't be reached from your browser", running: false }).map(line => line.text).join('\n');
  expect(bare).toContain("no sandbox: on Linux a sandboxed server can't be reached from your browser · it runs with your user's rights");
  const live = devLines({ ...base, sandbox: true, running: true, tail: ['ready in 120 ms'] }).map(line => line.text);
  expect(live).toContain('▶ running · http://127.0.0.1:4100'); expect(live).toContain('  ready in 120 ms'); expect(live.at(-1)).toBe('x stops it · Esc closes');
});

it('cards show a running dev server and one that ended', () => {
  const session = { id: randomUUID(), title: 'fixer', engine: 'codex', model: 'gpt', auth: { kind: 'account' }, cwd: '/w/a', worktree: '/w/a', branch: 'ai/fixer', permission: 'ask', status: 'done', statusDetail: '', createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), exitCode: null } as unknown as SessionInfo;
  expect(cardText({ ...session, dev: { state: 'running', port: 4101 } }, Date.now(), 80).activity?.text).toContain('▶ dev :4101');
  expect(cardText({ ...session, dev: { state: 'exited', port: 4101, code: 1 } }, Date.now(), 80).activity?.text).toContain('✗ dev exited 1');
});

it('requests are validated', async () => {
  const id = randomUUID();
  await expect(validateRequest({ id, kind: 'sessions.devPlan', sessionId: randomUUID() })).resolves.toMatchObject({ kind: 'sessions.devPlan' });
  await expect(validateRequest({ id, kind: 'sessions.dev', sessionId: randomUUID(), fingerprint: 'b'.repeat(64) })).resolves.toMatchObject({ kind: 'sessions.dev' });
  await expect(validateRequest({ id, kind: 'sessions.devStop', sessionId: randomUUID() })).resolves.toMatchObject({ kind: 'sessions.devStop' });
  await expect(validateRequest({ id, kind: 'project.setDevCommand', cwd: tmpdir(), command: ['npm', 'run', 'dev'] })).resolves.toMatchObject({ kind: 'project.setDevCommand' });
  await expect(validateRequest({ id, kind: 'sessions.dev', sessionId: randomUUID(), fingerprint: 'nope' })).rejects.toThrow();
});

it.skipIf(!MAC)('macOS: a dev server runs sandboxed on its port, reachable at 127.0.0.1; it can\'t write outside its worktree; x stops it', async () => {
  const dir = await temp(), tree = join(dir, 'tree'), home = join(dir, 'home'); await mkdir(tree); await mkdir(home);
  await writeFile(join(tree, 'server.js'), "require('fs').writeFileSync(process.env.HOME + '/escaped.txt', 'x', { flag: 'w' });\n", 'utf8').catch(() => undefined);
  await writeFile(join(tree, 'server.js'), "try { require('fs').writeFileSync(require('path').join(process.env.HOME, 'escaped.txt'), 'x'); } catch { console.log('home write refused'); }\nrequire('http').createServer((q, s) => s.end('hello from dev')).listen(Number(process.env.PORT), process.env.HOST, () => console.log('listening on ' + process.env.PORT));\n");
  const env = { ...devEnv({ ...buildTestEnv(process.env), HOME: home }, 0) }, box = await prepareSandbox(tree, { home, private: [], loopback: true, env });
  const dev = new DevServers({ error: vi.fn() }); servers.push(dev);
  const port = allocatePort(tree, new Map(), () => true) ?? 4150;
  await dev.start('s1', { command: [process.execPath, 'server.js'], cwd: tree, port, sandbox: box, env: { ...env, HOME: home } }, () => {});
  await vi.waitFor(() => expect(dev.tail('s1').join('\n')).toContain(`listening on ${port}`), { timeout: 10_000 });
  const response = await fetch(`http://127.0.0.1:${port}/`);
  expect(await response.text()).toBe('hello from dev');
  expect(dev.tail('s1').join('\n')).toContain('home write refused');
  await expect(stat(join(home, 'escaped.txt'))).rejects.toThrow();
  await dev.stop('s1');
  await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
}, 30_000);

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
async function agent(settings: Record<string, unknown>) {
  const dir = await temp(), repo = join(dir, 'repo'), home = join(dir, 'home');
  await mkdir(repo); await mkdir(home, { mode: 0o700 });
  await run('/usr/bin/git', ['init', '-q', '-b', 'main', '--', repo]); await writeFile(join(repo, 'readme.md'), 'x\n');
  await run('/usr/bin/git', [...ID, 'add', '--', '.'], { cwd: repo }); await run('/usr/bin/git', [...ID, 'commit', '-qm', 'i', '--'], { cwd: repo });
  const paths = getPaths(home); await preparePaths(paths);
  await writeFile(join(home, 'settings.json'), JSON.stringify({ theme: 'graphite', ...settings }), { mode: 0o600 });
  const real = pty.spawn;
  vi.spyOn(pty, 'spawn').mockImplementation((file, args, options) => file === '/bin/sh' ? real('/bin/sh', ['-c', 'sleep 300'], { ...options, env: { PATH: '/usr/bin:/bin' } }) : real(file, args, options));
  vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' });
  const m = new SessionManager(paths, new Logger(paths.log)); managers.push(m); await m.load();
  const session = await m.create({ engine: 'codex', model: 'gpt-test', auth: { kind: 'account' }, cwd: repo, permission: 'ask', title: 'fixer' });
  return { m, session, repo, tree: session.worktree ?? '' };
}

it('the daemon: off by default; with it on, a project command and a plan; y with the shown plan only; the card follows; stop', async () => {
  const off = await agent({});
  await expect(off.m.devPlan(off.session.id)).rejects.toThrow('Dev servers are off; turn them on in /settings (y)');
  const { m, session, repo, tree } = await agent({ devServers: true });
  await expect(m.devPlan(session.id)).rejects.toThrow("Set the project's dev command with /dev-cmd first");
  await writeFile(join(tree, 'server.js'), "require('http').createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), process.env.HOST, () => console.log('up'));\n");
  await m.setDevCommand(repo, [process.execPath, 'server.js']);
  const plan = await m.devPlan(session.id);
  expect(plan).toMatchObject({ command: [process.execPath, 'server.js'], cwd: tree, port: expect.any(Number), running: false, sandbox: MAC });
  await expect(m.runDevPlan(session.id, 'f'.repeat(64))).rejects.toThrow('The dev server setup changed since it was shown; run /dev again');
  await m.runDevPlan(session.id, plan.fingerprint);
  await vi.waitFor(() => expect(m.list().find(s => s.id === session.id)?.dev).toEqual({ state: 'running', port: plan.port }), { timeout: 10_000 });
  await vi.waitFor(async () => expect(await (await fetch(`http://127.0.0.1:${plan.port}/`)).text()).toBe('ok'), { timeout: 10_000 });
  await m.stopDev(session.id);
  await vi.waitFor(() => expect(m.list().find(s => s.id === session.id)?.dev).toBeUndefined());
  void readFile;
}, 60_000);
