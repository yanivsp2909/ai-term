import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { SessionInfo, SuccessResponse } from '../src/shared/protocol.js';
import type { RequestBody } from '../src/client/connection.js';
const session: SessionInfo = { id: randomUUID(), title: 'project shell', engine: 'shell', model: 'shell', auth: { kind: 'account' }, cwd: '/tmp', permission: 'ask', status: 'running', statusDetail: 'running', statusSince: '2026-10-11T10:00:00Z', createdAt: '2026-10-11T10:00:00Z', lastOutputAt: null, ctxPercent: null, exitCode: null };
class TTY extends EventEmitter {
  isTTY = true; isRaw = false; columns = 130; rows = 45; output = '';
  setRawMode(raw: boolean) { this.isRaw = raw; } resume() {} pause() {}
  write(value: string | Buffer) { this.output += value.toString(); return true; }
}
class Client extends EventEmitter {
  input = vi.fn(); requests: RequestBody[] = []; snapshot = 'hello preview';
  async request(body: RequestBody): Promise<SuccessResponse> {
    this.requests.push(body);
    return { id: randomUUID(), ok: true, ...(body.kind === 'sessions.list' ? { sessions: [session] } : {}), ...(body.kind.startsWith('settings.') ? { settings: { theme: body.kind === 'settings.set' ? body.patch.theme : 'graphite' } } : {}), ...(body.kind === 'sessions.preview' ? { snapshot: this.snapshot, sessionId: body.sessionId ?? undefined, cols: 88, rows: 27 } : {}) };
  }
}
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const { Homepage } = await import('../src/client/tui/homepage.js');
  const tty = new TTY(), client = new Client(), signals = new EventEmitter();
  const home = new Homepage(client, { stdin: tty, stdout: tty, signals, cwd: '/tmp' });
  await home.start();
  return { home, tty, client, signals };
}
describe('homepage layout and cards', () => {
  it.each([[130, 45], [100, 30], [99, 29], [59, 15]])('plain grid at %sx%s matches the approved breakpoints', async (cols, rows) => {
    const { renderHomepage } = await import('../src/client/tui/layout.js');
    const { createTheme } = await import('../src/client/tui/theme.js');
    const { plainText } = await import('../src/client/tui/grid.js');
    const grid = renderHomepage({ cols, rows, sessions: [session], selectedId: session.id, input: '', note: '', previewVisible: true, cwd: '/tmp', now: Date.parse('2026-10-11T10:04:00Z') }, createTheme('graphite'));
    expect(plainText(grid)).toMatchSnapshot();
    expect(grid).toHaveLength(rows); expect(grid.every(row => row.length === cols)).toBe(true);
    const text = plainText(grid);
    if (cols < 60) expect(text.trim()).toBe('make the window bigger');
    else if (cols < 100) { expect(text).toContain('Agents 1'); expect(text).not.toContain('Usage'); }
    else { expect(text).toContain('Usage'); expect(text).toContain('This Mac'); expect(text).not.toContain('notify on'); }
  });
  it('cards show running, exited 0, error and clipped long names with their status words', async () => {
    const { renderHomepage } = await import('../src/client/tui/layout.js'), { createTheme } = await import('../src/client/tui/theme.js'), { plainText } = await import('../src/client/tui/grid.js');
    const sessions = [session, { ...session, id: randomUUID(), status: 'exited' as const, statusDetail: 'exit 0', exitCode: 0 }, { ...session, id: randomUUID(), status: 'error' as const, statusDetail: 'spawn failed' }, { ...session, id: randomUUID(), title: 'very long name '.repeat(4) }];
    const text = plainText(renderHomepage({ cols: 130, rows: 45, sessions, selectedId: session.id, input: '', note: '', previewVisible: true, cwd: '/tmp', now: Date.parse(session.createdAt) }, createTheme('graphite')));
    expect(text).toContain('SH'); expect(text).toContain('running'); expect(text).toContain('exited · exit 0'); expect(text).toContain('failed · spawn failed'); expect(text).not.toContain(sessions[3]?.title);
  });
  it('waiting sorts to the top, otherwise newest first, keeping the selection visible', async () => {
    const { sortSessions, visibleStart } = await import('../src/client/tui/layout.js');
    const newer = { ...session, id: randomUUID(), createdAt: '2026-10-11T11:00:00Z' }, waiting = { ...session, id: randomUUID(), status: 'waiting' as const };
    expect(sortSessions([session, newer, waiting]).map(s => s.id)).toEqual([waiting.id, newer.id, session.id]);
    expect(visibleStart(20, 3, 0)).toBe(18); expect(visibleStart(1, 3, 18)).toBe(1);
  });
});
it('letters type with text, shortcut only with an empty field; Ctrl+C needs two within one second', async () => {
  const { CommandField } = await import('../src/client/tui/keys.js');
  const field = new CommandField();
  expect(field.key('p', 0)).toEqual({ kind: 'preview' });
  field.key('h', 0); field.key('p', 0); expect(field.text).toBe('hp');
  field.key('escape', 0); expect(field.text).toBe('');
  expect(field.key('ctrl-c', 10).kind).toBe('note');
  expect(field.key('ctrl-c', 1011).kind).toBe('note');
  expect(field.key('ctrl-c', 1100).kind).toBe('quit');
});
it('decodes fragmented arrows, UTF-8, SGR mouse and bracketed paste without treating pasted shortcuts as actions', async () => {
  const { InputParser } = await import('../src/client/tui/keys.js');
  const events: unknown[] = []; const parser = new InputParser(event => events.push(event));
  parser.push(Buffer.from('\x1b[')); parser.push(Buffer.from('A界')); parser.push(Buffer.from('\x1b[<0;42;5M\x1b[<0;43;5m'));
  parser.push(Buffer.from('\x1b[200~p\r/exit\x1b[201~'));
  expect(events).toContainEqual({ kind: 'key', key: 'up' }); expect(events).toContainEqual({ kind: 'key', key: '界' });
  expect(events).toContainEqual({ kind: 'mouse', button: 0, x: 42, y: 4, release: true });
  expect(events).toContainEqual({ kind: 'paste', text: 'p /exit' }); parser.dispose();
});
it('S15: OSC 52 / title / bell in a session never reaches homepage stdout', async () => {
  const { home, tty, client } = await fixture();
  try {
    client.emit('output', session.id, Buffer.from('\x1b]52;c;FORBIDDEN_CLIPBOARD\x07\x1b]0;FORBIDDEN_TITLE\x07\x07\r\nsafe cell text'));
    await expect.poll(() => tty.output.includes('safe')).toBe(true);
    const headless = (await import('@xterm/headless')).default;
    const display = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true });
    try { await new Promise<void>(resolve => display.write(tty.output, resolve)); expect(display.buffer.active.getLine(4)?.translateToString()).toContain('safe cell text'); } finally { display.dispose(); }
    expect(tty.output).not.toContain('FORBIDDEN'); expect(tty.output).not.toContain('\x07'); expect(tty.output).not.toContain('\x1b]');
  } finally { await home.stop(); }
});
it('homepage is read-only: no input frame is sent for typing, arrows, paste or mouse', async () => {
  const { home, tty, client } = await fixture();
  try {
    tty.emit('data', Buffer.from('hello\r\x1b[A\x1b[200~echo nope\r\x1b[201~\x1b[<0;42;5M'));
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(client.input).not.toHaveBeenCalled(); expect(client.requests.some(r => r.kind === 'sessions.create')).toBe(false);
  } finally { await home.stop(); }
});
it('theme switch sends settings.set and the next frame uses the new colors', async () => {
  const { home, tty, client } = await fixture();
  try {
    const before = tty.output.length; tty.emit('data', Buffer.from('/theme slate\r'));
    await expect.poll(() => client.requests.some(r => r.kind === 'settings.set')).toBe(true);
    await expect.poll(() => tty.output.slice(before).includes('48;2;27;32;41m')).toBe(true);
  } finally { await home.stop(); }
});
it('previewSize report changes on SIGWINCH and forces a complete redraw', async () => {
  const { home, tty, client, signals } = await fixture();
  try {
    const initial = client.requests.find(r => r.kind === 'layout.previewSize'), before = tty.output.length;
    tty.columns = 100; tty.rows = 30; signals.emit('SIGWINCH');
    await expect.poll(() => client.requests.filter(r => r.kind === 'layout.previewSize').length).toBe(2);
    expect(client.requests.filter(r => r.kind === 'layout.previewSize')[1]).not.toEqual(initial);
    expect(tty.output.slice(before)).toContain('\x1b[2J');
  } finally { await home.stop(); }
});
it('never shrinks detached sessions to the hidden preview area of a compact or tiny window', async () => {
  const { home, tty, client, signals } = await fixture();
  try {
    const reported = () => client.requests.filter(r => r.kind === 'layout.previewSize');
    expect(reported()).toHaveLength(1);
    for (const [columns, rows] of [[80, 24], [50, 12]] as const) {
      tty.columns = columns; tty.rows = rows; signals.emit('SIGWINCH');
      await expect.poll(() => client.requests.filter(r => r.kind === 'sessions.preview').length).toBeGreaterThan(columns === 80 ? 1 : 2);
    }
    expect(reported()).toHaveLength(1);
  } finally { await home.stop(); }
});
it('idle homepage writes no redraws and restores mouse/raw/alternate modes on quit and crash', async () => {
  for (const crash of [false, true]) {
    const { home, tty, signals } = await fixture();
    await new Promise(resolve => setTimeout(resolve, 70)); const before = tty.output.length;
    await new Promise(resolve => setTimeout(resolve, 80)); expect(tty.output.length).toBe(before);
    const outcome = home.done.catch(error => error);
    if (crash) signals.emit('uncaughtException', new Error('forced crash')); else tty.emit('data', Buffer.from('/exit\r'));
    await outcome;
    expect(tty.isRaw).toBe(false); expect(tty.output).toContain('\x1b[?1002l'); expect(tty.output).toContain('\x1b[?1006l'); expect(tty.output.endsWith('\x1b[?1049l')).toBe(true);
  }
});
it('turns homepage mouse reporting off before attach, restores it after home, and resubscribes preview', async () => {
  const { Homepage } = await import('../src/client/tui/homepage.js');
  const tty = new TTY(), client = new Client(), signals = new EventEmitter();
  let returnHome: (reason: 'home key') => void = () => {};
  const attachSession = vi.fn(() => new Promise<'home key'>(resolve => { returnHome = resolve; }));
  const home = new Homepage(client, { stdin: tty, stdout: tty, signals, attachSession });
  await home.start();
  try {
    tty.emit('data', Buffer.from('\r'));
    await expect.poll(() => attachSession.mock.calls.length).toBe(1);
    expect(tty.output.endsWith('\x1b[?1049l')).toBe(true); expect(tty.isRaw).toBe(false);
    const attachStart = tty.output.length;
    tty.emit('data', Buffer.from('session-only'));
    returnHome('home key');
    await expect.poll(() => client.requests.filter(r => r.kind === 'sessions.preview' && r.sessionId === session.id).length).toBe(2);
    expect(tty.output.slice(attachStart)).toContain('\x1b[?1006h'); expect(tty.isRaw).toBe(true);
    expect(client.input).not.toHaveBeenCalled(); expect(tty.output).not.toContain('session-only');
  } finally { await home.stop(); }
});
it('drag selection highlights and copies plain preview text, clearing the flash after 1.2 seconds', async () => {
  const { Homepage } = await import('../src/client/tui/homepage.js');
  const tty = new TTY(), client = new Client(), copy = vi.fn(async () => {}), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), copy });
  await home.start();
  try {
    tty.emit('data', Buffer.from('\x1b[<0;41;4M\x1b[<32;45;4M\x1b[<0;45;4m'));
    await expect.poll(() => copy.mock.calls.length).toBe(1);
    expect(copy).toHaveBeenCalledWith('hello'); await expect.poll(() => tty.output.includes('✓ copied 1 lines')).toBe(true);
  } finally { await home.stop(); }
});
it('stop asks y/n, rename saves inline and remove targets only exited/error records', async () => {
  const { home, tty, client } = await fixture();
  try {
    tty.emit('data', Buffer.from('s')); expect(client.requests.some(r => r.kind === 'sessions.stop')).toBe(false);
    tty.emit('data', Buffer.from('y'));
    await expect.poll(() => client.requests.some(r => r.kind === 'sessions.stop')).toBe(true);
    tty.emit('data', Buffer.from('r\x7fnew\r'));
    await expect.poll(() => client.requests.some(r => r.kind === 'sessions.rename')).toBe(true);
    tty.emit('data', Buffer.from('x')); expect(client.requests.some(r => r.kind === 'sessions.remove')).toBe(false);
    client.emit('event', { kind: 'session.updated', session: { ...session, status: 'exited', exitCode: 0 } }); tty.emit('data', Buffer.from('x'));
    await expect.poll(() => client.requests.some(r => r.kind === 'sessions.remove')).toBe(true);
  } finally { await home.stop(); }
});
it('Ctrl+C quits during stop confirmation and inline rename', async () => {
  for (const key of ['s', 'r']) {
    const { home, tty } = await fixture();
    tty.emit('data', Buffer.from(key + '\x03\x03'));
    const result = await Promise.race([home.done.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 80))]);
    await home.stop(); expect(result).toBe(true);
  }
});
it('daemon session validation rejects malformed strings and lifecycle metadata before rendering', async () => {
  const { validateSession } = await import('../src/shared/validate.js');
  expect(validateSession(session)).toEqual(session);
  for (const patch of [{ statusSince: 'bad' }, { statusDetail: {} }, { model: '-bad' }, { auth: null }, { cwd: '/tmp\0bad' }]) expect(() => validateSession({ ...session, ...patch })).toThrow();
});
it('S2 rejects arrays and objects for daemon session engine and status', async () => {
  const { validateSession } = await import('../src/shared/validate.js');
  for (const patch of [{ engine: ['shell'] }, { status: ['running'] }, { engine: {} }, { status: {} }]) expect(() => validateSession({ ...session, ...patch })).toThrow();
});
it('dragging scroll banners never copies hidden preview text', async () => {
  const { Homepage } = await import('../src/client/tui/homepage.js');
  const tty = new TTY(), client = new Client(), copy = vi.fn(async () => {}); client.snapshot = Array.from({ length: 70 }, (_, i) => `line ${i}`).join('\r\n');
  const home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), copy }); await home.start();
  try {
    tty.emit('data', Buffer.from('\x1b[5~')); await new Promise(resolve => setTimeout(resolve, 40));
    tty.emit('data', Buffer.from('\x1b[<0;41;4M\x1b[<0;45;4m')); await Promise.resolve();
    expect(copy).not.toHaveBeenCalled();
  } finally { await home.stop(); }
});
it('latest catch-up snapshot wins without sharing chunks with older queued snapshots', async () => {
  const { home, tty, client } = await fixture();
  try {
    const request = client.requests.find(r => r.kind === 'sessions.preview' && r.sessionId === session.id); expect(request).toBeDefined();
    // Correlation id is obtained from a fake response recorded for this test.
    const activeId = (home as unknown as { previewRequestId: string }).previewRequestId;
    client.emit('event', { id: activeId, ok: true, sessionId: session.id, snapshot: 'OLD_SNAPSHOT', cols: 88, rows: 27 });
    client.emit('event', { id: activeId, ok: true, sessionId: session.id, snapshot: 'LATEST_SNAPSHOT', cols: 88, rows: 27 });
    client.emit('output', session.id, Buffer.from('\r\nLATEST_LIVE'));
    await expect.poll(() => tty.output.includes('LATEST_SNAPSHOT')).toBe(true);
    await expect.poll(() => tty.output.includes('LATEST_LIVE')).toBe(true);
  } finally { await home.stop(); }
});
it('preview dimension changes from a session attached elsewhere request a fresh sized snapshot', async () => {
  const { home, client } = await fixture();
  try {
    const before = client.requests.filter(r => r.kind === 'sessions.preview' && r.sessionId === session.id).length;
    client.emit('event', { kind: 'session.previewResized', sessionId: session.id, cols: 80, rows: 24 });
    await expect.poll(() => client.requests.filter(r => r.kind === 'sessions.preview' && r.sessionId === session.id).length).toBe(before + 1);
  } finally { await home.stop(); }
});
it('switching selection back shows the latest cached mirror immediately while resubscription is pending', async () => {
  const { Homepage } = await import('../src/client/tui/homepage.js');
  const tty = new TTY(), client = new Client(), second = { ...session, id: randomUUID(), title: 'second', createdAt: '2026-10-11T09:00:00Z' };
  const original = client.request.bind(client);
  client.request = async body => body.kind === 'sessions.list' ? { id: randomUUID(), ok: true, sessions: [session, second] } : original(body);
  const home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter() }); await home.start();
  try {
    tty.emit('data', Buffer.from('\x1b[B'));
    await expect.poll(() => client.requests.filter(r => r.kind === 'sessions.preview' && r.sessionId === second.id).length).toBe(1);
    const before = tty.output.length; tty.emit('data', Buffer.from('\x1b[A'));
    await expect.poll(() => client.requests.filter(r => r.kind === 'sessions.preview' && r.sessionId === session.id).length).toBe(2);
    expect(tty.output.slice(before)).not.toContain('Attach unavailable');
  } finally { await home.stop(); }
});
it('catch-up arriving during initial snapshot parse supersedes the startup snapshot', async () => {
  const { home, tty, client } = await fixture();
  try {
    const { Preview } = await import('../src/client/tui/preview.js');
    const write = Preview.prototype.write;
    let caught = false;
    const spy = vi.spyOn(Preview.prototype, 'write').mockImplementation(function (this: import('../src/client/tui/preview.js').Preview, data) {
      if (data === 'hello preview' && !caught) {
        caught = true;
        const activeId = (home as unknown as { previewRequestId: string }).previewRequestId;
        client.emit('event', { id: activeId, ok: true, sessionId: session.id, snapshot: 'STARTUP_LATEST', cols: 88, rows: 27 });
      }
      return write.call(this, data);
    });
    tty.emit('data', Buffer.from('p')); await expect.poll(() => client.requests.filter(r => r.kind === 'sessions.preview' && r.sessionId === null).length).toBeGreaterThan(0);
    tty.emit('data', Buffer.from('p')); await expect.poll(() => tty.output.includes('STARTUP_LATEST')).toBe(true); spy.mockRestore();
  } finally { await home.stop(); }
});
