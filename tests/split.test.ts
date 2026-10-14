import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import headless from '@xterm/headless';
import { split, DOUBLE_PRESS_MS, type SplitConnection } from '../src/client/split.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SessionInfo, SuccessResponse, TerminalModes } from '../src/shared/protocol.js';
import { createTheme } from '../src/client/tui/theme.js';

const now = new Date().toISOString();
const session = (title: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ id:randomUUID(), title, engine:'claude-code', model:'opus', auth:{ kind:'account' }, cwd:'/tmp', worktree:`/tmp/trees/${title}`, branch:`ai/${title}`, permission:'ask', status:'running', statusDetail:'', statusSince:now, createdAt:now, lastOutputAt:null, exitCode:null, ctxPercent:null, ...extra });
const modes = (extra: Partial<TerminalModes> = {}): TerminalModes => ({ applicationCursorKeys:false, applicationKeypad:false, bracketedPaste:true, mouseTracking:'none', mouseEncoding:'default', focusEvents:false, cursorVisible:true, ...extra });
class TTY extends EventEmitter {
 isTTY = true; isRaw = false; columns = 130; rows = 45; output = ''; probe = true; full = false;
 setRawMode(raw: boolean) { this.isRaw = raw; } resume() {} pause() {}
 write(data: string | Buffer) { this.output += data.toString(); if (this.probe && data.toString().includes('\x1b[c')) queueMicrotask(() => this.emit('data', Buffer.from('\x1b[?1;2c'))); return !this.full; }
}
class Conn extends EventEmitter implements SplitConnection {
 requests: RequestBody[] = []; sent: Buffer[] = []; closed = false; paused = 0; resumed = 0;
 constructor(private readonly sessions: Map<string, { info: SessionInfo; modes: TerminalModes; snapshot: string }>, private readonly attachDelay = 0) { super(); }
 async request(body: RequestBody): Promise<SuccessResponse> {
  this.requests.push(body);
  if (body.kind === 'sessions.attach' && this.attachDelay) await new Promise(r => setTimeout(r, this.attachDelay));
  if (body.kind === 'sessions.attach') { const s = this.sessions.get(body.sessionId); if (!s) throw new Error('Session unavailable'); return { id:randomUUID(), ok:true, snapshot:s.snapshot, cols:body.cols, rows:body.rows, modes:s.modes, session:s.info }; }
  return { id:randomUUID(), ok:true };
 }
 input(_id: string, data: Buffer) { this.sent.push(data); }
 pauseOutput() { this.paused++; } resumeOutput() { this.resumed++; } close() { this.closed = true; }
 typed() { return Buffer.concat(this.sent).toString('latin1'); }
 attachedTo() { const attach = this.requests.find(r => r.kind === 'sessions.attach'); return attach?.kind === 'sessions.attach' ? attach.sessionId : ''; }
}
async function screen(tty: TTY): Promise<string> {
 const terminal = new headless.Terminal({ cols:tty.columns, rows:tty.rows, allowProposedApi:true });
 try { await new Promise<void>(resolve => terminal.write(tty.output, resolve)); return Array.from({ length:tty.rows }, (_, y) => terminal.buffer.active.getLine(y)?.translateToString() ?? '').join('\n'); }
 finally { terminal.dispose(); }
}
const shows = (tty: TTY, text: string) => vi.waitFor(async () => expect(await screen(tty)).toContain(text));
function setup(count = 2, options: { modes?: Partial<TerminalModes>[]; infos?: Partial<SessionInfo>[]; cols?: number; rows?: number; attachDelay?: number; failConnect?: number } = {}) {
 const infos = Array.from({ length:count }, (_, i) => session(`agent${i + 1}`, options.infos?.[i]));
 const sessions = new Map(infos.map((info, i) => [info.id, { info, modes:modes(options.modes?.[i]), snapshot:`hello from ${info.title}` }]));
 const tty = new TTY(), signals = new EventEmitter(), connections: Conn[] = [];
 tty.columns = options.cols ?? 130; tty.rows = options.rows ?? 45;
 let clock = 1000;
 const run = split(infos.map(i => i.id), { stdin:tty, stdout:tty, signals, theme:createTheme('graphite'), now:() => clock, connect:async () => { if (connections.length === options.failConnect) { connections.push(new Conn(sessions)); throw new Error('connect failed'); } const c = new Conn(sessions, options.attachDelay); connections.push(c); return c; } });
 const conn = (i: number) => { const info = infos[i]; const c = connections.find(x => x.attachedTo() === info?.id); if (!c) throw new Error('no connection'); return c; };
 return { infos, tty, signals, run, conn, connections, tick:(ms: number) => { clock += ms; } };
}
const press = (tty: TTY, data: string | number[]) => tty.emit('data', Buffer.from(typeof data === 'string' ? data : data));
const ready = (tty: TTY) => shows(tty, 'each pane is its own agent in its own worktree');

