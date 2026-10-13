import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Homepage } from '../src/client/tui/homepage.js';
import { lossText } from '../src/client/tui/worktree-question.js';
import { DaemonRequestError } from '../src/client/connection.js';
import type { SessionInfo, SuccessResponse, WorktreeView } from '../src/shared/protocol.js';
import type { RequestBody } from '../src/client/connection.js';
import headless from '@xterm/headless';
const now = new Date().toISOString(), fingerprint = 'b'.repeat(64);
const session = (title: string, worktree?: string): SessionInfo => ({ id:randomUUID(), title, engine:'codex', model:'gpt', auth:{ kind:'account' }, cwd:'/tmp', ...(worktree ? { worktree, branch:`ai/${title}` } : {}), permission:'ask', status:'exited', statusDetail:'exit 0', statusSince:now, createdAt:now, lastOutputAt:null, exitCode:0, ctxPercent:null });
const clean: WorktreeView = { path:'/tmp/trees/agent', branch:'ai/agent', loss:{ changed:0, untracked:0, ignored:2, repos:0, commits:0, base:'main', baseSource:'recorded', missing:false }, fingerprint };
const lossy: WorktreeView = { ...clean, loss:{ changed:3, untracked:2, ignored:0, repos:0, commits:4, base:'main', baseSource:'recorded', missing:false } };
class TTY extends EventEmitter { isTTY = true; isRaw = false; columns = 130; rows = 45; output = ''; setRawMode(v: boolean) { this.isRaw = v; } resume() {} pause() {} write(data: string | Buffer) { this.output += data.toString(); return true; } }
// The homepage writes only changed cells, so read the screen through a terminal emulator rather than the byte stream.
async function screen(tty: TTY): Promise<string> { const terminal = new headless.Terminal({ cols:130, rows:45, allowProposedApi:true }); try { await new Promise<void>(resolve => terminal.write(tty.output, resolve)); return Array.from({ length:45 }, (_, y) => terminal.buffer.active.getLine(y)?.translateToString() ?? '').join('\n'); } finally { terminal.dispose(); } }
const shows = (tty: TTY, text: string) => vi.waitFor(async () => expect(await screen(tty)).toContain(text));
class Client extends EventEmitter {
 requests: RequestBody[] = []; sessions: SessionInfo[]; views: WorktreeView[]; check: WorktreeView[]; deleteError?: string;
 constructor(sessions: SessionInfo[], check: WorktreeView[] = [clean], views: WorktreeView[] = []) { super(); this.sessions = sessions; this.check = check; this.views = views; }
 async request(body: RequestBody): Promise<SuccessResponse> {
  this.requests.push(body); const response: SuccessResponse = { id:randomUUID(), ok:true };
  if (body.kind === 'settings.get') response.settings = { theme:'graphite' };
  if (body.kind === 'sessions.list') response.sessions = this.sessions;
  if (body.kind === 'sessions.preview') { response.snapshot = ''; response.cols = 85; response.rows = 30; }
  if (body.kind === 'sessions.remove') { const removed = this.sessions.find(s => s.id === body.sessionId); this.emit('event', { kind:'session.removed', sessionId:body.sessionId }); if (removed?.worktree) response.keptWorktree = removed.worktree; }
  if (body.kind === 'worktrees.check') response.worktree = this.check.length > 1 ? this.check.shift() : this.check[0];
  if (body.kind === 'worktrees.list') response.worktrees = this.views;
  if (body.kind === 'worktrees.delete') { if (this.deleteError) { const message = this.deleteError; this.deleteError = undefined; throw new DaemonRequestError(message); } response.deletedWorktree = body.path; }
  return response;
 }
}
async function open(client: Client) { const tty = new TTY(), home = new Homepage(client, { stdin:tty, stdout:tty, signals:new EventEmitter(), cwd:'/tmp', terminalProgram:'unknown' }); await home.start(); return { tty, home }; }
const type = (tty: TTY, text: string) => { for (const char of text) tty.emit('data', Buffer.from(char)); };
const press = (tty: TTY, key: string) => tty.emit('data', Buffer.from(key));
const deletes = (client: Client) => client.requests.filter(r => r.kind === 'worktrees.delete');
// Esc arrives through the parser's 30 ms lone-escape timer.
const escape = async (tty: TTY) => { press(tty, '\x1b'); await new Promise(resolve => setTimeout(resolve, 60)); };

