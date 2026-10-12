import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import headless from '@xterm/headless';
import { Homepage } from '../src/client/tui/homepage.js';
import { CommandField, InputParser, type InputEvent } from '../src/client/tui/keys.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SuccessResponse } from '../src/shared/protocol.js';

class TTY extends EventEmitter {
  isTTY = true; isRaw = false; columns = 130; rows = 45; output = '';
  setRawMode(value: boolean) { this.isRaw = value; } resume() {} pause() {}
  write(value: string | Buffer) { this.output += value.toString(); return true; }
}
class Client extends EventEmitter {
  requests: RequestBody[] = []; input = vi.fn();
  async request(body: RequestBody): Promise<SuccessResponse> {
    this.requests.push(body);
    const result: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.get') result.settings = { theme: 'graphite' };
    if (body.kind === 'sessions.list') result.sessions = [];
    if (body.kind === 'keys.list') result.keys = [];
    if (body.kind === 'engines.status') result.engines = {
      claudeCode: { installed: true, path: '/stub/claude', version: '1', loggedIn: true, authMethod: 'subscription' },
      codex: { installed: true, path: '/stub/codex', version: '1', loggedIn: true, authMethod: 'subscription' },
    };
    if (body.kind === 'sessions.create' && body.engine !== 'shell') {
      const now = new Date().toISOString();
      result.session = { id: randomUUID(), title: 'test agent', engine: body.engine, model: body.model, auth: { kind: 'account' }, cwd: body.cwd, permission: body.permission, status: 'starting', statusDetail: 'starting', statusSince: now, createdAt: now, lastOutputAt: null, exitCode: null, ctxPercent: null };
    }
    if (body.kind === 'sessions.preview') { result.snapshot = ''; result.cols = 88; result.rows = 27; }
    return result;
  }
}
async function fixture() {
  const tty = new TTY(), client = new Client(), logs: string[] = [], copy = vi.fn(async () => {});
  const home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', copy, copyLog: { error: text => logs.push(text) } });
  await home.start(); return { tty, client, home, logs, copy };
}
const send = (tty: TTY, text: string) => tty.emit('data', Buffer.from(text));
const paste = (tty: TTY, text: string) => send(tty, '\x1b[200~' + text + '\x1b[201~');
async function screen(tty: TTY) {
  const terminal = new headless.Terminal({ cols: tty.columns, rows: tty.rows, allowProposedApi: true });
  try {
    await new Promise<void>(resolve => terminal.write(tty.output, resolve));
    return Array.from({ length: tty.rows }, (_, y) => terminal.buffer.active.getLine(y)?.translateToString() ?? '').join('\n');
  } finally { terminal.dispose(); }
}
const messageRow = '\x1b[B'.repeat(4);
const tooLong = 'too long for a first message (16 KB): start the agent, then paste inside';