it('opens two panes side by side, each agent attached at its pane size minus the header', async () => {
 const { tty, run, conn, infos } = setup();
 await ready(tty);
 expect(conn(0).requests[0]).toEqual({ kind:'sessions.attach', sessionId:infos[0]?.id, cols:65, rows:43 });
 expect(conn(1).requests[0]).toEqual({ kind:'sessions.attach', sessionId:infos[1]?.id, cols:64, rows:43 });
 const text = await screen(tty);
 for (const part of ['◐ running', 'agent1', 'opus · ai/agent1', 'agent2', 'hello from agent1', 'hello from agent2', '^\\ next pane · ^\\ ^\\ sends ^\\ · ^E home']) expect(text).toContain(part);
 expect(tty.output).toContain('\x1b[?1003h\x1b[?1006h');
 press(tty, [5]); await expect(run).resolves.toEqual({ reason:'home key', dropped:0 });
});
it('keys reach only the focused pane; Ctrl+\\ moves focus; Ctrl+\\ is never typed into an agent', async () => {
 const { tty, run, conn, tick } = setup();
 await ready(tty);
 press(tty, 'one'); press(tty, [0x1c]); tick(DOUBLE_PRESS_MS + 1); press(tty, 'two'); press(tty, [0x1c]); tick(DOUBLE_PRESS_MS + 1); press(tty, '!');
 expect(conn(0).typed()).toBe('one!'); expect(conn(1).typed()).toBe('two');
 press(tty, '\x1b[200~pasted\x1c text\x1b[201~');
 expect(conn(0).typed()).toBe('one!\x1b[200~pasted\x1c text\x1b[201~'); expect(conn(1).typed()).toBe('two');
 press(tty, [5]); await run;
});
it('Ctrl+\\ twice quickly goes back and sends that agent one real Ctrl+\\, in the encoding it arrived in', async () => {
 const { tty, run, conn, tick } = setup();
 await ready(tty);
 press(tty, [0x1c]); tick(100); press(tty, [0x1c]);
 expect(conn(0).typed()).toBe('\x1c'); expect(conn(1).typed()).toBe('');
 press(tty, 'a'); expect(conn(0).typed()).toBe('\x1ca');
 tick(DOUBLE_PRESS_MS + 1); press(tty, '\x1b[92;5u'); tick(50); press(tty, '\x1b[92;5u');
 expect(conn(0).typed()).toBe('\x1ca\x1b[92;5u'); expect(conn(1).typed()).toBe('');
 tick(DOUBLE_PRESS_MS + 1); press(tty, [0x1c]); tick(DOUBLE_PRESS_MS + 1); press(tty, [0x1c]); press(tty, 'b');
 expect(conn(0).typed()).toBe('\x1ca\x1b[92;5ub');
 press(tty, [5]); await run;
});
it('Ctrl+E goes home: every pane detaches, its connection closes and the terminal is restored', async () => {
 const { tty, run, connections } = setup();
 await ready(tty);
 press(tty, '\x1b[101;5u');
 await expect(run).resolves.toMatchObject({ reason:'home key' });
 for (const c of connections) { expect(c.requests.at(-1)).toMatchObject({ kind:'sessions.detach' }); expect(c.closed).toBe(true); expect(c.typed()).toBe(''); }
 expect(tty.isRaw).toBe(false); expect(tty.output.endsWith('\x1b[?1049l')).toBe(true);
});
it('mouse events go to the pane under the pointer in its own coordinates and encoding; a click focuses it', async () => {
 const { tty, run, conn } = setup(2, { modes:[{ mouseTracking:'vt200', mouseEncoding:'default' }, { mouseTracking:'vt200', mouseEncoding:'sgr' }] });
 await ready(tty);
 press(tty, '\x1b[<0;71;6M\x1b[<0;71;6m');
 expect(conn(1).typed()).toBe('\x1b[<0;5;5M\x1b[<0;5;5m'); expect(conn(0).typed()).toBe('');
 press(tty, 'k'); expect(conn(1).typed()).toContain('k');
 press(tty, '\x1b[<0;3;3M\x1b[<0;3;3m');
 expect(conn(0).typed()).toBe('\x1b[M' + String.fromCharCode(32, 35, 34) + '\x1b[M' + String.fromCharCode(35, 35, 34));
 // A header click only focuses; a divider click is nobody's.
 press(tty, '\x1b[<0;80;1M\x1b[<0;80;1m'); press(tty, '\x1b[<0;66;9M\x1b[<0;66;9m'); press(tty, 'z');
 expect(conn(1).typed()).toBe('\x1b[<0;5;5M\x1b[<0;5;5mkz');
 press(tty, [5]); await run;
});
it('a drag stays with the pane it started in, clamped to its edge', async () => {
 const { tty, run, conn } = setup(2, { modes:[{ mouseTracking:'drag', mouseEncoding:'sgr' }, { mouseTracking:'drag', mouseEncoding:'sgr' }] });
 await ready(tty);
 press(tty, '\x1b[<0;60;10M\x1b[<32;90;10M\x1b[<0;90;10m');
 expect(conn(0).typed()).toBe('\x1b[<0;60;9M\x1b[<32;65;9M\x1b[<0;65;9m'); expect(conn(1).typed()).toBe('');
 press(tty, [5]); await run;
});
it('an agent that exits keeps its pane with its exit state until Ctrl+\\; then one pane left becomes a normal attach', async () => {
 const { tty, run, conn, infos } = setup();
 await ready(tty);
 const exited = { ...infos[1], status:'exited', statusDetail:'exit 0', exitCode:0 } as SessionInfo;
 conn(1).emit('event', { kind:'session.updated', session:exited });
 await shows(tty, '■ exited · exit 0');
 expect(await screen(tty)).toContain('^\\ closes');
 press(tty, '\x1b[<0;80;1M\x1b[<0;80;1m'); press(tty, 'lost');
 expect(conn(1).typed()).toBe('');
 press(tty, [0x1c]);
 await expect(run).resolves.toEqual({ reason:'one left', remaining:infos[0]?.id, dropped:0 });
 expect(conn(1).closed).toBe(true); expect(conn(0).requests.at(-1)).toMatchObject({ kind:'sessions.detach' });
});
it('with three panes, closing an exited pane gives the rest its room and keeps the split', async () => {
 const { tty, run, conn, infos } = setup(3);
 await ready(tty);
 conn(1).emit('event', { kind:'session.updated', session:{ ...infos[1], status:'error', statusDetail:'exit 2', exitCode:2 } });
 await shows(tty, '✗ failed · exit 2');
 press(tty, [0x1c]);
 await vi.waitFor(() => expect(conn(0).requests).toContainEqual({ kind:'sessions.resize', sessionId:infos[0]?.id, cols:65, rows:43 }));
 expect(conn(2).requests).toContainEqual({ kind:'sessions.resize', sessionId:infos[2]?.id, cols:64, rows:43 });
 press(tty, 'still'); expect(conn(0).typed()).toBe('still');
 press(tty, [5]); await expect(run).resolves.toMatchObject({ reason:'home key' });
});
it('resizing re-lays the panes and resizes each agent; too small a window shows a note and types nowhere', async () => {
 const { tty, run, conn, infos, signals } = setup();
 await ready(tty);
 tty.columns = 100; tty.rows = 30; signals.emit('SIGWINCH');
 expect(conn(0).requests).toContainEqual({ kind:'sessions.resize', sessionId:infos[0]?.id, cols:50, rows:28 });
 expect(conn(1).requests).toContainEqual({ kind:'sessions.resize', sessionId:infos[1]?.id, cols:49, rows:28 });
 tty.columns = 60; signals.emit('SIGWINCH');
 await shows(tty, 'make the window bigger · ^E home');
 press(tty, 'nowhere'); expect(conn(0).typed()).toBe('');
 tty.columns = 100; signals.emit('SIGWINCH'); press(tty, 'back');
 expect(conn(0).typed()).toBe('back');
 press(tty, [5]); await run;
});
it('a terminal too small for every agent opens as many panes as fit and says how many did not', async () => {
 const small = setup(3, { cols:100, rows:30 });
 await shows(small.tty, "1 agent didn't fit");
 expect(small.connections).toHaveLength(2);
 press(small.tty, [5]); await expect(small.run).resolves.toMatchObject({ reason:'home key', dropped:1 });
 const tiny = setup(3, { cols:70, rows:30 });
 await expect(tiny.run).resolves.toEqual({ reason:'one left', remaining:tiny.infos[0]?.id, dropped:2 });
 expect(tiny.connections).toHaveLength(0); expect(tiny.tty.output).toBe('');
});
it('background panes reach the terminal only as cells: no bell, title or clipboard; OSC 52 reads are always dropped', async () => {
 const { tty, run, conn, infos } = setup();
 await ready(tty);
 tty.output = '';
 conn(1).emit('output', infos[1]?.id, Buffer.from('\x07\x1b]2;bg title\x07\x1b]52;c;YmFk\x07BG_TEXT'));
 conn(0).emit('output', infos[0]?.id, Buffer.from('\x1b]2;fg title\x07\x1b]52;c;?\x07FG_TEXT'));
 await shows(tty, 'BG_TEXT'); await shows(tty, 'FG_TEXT');
 expect(tty.output).not.toContain('\x07'); expect(tty.output).not.toContain('bg title'); expect(tty.output).not.toContain('52;c;YmFk'); expect(tty.output).not.toContain('52;c;?');
 expect(tty.output).toContain('\x1b]2;fg title');
 press(tty, [5]); await run;
});
it('focus hands the real terminal the focused agent\'s keyboard modes', async () => {
 const { tty, run, tick } = setup(2, { modes:[{ bracketedPaste:false }, { bracketedPaste:true, applicationCursorKeys:true }] });
 await ready(tty);
 tty.output = ''; press(tty, [0x1c]); tick(DOUBLE_PRESS_MS + 1);
 expect(tty.output).toContain('\x1b[?1h'); expect(tty.output).toContain('\x1b[?2004h');
 tty.output = ''; press(tty, [0x1c]);
 expect(tty.output).toContain('\x1b[?1l'); expect(tty.output).toContain('\x1b[?2004l'); expect(tty.output).not.toContain('\x1b[?1003l');
 press(tty, [5]); await run;
});
it('a flooding pane is paused at its own connection and resumed once its mirror catches up', async () => {
 const { tty, run, conn, infos } = setup();
 await ready(tty);
 for (let i = 0; i < 40; i++) conn(1).emit('output', infos[1]?.id, Buffer.from('y\r\n'.repeat(16 * 1024)));
 expect(conn(1).paused).toBe(1); expect(conn(0).paused).toBe(0);
 await vi.waitFor(() => expect(conn(1).resumed).toBe(1), { timeout:10000 });
 press(tty, [5]); await run;
});
it('a removed agent closes its pane at once', async () => {
 const { tty, run, conn, infos } = setup();
 await ready(tty);
 conn(1).emit('event', { kind:'session.removed', sessionId:infos[1]?.id });
 await expect(run).resolves.toEqual({ reason:'one left', remaining:infos[0]?.id, dropped:0 });
});
it('another client taking a pane over marks it attached elsewhere; the daemon going away ends the split with an error', async () => {
 const { tty, run, conn, infos } = setup();
 await ready(tty);
 conn(1).emit('event', { kind:'session.detached', sessionId:infos[1]?.id, reason:'attached elsewhere' });
 await shows(tty, '■ attached elsewhere');
 conn(0).emit('disconnected');
 await expect(run).rejects.toThrow('Daemon connection closed');
 expect(tty.isRaw).toBe(false);
});

