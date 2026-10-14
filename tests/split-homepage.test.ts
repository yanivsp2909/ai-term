import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import headless from '@xterm/headless';
import { Homepage } from '../src/client/tui/homepage.js';
import type { SplitResult } from '../src/client/split.js';
import type { SessionInfo, SuccessResponse } from '../src/shared/protocol.js';
import type { RequestBody } from '../src/client/connection.js';

const now = new Date(Date.now() - 1000).toISOString();
// Newest first in the list: a smaller `minutes` sorts higher.
const session = (title: string, status: SessionInfo['status'] = 'running', minutes = 0): SessionInfo => ({ id:randomUUID(), title, engine:'codex', model:'gpt', auth:{ kind:'account' }, cwd:'/tmp', permission:'ask', status, statusDetail:'', statusSince:now, createdAt:new Date(Date.now() - minutes * 60000).toISOString(), lastOutputAt:null, exitCode:status === 'exited' ? 0 : null, ctxPercent:null });
class TTY extends EventEmitter { isTTY = true; isRaw = false; columns = 130; rows = 45; output = ''; setRawMode(v: boolean) { this.isRaw = v; } resume() {} pause() {} write(data: string | Buffer) { this.output += data.toString(); return true; } }
async function screen(tty: TTY): Promise<string> { const terminal = new headless.Terminal({ cols:130, rows:45, allowProposedApi:true }); try { await new Promise<void>(resolve => terminal.write(tty.output, resolve)); return Array.from({ length:45 }, (_, y) => terminal.buffer.active.getLine(y)?.translateToString() ?? '').join('\n'); } finally { terminal.dispose(); } }
const shows = (tty: TTY, text: string) => vi.waitFor(async () => expect(await screen(tty)).toContain(text));
class Client extends EventEmitter {
 constructor(public sessions: SessionInfo[]) { super(); }
 async request(body: RequestBody): Promise<SuccessResponse> {
  const response: SuccessResponse = { id:randomUUID(), ok:true };
  if (body.kind === 'settings.get') response.settings = { theme:'graphite' };
  if (body.kind === 'sessions.list') response.sessions = this.sessions;
  if (body.kind === 'sessions.preview') { response.snapshot = ''; response.cols = 85; response.rows = 30; }
  return response;
 }
}
function open(sessions: SessionInfo[], results: SplitResult[] = [{ reason:'home key', dropped:0 }]) {
 const tty = new TTY(), splits: string[][] = [], attaches: string[] = [], client = new Client(sessions);
 const home = new Homepage(client, { stdin:tty, stdout:tty, signals:new EventEmitter(), cwd:'/tmp', terminalProgram:'unknown',
  splitSessions:async ids => { splits.push(ids); return results.shift() ?? { reason:'home key', dropped:0 }; },
  attachSession:async id => { attaches.push(id); return 'home key'; } });
 return { tty, home, splits, attaches, start:() => home.start() };
}
const press = (tty: TTY, key: string) => tty.emit('data', Buffer.from(key));
const down = '\x1b[B';

it('Space marks the selected agent with a glyph and a word; Space again unmarks it', async () => {
 const a = session('alpha', 'running', 1), b = session('beta', 'running', 2), { tty, home, start } = open([a, b]);
 await start();
 try {
  press(tty, ' '); await shows(tty, '◆ marked'); await shows(tty, '1 marked · Space marks one more');
  press(tty, ' '); await vi.waitFor(async () => expect(await screen(tty)).not.toContain('◆ marked'));
 } finally { await home.stop(); }
});
it('v with nothing marked does nothing but show a one-line hint; with one marked it asks for another', async () => {
 const { tty, home, splits, start } = open([session('alpha'), session('beta')]);
 await start();
 try {
  press(tty, 'v'); await shows(tty, 'Space marks 2–4 agents · v opens them side by side');
  press(tty, ' '); press(tty, 'v'); await shows(tty, 'Space marks one more agent · v opens the split');
  expect(splits).toEqual([]);
 } finally { await home.stop(); }
});
it('v opens the marked agents in list order and clears the marks; Ctrl+E home remembers the split for v', async () => {
 const a = session('alpha', 'running', 1), b = session('beta', 'running', 2), c = session('gamma', 'running', 3), { tty, home, splits, start } = open([a, b, c]);
 await start();
 try {
  press(tty, down); press(tty, down); press(tty, ' '); press(tty, '\x1b[A'); press(tty, '\x1b[A'); press(tty, ' ');
  await shows(tty, '2 marked · v opens them side by side');
  press(tty, 'v'); await vi.waitFor(() => expect(splits).toHaveLength(1));
  const order = splits[0] ?? [];
  expect(order).toEqual([a.id, c.id]);
  await vi.waitFor(async () => expect(await screen(tty)).not.toContain('◆ marked'));
  press(tty, 'v'); await vi.waitFor(() => expect(splits).toHaveLength(2));
  expect(splits[1]).toEqual(order);
 } finally { await home.stop(); }
});
it('marks follow list order, not the order they were made in', async () => {
 const a = session('alpha', 'running', 1), b = session('beta', 'running', 2), { tty, home, splits, start } = open([a, b]);
 await start();
 try {
  press(tty, down); press(tty, ' '); press(tty, '\x1b[A'); press(tty, ' '); press(tty, 'v');
  await vi.waitFor(() => expect(splits).toHaveLength(1));
  expect(splits[0]).toEqual([a.id, b.id]);
 } finally { await home.stop(); }
});
it('an exited agent cannot be marked; letter keys type once the field has text', async () => {
 const { tty, home, splits, start } = open([session('done one', 'exited', 1), session('beta', 'running', 2)]);
 await start();
 try {
  press(tty, ' '); await shows(tty, 'done one has exited · x removes it');
  press(tty, 'a'); press(tty, ' '); press(tty, 'v');
  await shows(tty, 'a v'); expect(splits).toEqual([]);
 } finally { await home.stop(); }
});
it('when only one pane is left it becomes a normal attach, and the split is not remembered', async () => {
 const a = session('alpha', 'running', 1), b = session('beta', 'running', 2), { tty, home, splits, attaches, start } = open([a, b], [{ reason:'one left', remaining:b.id, dropped:1 }]);
 await start();
 try {
  press(tty, ' '); press(tty, down); press(tty, ' '); press(tty, 'v');
  await vi.waitFor(() => expect(attaches).toEqual([b.id]));
  await shows(tty, "only one pane fits · 1 agent didn't fit");
  press(tty, 'v'); await shows(tty, 'Space marks 2–4 agents'); expect(splits).toHaveLength(1);
 } finally { await home.stop(); }
});