it('parser preserves fragmented UTF-8, CRLF, tabs and escape-looking text across the old 4096 cap', () => {
  const events: InputEvent[] = [], parser = new InputParser(event => events.push(event));
  const text = 'first\r\n\t' + '界'.repeat(1800) + '\n\x1b[31m literal';
  const bytes = Buffer.from('\x1b[200~' + text + '\x1b[201~c');
  try {
    for (let i = 0; i < bytes.length; i += 7) parser.push(bytes.subarray(i, i + 7));
    expect(events).toEqual([{ kind: 'paste', text }, { kind: 'key', key: 'c' }]);
  } finally { parser.dispose(); }
});
it.each(['line one\nline two', 'x'.repeat(201)])('command bar tokens become the intact first message', async text => {
  const f = await fixture();
  try {
    paste(f.tty, 'before '); paste(f.tty, text); send(f.tty, ' after');
    expect(await screen(f.tty)).toContain(`[pasted · ${text.includes('\n') ? 2 : 1} lines] after`);
    send(f.tty, '\r'); await expect.poll(() => screen(f.tty)).toContain('Start a new agent');
    expect(await screen(f.tty)).toContain('[pasted ·');
    send(f.tty, '\r'); await expect.poll(() => f.client.requests.some(r => r.kind === 'sessions.create')).toBe(true);
    expect(f.client.requests.find(r => r.kind === 'sessions.create')).toMatchObject({ firstMessage: 'before ' + text + ' after' });
    expect(f.client.input).not.toHaveBeenCalled(); expect(f.copy).not.toHaveBeenCalled(); expect(f.logs).toEqual([]);
  } finally { await f.home.stop(); }
});
it('small pastes and typed 201-character text stay literal; a token deletes as one backspace and suppresses shortcuts', async () => {
  const f = await fixture();
  try {
    paste(f.tty, 'x'.repeat(200)); expect(await screen(f.tty)).not.toContain('[pasted');
    send(f.tty, '\x1b'); await new Promise(r => setTimeout(r, 120));
    send(f.tty, 'x'.repeat(201)); expect(await screen(f.tty)).not.toContain('[pasted');
    send(f.tty, '\x1b'); await new Promise(r => setTimeout(r, 120));
    paste(f.tty, 'before '); paste(f.tty, 'first\nsecond'); send(f.tty, 'cprsxb');
    expect(await screen(f.tty)).toContain('[pasted · 2 lines]cprsxb');
    send(f.tty, '\x7f'.repeat(6) + '\x7f'); expect(await screen(f.tty)).not.toContain('[pasted');
    send(f.tty, '\r'); await expect.poll(() => screen(f.tty)).toContain('Start a new agent'); send(f.tty, '\r');
    await expect.poll(() => f.client.requests.some(r => r.kind === 'sessions.create')).toBe(true);
    expect(f.client.requests.find(r => r.kind === 'sessions.create')).toMatchObject({ firstMessage: 'before ' });
    expect(f.copy).not.toHaveBeenCalled();
  } finally { await f.home.stop(); }
});
it('start-row paste shows token and clipped first line, survives pickers/cancel, and deletes atomically', async () => {
  const f = await fixture();
  try {
    paste(f.tty, 'before '); send(f.tty, '\r'); await expect.poll(() => screen(f.tty)).toContain('Start a new agent');
    send(f.tty, messageRow); paste(f.tty, 'FIRST ' + '界'.repeat(120) + '\r\nPRIVATE SECOND');
    const text = await screen(f.tty); expect(text).toContain('[pasted · 2 lines] FIRST'); expect(text).not.toContain('PRIVATE SECOND');
    send(f.tty, '\x1b'); await new Promise(r => setTimeout(r, 120)); expect(await screen(f.tty)).toContain('[pasted · 2 lines]');
    send(f.tty, '\r'); await expect.poll(() => screen(f.tty)).toContain('Start a new agent');
    send(f.tty, 'm'); await expect.poll(() => screen(f.tty)).toContain('Select model');
    send(f.tty, '\x1b'); await new Promise(r => setTimeout(r, 120));
    send(f.tty, messageRow + '\x7f'); expect(await screen(f.tty)).not.toContain('[pasted');
    paste(f.tty, 'again\nintact'); send(f.tty, 'c\r');
    await expect.poll(() => f.client.requests.some(r => r.kind === 'sessions.create')).toBe(true);
    expect(f.client.requests.find(r => r.kind === 'sessions.create')).toMatchObject({ firstMessage: 'before again\nintactc' });
  } finally { await f.home.stop(); }
});
it.each([false, true])('oversized UTF-8 paste inserts nothing in start row=%s, retains prior text and consumes the whole paste', async startRow => {
  const f = await fixture();
  try {
    send(f.tty, 'keep');
    if (startRow) { send(f.tty, '\r'); await expect.poll(() => screen(f.tty)).toContain('Start a new agent'); send(f.tty, messageRow); }
    paste(f.tty, '界'.repeat(6000) + '\n/exit');
    expect(await screen(f.tty)).toContain(tooLong); expect(await screen(f.tty)).not.toContain('[pasted');
    send(f.tty, ' retained\r');
    if (!startRow) { await expect.poll(() => screen(f.tty)).toContain('Start a new agent'); send(f.tty, '\r'); }
    await expect.poll(() => f.client.requests.some(r => r.kind === 'sessions.create')).toBe(true);
    expect(f.client.requests.find(r => r.kind === 'sessions.create')).toMatchObject({ firstMessage: 'keep retained' });
  } finally { await f.home.stop(); }
});
it('combined UTF-8 limit rejects a whole insertion; exactly 16 KiB reaches the request intact', async () => {
  const f = await fixture();
  try {
    paste(f.tty, 'prefix '); paste(f.tty, 'x'.repeat(16384)); expect(await screen(f.tty)).toContain(tooLong);
    send(f.tty, '\x1b'); await new Promise(r => setTimeout(r, 120));
    const text = '界'.repeat(5461) + 'x'; paste(f.tty, text); send(f.tty, '\r');
    await expect.poll(() => screen(f.tty)).toContain('Start a new agent'); send(f.tty, '\r');
    await expect.poll(() => f.client.requests.some(r => r.kind === 'sessions.create')).toBe(true);
    expect(f.client.requests.find(r => r.kind === 'sessions.create')).toMatchObject({ firstMessage: text });
  } finally { await f.home.stop(); }
});
it('pasted slash-looking multiline content is a first message, never a command', async () => {
  const f = await fixture();
  try {
    paste(f.tty, '/exit\nthis is my task'); send(f.tty, '\r'); await expect.poll(() => screen(f.tty)).toContain('Start a new agent');
    send(f.tty, '\r'); await expect.poll(() => f.client.requests.some(r => r.kind === 'sessions.create')).toBe(true);
    expect(f.client.requests.find(r => r.kind === 'sessions.create')).toMatchObject({ firstMessage: '/exit\nthis is my task' });
  } finally { await f.home.stop(); }
});
it('command field keeps both pasted newlines and small-paste tab spacing', () => {
  const field = new CommandField(); field.paste('small\ttab'); field.paste('\nsecond');
  expect(field.key('enter')).toMatchObject({ kind: 'submit', text: 'small tab\nsecond' });
});
it('a background-color reply sequence inside a multiline paste stays literal first-message data', async () => {
  const f = await fixture(), text = 'intro\n\x1b]11;rgb:1111/2222/3333\x07\nend';
  try {
    paste(f.tty, text); send(f.tty, '\r'); await expect.poll(() => screen(f.tty)).toContain('Start a new agent');
    send(f.tty, '\r'); await expect.poll(() => f.client.requests.some(r => r.kind === 'sessions.create')).toBe(true);
    expect(f.client.requests.find(r => r.kind === 'sessions.create')).toMatchObject({ firstMessage: text });
  } finally { await f.home.stop(); }
});
