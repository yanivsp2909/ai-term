import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import headless from '@xterm/headless';
import { Homepage } from '../src/client/tui/homepage.js';
import { AppInput } from '../src/client/app-input.js';
import { encodeAppControl, type AppCommand } from '../src/shared/app-control.js';
import { BACKGROUND_QUERY } from '../src/client/tui/theme.js';
import { tokenColors } from '../src/shared/theme-tokens.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SessionInfo, SuccessResponse } from '../src/shared/protocol.js';

const token = 'a'.repeat(64);
class TTY extends EventEmitter {
  isTTY = true; isRaw = false; columns = 130; rows = 45; output = ''; background = tokenColors('dark').bg;
  setRawMode(value: boolean) { this.isRaw = value; } resume() {} pause() {}
  write(value: string | Buffer) {
    this.output += value.toString();
    if (value === BACKGROUND_QUERY) queueMicrotask(() => this.emit('data', Buffer.from('\x1b]11;rgb:' + this.background.slice(1).match(/../g)?.join('/') + '\x1b\\')));
    return true;
  }
}
class Client extends EventEmitter {
  requests: RequestBody[] = []; input = vi.fn();
  sessions: SessionInfo[] = [1,2].map(n => ({ id: randomUUID(), title: 'agent ' + n, engine: 'shell', model: null, auth: {kind:'account'}, cwd:'/tmp', permission:'ask', status:'running', statusDetail:'running', statusSince:'2026-10-14T12:00:00Z', createdAt:`2026-10-14T12:00:0${n}Z`, lastOutputAt:null, exitCode:null, ctxPercent:null }));
  async request(body: RequestBody): Promise<SuccessResponse> {
    this.requests.push(body); const result: SuccessResponse = { id:randomUUID(), ok:true };
    if (body.kind === 'settings.get') result.settings = {theme:'graphite'};
    if (body.kind === 'sessions.list') result.sessions = this.sessions;
    if (body.kind === 'keys.list') result.keys = [];
    if (body.kind === 'sessions.preview') { result.snapshot = ''; result.cols = 88; result.rows = 27; }
    if (body.kind === 'engines.status') result.engines = { claudeCode:{installed:true,path:'/stub/claude',version:'1',loggedIn:true,authMethod:'subscription'}, codex:{installed:true,path:'/stub/codex',version:'1',loggedIn:true,authMethod:'subscription'} };
    return result;
  }
}
async function fixture() {
  const tty = new TTY(), client = new Client(), input = new AppInput(tty, token);
  const attached = vi.fn(async (_id: string, signal?: AbortSignal) => {
    await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener('abort', () => resolve(), {once:true}); });
    return 'home key' as const;
  });
  const split = vi.fn(async () => ({reason:'home key' as const,dropped:0}));
  const home = new Homepage(client, {stdin:input, stdout:tty, controls:input, signals:new EventEmitter(), cwd:'/tmp', attachSession:attached, splitSessions:split});
  await home.start();
  const send = (data: string) => tty.emit('data', Buffer.from(data));
  const command = (action: AppCommand) => send(encodeAppControl(token, action));
  const screen = async () => {
    const terminal = new headless.Terminal({cols:tty.columns,rows:tty.rows,allowProposedApi:true});
    try { await new Promise<void>(resolve => terminal.write(tty.output, resolve)); return Array.from({length:tty.rows}, (_,y) => terminal.buffer.active.getLine(y)?.translateToString() ?? '').join('\n'); }
    finally {terminal.dispose();}
  };
  return {tty,client,input,home,attached,split,send,command,screen,dispose:async()=>{await home.stop();input.dispose();}};
}
it('palette/new-agent/settings/select/split route to home UI without creating or sending an agent message', async () => {
  const f = await fixture();
  try {
    f.command('palette'); await expect.poll(f.screen).toContain('/settings');
    f.command('new-agent'); await expect.poll(f.screen).toContain('Start a new agent');
    f.command('settings'); await expect.poll(f.screen).toContain('Settings');
    f.command('select 1'); await expect.poll(() => f.client.requests.filter(r=>r.kind==='sessions.preview'&&r.sessionId!==null).at(-1)).toMatchObject({sessionId:f.client.sessions[1]?.id});
    f.send(' '); f.command('select 2'); await expect.poll(() => f.client.requests.filter(r=>r.kind==='sessions.preview'&&r.sessionId!==null).at(-1)).toMatchObject({sessionId:f.client.sessions[0]?.id});
    f.send(' '); f.command('split'); await expect.poll(() => f.split.mock.calls.length).toBe(1);
    expect(f.client.requests.some(r=>r.kind==='sessions.create')).toBe(false); expect(f.client.input).not.toHaveBeenCalled();
  } finally {await f.dispose();}
});
it('home returns from an attached session through cancellation, without synthesizing input', async () => {
  const f = await fixture();
  try {
    f.send('\r'); await expect.poll(()=>f.attached.mock.calls.length).toBe(1);
    f.command('palette'); await expect.poll(f.screen).toContain('/settings');
    expect(f.client.input).not.toHaveBeenCalled();
  } finally {await f.dispose();}
});
it('theme-changed reprobes OSC11 and redraws auto despite the saved graphite theme', async () => {
  const f = await fixture();
  try {
    expect(f.home.currentTheme().colors.bg).toBe(tokenColors('dark').bg);
    f.tty.background = tokenColors('light').bg; f.command('theme-changed');
    await expect.poll(()=>f.home.currentTheme().colors.bg).toBe(tokenColors('light').bg);
    expect(f.home.currentTheme().colors.ink).toBe(tokenColors('light').ink);
    expect(f.tty.output.split(BACKGROUND_QUERY)).toHaveLength(3);
  } finally {await f.dispose();}
});
it('pasted and agent-printed controls never dispatch or reach an attached agent', async () => {
  const f = await fixture(), commands = vi.fn(), data = vi.fn();
  try {
    f.input.on('command',commands); f.input.on('data',data);
    f.send('\x1b[200~' + encodeAppControl(token,'new-agent') + '\x1b[201~');
    f.client.emit('output', f.client.sessions[0]?.id, Buffer.from(encodeAppControl(token,'new-agent')));
    expect(commands).not.toHaveBeenCalled();
    expect(data.mock.calls.map(call=>(call[0] as Buffer).toString()).join('')).toBe('\x1b[200~\x1b[201~');
    expect(await f.screen()).not.toContain('Start a new agent');
  } finally {await f.dispose();}
});