// Review findings (typescript-reviewer, v0.3 splits).
it('a synchronized-output block that ends in a later chunk is drawn when it ends, not after the 150 ms hold', async () => {
 const { tty, run, conn, infos } = setup();
 await ready(tty);
 conn(0).emit('output', infos[0]?.id, Buffer.from('\x1b[?2026h\x1b[5;1HECHO-X'));
 await new Promise(r => setTimeout(r, 30));
 conn(0).emit('output', infos[0]?.id, Buffer.from('\x1b[?2026l'));
 await new Promise(r => setTimeout(r, 40));
 expect(await screen(tty)).toContain('ECHO-X');
 press(tty, [5]); await run;
});
it('leaving while panes are still attaching detaches and closes every connection', async () => {
 const { tty, run, connections } = setup(2, { attachDelay:80 });
 await new Promise(r => setTimeout(r, 20));
 press(tty, [3]);
 await expect(run).resolves.toMatchObject({ reason:'client interrupted' });
 await vi.waitFor(() => { expect(connections).toHaveLength(2); for (const c of connections) { expect(c.closed).toBe(true); expect(c.requests.at(-1)).toMatchObject({ kind:'sessions.detach' }); } });
});
it('a connection that fails to open does not leak the panes that did attach', async () => {
 const { run, connections } = setup(3, { failConnect:1 });
 await run.catch(() => undefined);
 await vi.waitFor(() => { for (const c of connections.filter(c => c.requests.length)) expect(c.closed).toBe(true); });
});
it('closing one of four panes on a terminal too narrow for three side by side keeps the agents on screen', async () => {
 const { tty, run, conn, infos } = setup(4, { cols:100, rows:40 });
 await ready(tty);
 conn(1).emit('event', { kind:'session.removed', sessionId:infos[1]?.id });
 await vi.waitFor(() => expect(conn(3).requests).toContainEqual({ kind:'sessions.resize', sessionId:infos[3]?.id, cols:100, rows:18 }));
 expect(await screen(tty)).not.toContain('make the window bigger');
 press(tty, 'still'); expect(conn(0).typed()).toBe('still');
 press(tty, [5]); await run;
});
it('a press after a lost release goes to the pane under the pointer and focuses it', async () => {
 const { tty, run, conn } = setup(2, { modes:[{ mouseTracking:'vt200', mouseEncoding:'sgr' }, { mouseTracking:'vt200', mouseEncoding:'sgr' }] });
 await ready(tty);
 press(tty, '\x1b[<0;10;10M'); press(tty, '\x1b[<0;71;6M\x1b[<0;71;6m'); press(tty, 'k');
 expect(conn(1).typed()).toBe('\x1b[<0;5;5M\x1b[<0;5;5mk'); expect(conn(0).typed()).toBe('\x1b[<0;10;9M');
 press(tty, [5]); await run;
});
it('typing sends no empty input frames', async () => {
 const { tty, run, conn } = setup();
 await ready(tty);
 press(tty, 'a'); press(tty, 'b');
 expect(conn(0).sent.map(b => b.length)).toEqual([1, 1]);
 press(tty, [5]); await run;
});
it('a full redraw asked for while the terminal is blocked happens when it drains', async () => {
 const { tty, run, signals } = setup();
 await ready(tty);
 tty.full = true; tty.write('');
 tty.columns = 100; tty.rows = 30; signals.emit('SIGWINCH');
 tty.full = false; tty.output = ''; tty.emit('drain');
 expect(tty.output).toContain('\x1b[2J');
 press(tty, [5]); await run;
});
