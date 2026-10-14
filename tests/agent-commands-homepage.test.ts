import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import headless from '@xterm/headless';
import { Homepage } from '../src/client/tui/homepage.js';
import { openFolder, OpenError } from '../src/client/tui/open-folder.js';
import { completeCommand } from '../src/client/tui/commands.js';
import type { FindMatch, SessionInfo, SuccessResponse } from '../src/shared/protocol.js';
import type { RequestBody } from '../src/client/connection.js';

const now = new Date(Date.now() - 1000).toISOString();
const session = (title: string, status: SessionInfo['status'] = 'running', minutes = 0, extra: Partial<SessionInfo> = {}): SessionInfo => ({ id: randomUUID(), title, engine: 'codex', model: 'gpt', auth: { kind: 'account' }, cwd: '/tmp', permission: 'ask', status, statusDetail: status === 'waiting' ? 'permission' : '', statusSince: now, createdAt: new Date(Date.now() - minutes * 60000).toISOString(), lastOutputAt: null, exitCode: status === 'exited' ? 0 : null, ctxPercent: null, ...extra });
class TTY extends EventEmitter { isTTY = true; isRaw = false; columns = 130; rows = 45; output = ''; setRawMode(v: boolean) { this.isRaw = v; } resume() {} pause() {} write(data: string | Buffer) { this.output += data.toString(); return true; } }
async function screen(tty: TTY): Promise<string> { const terminal = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true }); try { await new Promise<void>(resolve => terminal.write(tty.output, resolve)); return Array.from({ length: 45 }, (_, y) => terminal.buffer.active.getLine(y)?.translateToString() ?? '').join('\n'); } finally { terminal.dispose(); } }
const shows = (tty: TTY, text: string) => vi.waitFor(async () => expect(await screen(tty)).toContain(text));
const usage = { costUsd: 1.5, tokens: 2000, cachedTokens: 500, unknownPrice: false, providers: [{ provider: 'anthropic' as const, costUsd: 1.5, tokens: 2000, cachedTokens: 500, unknownPrice: false }] };
class Client extends EventEmitter {
  requests: RequestBody[] = [];
  failures = new Map<string, string>();
  matches: FindMatch[] = [];
  constructor(public sessions: SessionInfo[]) { super(); }
  async request(body: RequestBody): Promise<SuccessResponse> {
    this.requests.push(body);
    const failure = this.failures.get(body.kind); if (failure) throw new Error(failure);
    const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.get') response.settings = { theme: 'graphite' };
    if (body.kind === 'sessions.list') response.sessions = this.sessions;
    if (body.kind === 'sessions.preview') { response.snapshot = Array.from({ length: 80 }, (_, i) => `row ${i}`).join('\r\n'); response.cols = 85; response.rows = 30; }
    if (body.kind === 'sessions.retry') response.session = { ...session('retried'), title: this.sessions.find(s => s.id === body.sessionId)?.title ?? 'x' };
    if (body.kind === 'sessions.find') { response.matches = this.matches; response.moreMatches = false; }
    if (body.kind === 'usage.summary') response.usage = { today: usage, week: usage, month: usage };
    return response;
  }
}
function open(sessions: SessionInfo[], options: { doctor?: () => Promise<string[]>; openFolder?: (path: string, app: 'finder' | 'code') => Promise<string> } = {}) {
  const tty = new TTY(), client = new Client(sessions);
  const home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', terminalProgram: 'unknown', ...options });
  return { tty, home, client, start: () => home.start() };
}
const type = (tty: TTY, text: string) => { for (const char of text) tty.emit('data', Buffer.from(char)); };
const paste = (tty: TTY, text: string) => tty.emit('data', Buffer.from(`\x1b[200~${text}\x1b[201~`));
const enter = (tty: TTY) => tty.emit('data', Buffer.from('\r'));
const sent = (client: Client) => client.requests.filter(r => r.kind === 'sessions.send');

it('/send pastes multi-line text into the named agent as one message and says so', async () => {
  const alpha = session('alpha', 'running', 1), { tty, home, client, start } = open([alpha, session('alpha beta', 'running', 2)]);
  await start();
  try {
    type(tty, '/send alpha '); paste(tty, 'line one\r\nline two\tend'); enter(tty);
    await shows(tty, '✓ sent to alpha · 2 lines');
    expect(sent(client)).toEqual([{ kind: 'sessions.send', sessionId: alpha.id, text: 'line one\nline twoend' }]);
  } finally { await home.stop(); }
});

it('/send to an agent asking for permission is refused before anything is sent', async () => {
  const { tty, home, client, start } = open([session('alpha', 'waiting')]);
  await start();
  try { type(tty, '/send alpha 1'); enter(tty); await shows(tty, 'alpha is asking for permission, go inside to answer'); expect(sent(client)).toEqual([]); }
  finally { await home.stop(); }
});