it('describes loss plainly, with singular forms and base notes', () => {
 expect(lossText(lossy.loss!)).toBe('3 changed files · 2 untracked · 4 commits not in main');
 expect(lossText({ changed:1, untracked:1, ignored:0, repos:0, commits:1, base:'main', baseSource:'recorded', missing:false })).toBe('1 changed file · 1 untracked · 1 commit not in main');
 expect(lossText({ changed:0, untracked:0, ignored:0, repos:0, commits:2, base:'abc1234', baseSource:'start commit', missing:true })).toBe('2 commits since its start (abc1234)');
});
it('x on a clean worktree asks one question; Esc, k and Enter keep, and none of them delete', async () => {
 for (const keep of ['esc', 'k', '\r']) {
  const client = new Client([session('agent', '/tmp/trees/agent')]), { tty, home } = await open(client);
  try {
   press(tty, 'x'); await shows(tty, 'remove worktree and branch ai/agent? k keep · d delete');
   expect(await screen(tty)).toContain('✓ nothing would be lost'); expect(await screen(tty)).toContain('2 ignored files go with it');
   if (keep === 'esc') await escape(tty); else press(tty, keep);
   await shows(tty, 'worktree kept: /tmp/trees/agent'); expect(deletes(client)).toEqual([]);
  } finally { await home.stop(); }
 }
});
it('d deletes a clean worktree with the fingerprint it showed and no confirmation', async () => {
 const client = new Client([session('agent', '/tmp/trees/agent')]), { tty, home } = await open(client);
 try {
  press(tty, 'x'); await shows(tty, 'k keep · d delete'); press(tty, 'd');
  await shows(tty, '✓ deleted worktree and branch ai/agent');
  expect(deletes(client)).toEqual([{ kind:'worktrees.delete', path:'/tmp/trees/agent', fingerprint }]);
 } finally { await home.stop(); }
});
it('loss is listed plainly and only the typed branch name plus Enter deletes; one keypress never does', async () => {
 const client = new Client([session('agent', '/tmp/trees/agent')], [lossy]), { tty, home } = await open(client);
 try {
  press(tty, 'x'); await shows(tty, '! would be lost: 3 changed files · 2 untracked · 4 commits not in main');
  expect(await screen(tty)).toContain('type ai/agent and ⏎ to delete · k or Esc keeps');
  press(tty, 'd'); press(tty, '\r'); await shows(tty, 'type ai/agent exactly to delete');
  for (let i = 0; i < 3; i++) press(tty, '\x7f');
  type(tty, 'ai/agen'); press(tty, '\r'); expect(deletes(client)).toEqual([]);
  type(tty, 't'); press(tty, '\r');
  await shows(tty, '✓ deleted worktree and branch ai/agent');
  expect(deletes(client)).toEqual([{ kind:'worktrees.delete', path:'/tmp/trees/agent', fingerprint, confirm:'ai/agent' }]);
 } finally { await home.stop(); }
});
it('with loss, k on an empty field and Enter on an empty field keep; a paste never fills the confirmation', async () => {
 for (const keep of ['k', '\r']) {
  const client = new Client([session('agent', '/tmp/trees/agent')], [lossy]), { tty, home } = await open(client);
  try {
   press(tty, 'x'); await shows(tty, 'k or Esc keeps');
   press(tty, '\x1b[200~ai/agent\x1b[201~'); press(tty, keep);
   await shows(tty, 'worktree kept: /tmp/trees/agent'); expect(deletes(client)).toEqual([]);
  } finally { await home.stop(); }
 }
});
it('a worktree that changed after it was shown is checked again and asked again', async () => {
 const client = new Client([session('agent', '/tmp/trees/agent')], [clean, lossy]), { tty, home } = await open(client);
 client.deleteError = 'Changed since you confirmed; check again';
 try {
  press(tty, 'x'); await shows(tty, 'k keep · d delete'); press(tty, 'd');
  await shows(tty, 'Changed since you confirmed; check again');
  await shows(tty, '! would be lost: 3 changed files');
  expect(deletes(client)).toHaveLength(1);
 } finally { await home.stop(); }
});
it('a refused worktree is kept with its fixed reason and no question', async () => {
 const client = new Client([session('agent', '/tmp/trees/agent')], [{ ...clean, refusal:'Worktree is locked' }]), { tty, home } = await open(client);
 try {
  press(tty, 'x'); await shows(tty, 'worktree kept: /tmp/trees/agent · Worktree is locked');
  expect(await screen(tty)).not.toContain('k keep · d delete');
 } finally { await home.stop(); }
});
it('a failed step is reported with its fixed text', async () => {
 const client = new Client([session('agent', '/tmp/trees/agent')]), { tty, home } = await open(client);
 client.deleteError = 'Worktree removed; branch delete failed';
 try {
  press(tty, 'x'); await shows(tty, 'k keep · d delete'); press(tty, 'd');
  await shows(tty, 'Worktree removed; branch delete failed · ai/agent');
 } finally { await home.stop(); }
});
it('/clean removes records, keeps every worktree and says how many', async () => {
 const client = new Client([session('a', '/tmp/trees/a'), session('b', '/tmp/trees/b'), session('c')]), { tty, home } = await open(client);
 try {
  type(tty, '/clean'); press(tty, '\r'); await shows(tty, 'remove 3 finished agents? y/n'); press(tty, 'y');
  await shows(tty, 'removed 3, 0 failed · kept 2 worktrees · /worktrees reviews them');
  expect(client.requests.filter(r => r.kind === 'worktrees.check' || r.kind === 'worktrees.delete')).toEqual([]);
 } finally { await home.stop(); }
});
it('/worktrees lists branch, folder, loss and agent; Enter opens the same question; Esc closes', async () => {
 const agent = session('agent', '/tmp/trees/agent'), views: WorktreeView[] = [
  { ...clean, agent:{ id:agent.id, title:'agent', status:'exited' } },
  { ...lossy, path:'/tmp/trees/old', branch:'ai/old' },
  { path:'/tmp/trees/stray', refusal:"Not in AI Term's record" },
  { ...clean, path:'/tmp/trees/live', branch:'ai/live', refusal:'Stop the agent first', agent:{ id:randomUUID(), title:'live', status:'running' } },
 ];
 const client = new Client([agent], [{ ...lossy, path:'/tmp/trees/old', branch:'ai/old' }], views), { tty, home } = await open(client);
 try {
  type(tty, '/worktrees'); press(tty, '\r');
  await shows(tty, 'Worktrees 4');
  for (const text of ['ai/agent', '/tmp/trees/agent', '✓ nothing would be lost', 'agent agent · ■ exited', 'ai/old', '! 3 changed files · 2 untracked · 4 commits not in main', '/tmp/trees/stray', "✗ Not in AI Term's record", '◐ running · Stop the agent first', '↑↓ select · ⏎ keep or delete · Esc close'])
   expect(await screen(tty)).toContain(text);
  press(tty, '\x1b[B'); press(tty, '\r');
  await vi.waitFor(() => expect(client.requests).toContainEqual({ kind:'worktrees.check', path:'/tmp/trees/old' }));
  await shows(tty, 'type ai/old and ⏎ to delete · k or Esc keeps');
  await escape(tty); await shows(tty, 'worktree kept: /tmp/trees/old');
  expect(client.requests.filter(r => r.kind === 'worktrees.list').length).toBeGreaterThanOrEqual(2);
  await escape(tty); expect(deletes(client)).toEqual([]);
 } finally { await home.stop(); }
});