it("/send names the agent in the daemon's refusals; unknown, exited and ambiguous names are notes", async () => {
  const twin = session('twin', 'running', 3), { tty, home, client, start } = open([session('alpha', 'running', 1), session('done', 'exited', 2), twin, { ...twin, id: randomUUID() }]);
  await start();
  try {
    client.failures.set('sessions.send', 'Agent has not reported its status yet');
    type(tty, '/send alpha hi'); enter(tty); await shows(tty, 'alpha may be asking to trust its folder · go inside first');
    client.failures.set('sessions.send', 'Agent is open in a session');
    type(tty, '/send alpha hi'); enter(tty); await shows(tty, 'alpha is open in a session or split · type there');
    type(tty, '/send nobody hi'); enter(tty); await shows(tty, 'no agent is named nobody · Tab completes names');
    type(tty, '/send done hi'); enter(tty); await shows(tty, 'done has exited · /retry restarts it');
    type(tty, '/send twin hi'); enter(tty); await shows(tty, '2 agents are named twin · r renames one');
    expect(sent(client)).toHaveLength(2);
  } finally { await home.stop(); }
});

it('Tab completes running agent names after /send, then cycles them, and leaves typed text alone', () => {
  const context = { engine: 'codex' as const, model: null, cwd: '/tmp', theme: 'graphite' as const, agents: ['alpha', 'beta two'] };
  expect(completeCommand('/send al', 0, context)).toBe('/send alpha ');
  expect(completeCommand('/send alpha ', 0, context)).toBe('/send beta two ');
  expect(completeCommand('/send beta two ', 0, context)).toBe('/send alpha ');
  expect(completeCommand('/send alpha hello', 0, context)).toBe('/send alpha hello');
  expect(completeCommand('/send zz', 0, context)).toBe('/send zz');
});

it('/retry refuses a running agent and replaces a finished one with the restarted agent', async () => {
  const running = session('busy', 'running', 1), done = session('fixer', 'error', 2, { worktree: '/tmp/wt', branch: 'ai/fixer' }), { tty, home, client, start } = open([running, done]);
  await start();
  try {
    type(tty, '/retry'); enter(tty); await shows(tty, 'busy is still running · /retry restarts finished agents');
    tty.emit('data', Buffer.from('\x1b[B')); type(tty, '/retry'); enter(tty);
    await shows(tty, "✓ restarted fixer in its worktree · its first message isn't resent");
    expect(client.requests.filter(r => r.kind === 'sessions.retry')).toEqual([{ kind: 'sessions.retry', sessionId: done.id }]);
  } finally { await home.stop(); }
});

it('/retry of an agent whose worktree was deleted says so and keeps it in the list', async () => {
  const done = session('fixer', 'error', 1, { worktree: '/tmp/wt', branch: 'ai/fixer' }), { tty, home, client, start } = open([done]);
  client.failures.set('sessions.retry', 'Its worktree is gone');
  await start();
  try { type(tty, '/retry'); enter(tty); await shows(tty, 'fixer: its worktree is gone · start a new agent'); await shows(tty, 'fixer'); }
  finally { await home.stop(); }
});

it('/find sends the text as typed, special characters included, and ⏎ selects the agent and scrolls its preview to the line', async () => {
  const alpha = session('alpha', 'running', 1), beta = session('beta', 'running', 2), { tty, home, client, start } = open([alpha, beta]);
  client.matches = [{ sessionId: beta.id, fromEnd: 60, text: 'error: a.b*(c)[d] failed', start: 7, length: 10 }];
  await start();
  try {
    type(tty, '/find a.b*(c)[d]'); enter(tty);
    await shows(tty, 'Find “a.b*(c)[d]” · 1'); await shows(tty, 'error: a.b*(c)[d] failed');
    expect(client.requests.find(r => r.kind === 'sessions.find')).toEqual({ kind: 'sessions.find', text: 'a.b*(c)[d]' });
    enter(tty);
    await vi.waitFor(() => expect(client.requests.filter(r => r.kind === 'sessions.preview').at(-1)).toEqual({ kind: 'sessions.preview', sessionId: beta.id }));
    // Row 79 is the last of 80; fromEnd 60 is "row 19", which must now be on screen in the preview.
    await shows(tty, 'row 19'); await shows(tty, 'lines back');
  } finally { await home.stop(); }
});

it('/find with no hits says so and Esc closes', async () => {
  const { tty, home, start } = open([session('alpha')]);
  await start();
  try {
    type(tty, '/find nothing'); enter(tty); await shows(tty, 'no matches in any agent');
    tty.emit('data', Buffer.from('\x1b')); await vi.waitFor(async () => expect(await screen(tty)).not.toContain('no matches in any agent'));
  } finally { await home.stop(); }
});

it('/open opens the worktree in Finder, /open code in VS Code, anything else is a note', async () => {
  const calls: [string, string][] = [], selected = session('alpha', 'running', 0, { worktree: '/tmp/wt-alpha', branch: 'ai/alpha', cwd: '/tmp/wt-alpha/sub' });
  const { tty, home, start } = open([selected], { openFolder: async (path, app) => { calls.push([path, app]); return app === 'code' ? 'VS Code' : 'Finder'; } });
  await start();
  try {
    type(tty, '/open'); enter(tty); await shows(tty, 'opened /tmp/wt-alpha in Finder');
    type(tty, '/open code'); enter(tty); await shows(tty, 'opened /tmp/wt-alpha in VS Code');
    type(tty, '/open vim'); enter(tty); await shows(tty, '/open or /open code');
    expect(calls).toEqual([['/tmp/wt-alpha', 'finder'], ['/tmp/wt-alpha', 'code']]);
  } finally { await home.stop(); }
});

it('openFolder runs exactly /usr/bin/open -- <path>, or code -- <path> without secrets in its env', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-open-')), file = join(dir, 'file');
  const previous = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'sk-ant-canary';
  try {
    const runs: [string, readonly string[], NodeJS.ProcessEnv][] = [], runner = async (f: string, a: readonly string[], e: NodeJS.ProcessEnv) => { runs.push([f, a, e]); };
    expect(await openFolder(dir, 'finder', runner)).toBe('Finder');
    expect(runs[0]).toEqual(['/usr/bin/open', ['--', dir], { PATH: '/usr/bin:/bin' }]);
    expect(await openFolder(dir, 'code', runner, async name => `/opt/bin/${name}`)).toBe('VS Code');
    expect(runs[1]?.slice(0, 2)).toEqual(['/opt/bin/code', ['--', dir]]);
    expect(runs[1]?.[2]).not.toHaveProperty('ANTHROPIC_API_KEY'); expect(runs[1]?.[2]).toHaveProperty('PATH');
    await expect(openFolder(dir, 'code', runner, async () => null)).rejects.toThrow(new OpenError("VS Code's code command isn't on PATH"));
    await writeFile(file, 'x');
    await expect(openFolder(file, 'finder', runner)).rejects.toThrow('folder is gone');
    await expect(openFolder(join(dir, 'missing'), 'finder', runner)).rejects.toThrow('folder is gone');
    await expect(openFolder('relative/path', 'finder', runner)).rejects.toThrow('folder path is not absolute');
    await expect(openFolder(dir, 'finder', async () => { throw new Error('raw child error /secret/path'); })).rejects.toThrow("Finder couldn't open it");
    expect(runs).toHaveLength(2);
  } finally { if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous; await rm(dir, { recursive: true, force: true }); }
});

it('/doctor shows the ai doctor report in a popup; /usage and u show usage by period and provider; /budget opens the limits', async () => {
  const { tty, home, start } = open([session('alpha')], { doctor: async () => ['Node: v26.0.0', 'Daemon: running; protocol 1', 'claude: not found'] });
  await start();
  try {
    type(tty, '/doctor'); enter(tty); await shows(tty, 'Daemon: running; protocol 1'); await shows(tty, 'claude: not found');
    tty.emit('data', Buffer.from('\x1b')); await vi.waitFor(async () => expect(await screen(tty)).not.toContain('claude: not found'));
    type(tty, '/usage'); enter(tty); await shows(tty, 'TODAY  ≈ $1.50 · 2.0K tokens (500 cached) · budget none'); await shows(tty, 'anthropic  ≈ $1.50');
    tty.emit('data', Buffer.from('\x1b')); await vi.waitFor(async () => expect(await screen(tty)).not.toContain('anthropic  ≈ $1.50'));
    type(tty, 'u'); await shows(tty, 'MONTH  ≈ $1.50');
    tty.emit('data', Buffer.from('\x1b')); await vi.waitFor(async () => expect(await screen(tty)).not.toContain('MONTH  ≈'));
    type(tty, '/budget'); enter(tty); await shows(tty, 'daily');
  } finally { await home.stop(); }
});

it("B24's daemon.notice is an ordinary note: shown once, and the next note replaces it", async () => {
  const { tty, home, client, start } = open([session('alpha')]);
  await start();
  try {
    client.emit('event', { kind: 'daemon.notice', text: "couldn't read your agent list; saved it as /h/.ai-term/state.json.corrupt-x" });
    await shows(tty, "couldn't read your agent list; saved it as /h/.ai-term/state.json.corrupt-x");
    type(tty, '/send nobody hi'); enter(tty); await shows(tty, 'no agent is named nobody');
  } finally { await home.stop(); }
});
