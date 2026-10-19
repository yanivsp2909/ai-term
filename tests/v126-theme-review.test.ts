import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import headless from '@xterm/headless';
import { Homepage } from '../src/client/tui/homepage.js';
import { AppInput } from '../src/client/app-input.js';
import { encodeAppControl, isAppCommand, type AppCommand } from '../src/shared/app-control.js';
import { BACKGROUND_QUERY } from '../src/client/tui/theme.js';
import { themeColors } from '../src/shared/theme-tokens.js';
import { lookPublisher } from '../app/main/look.js';
import { appLook } from '../app/shared/look.js';
import type { AppLook } from '../app/shared/api.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SuccessResponse } from '../src/shared/protocol.js';

// v1.2.6 Part B, TypeScript review findings (fresh context).
const token = 'a'.repeat(64);
class TTY extends EventEmitter {
  isTTY = true; isRaw = false; columns = 130; rows = 45; output = ''; background: string | null = themeColors('dune', 'dark').bg;
  setRawMode(value: boolean) { this.isRaw = value; } resume() {} pause() {}
  write(value: string | Buffer) {
    this.output += value.toString();
    const bg = this.background;
    if (value === BACKGROUND_QUERY && bg) queueMicrotask(() => this.emit('data', Buffer.from('\x1b]11;rgb:' + bg.slice(1).match(/../g)?.join('/') + '\x1b\\')));
    return true;
  }
}
function client(settings: Record<string, unknown>, options: { themes?: 'fail' } = {}) {
  let saved: Record<string, unknown> = { theme: 'graphite', setup: 'done', ...settings };
  const requests: RequestBody[] = [];
  return { requests, saved: () => saved, connection: Object.assign(new EventEmitter(), { async request(body: RequestBody): Promise<SuccessResponse> {
    requests.push(body); const r: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.get') r.settings = { theme: 'graphite', ...saved };
    if (body.kind === 'settings.set') { await new Promise(resolve => setTimeout(resolve, 30)); saved = { ...saved, ...body.patch }; r.settings = { theme: 'graphite', ...saved }; }
    if (body.kind === 'themes.list') { if (options.themes === 'fail') throw new Error('Session operation failed'); r.themes = { themes: [], refused: [] }; }
    if (body.kind === 'sessions.list') r.sessions = [];
    if (body.kind === 'keys.list') r.keys = [];
    if (body.kind === 'engines.status') r.engines = { claudeCode: { installed: true, path: '/bin/claude', version: '1', loggedIn: true, authMethod: 'subscription' }, codex: { installed: false, path: null, version: null, loggedIn: null, authMethod: 'unknown' } };
    return r;
  } }) };
}
async function start(settings: Record<string, unknown>, options: { app?: boolean; themes?: 'fail'; answer?: boolean } = {}) {
  const tty = new TTY(); if (options.answer === false) tty.background = null;
  const c = client(settings, options), input = options.app ? new AppInput(tty, token) : undefined;
  const home = new Homepage(c.connection as never, { stdin: input ?? tty, stdout: tty, ...(input ? { controls: input } : {}), signals: new EventEmitter(), cwd: '/tmp', terminalProgram: 'unknown' });
  await home.start();
  const send = (data: string) => tty.emit('data', Buffer.from(data));
  return { tty, home, ...c, send, command: (action: AppCommand) => send(encodeAppControl(token, action)), stop: async () => { await home.stop(); input?.dispose(); } };
}
async function screen(tty: TTY) { const term = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true }); try { await new Promise<void>(r => term.write(tty.output, r)); return Array.from({ length: 45 }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n'); } finally { term.dispose(); } }
const openPicker = async (h: Awaited<ReturnType<typeof start>>) => { for (const ch of '/theme') h.send(ch); h.send('\r'); await vi.waitFor(() => expect(h.tty.output).toContain('↑↓ theme · ←→'), { timeout: 5000 }); };

describe('the /theme picker under quick keys', () => {
  it('MEDIUM: ⏎ then Esc before the save returns keeps the picked theme on screen; the picker takes no keys once closing', async () => {
    // A terminal that never answers OSC 11: the preview of Match my terminal waits up to 200 ms for it, so the pick queues
    // behind it and Esc arrives while the picker is still on screen.
    const h = await start({}, { answer: false });
    try {
      await openPicker(h);
      h.send('\x1b[A'); h.send('\r'); h.send('\x1b');
      await vi.waitFor(() => expect(h.saved()).toMatchObject({ theme: 'auto' }), { timeout: 3000 });
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(h.home.currentTheme().name).toBe('auto');
    } finally { await h.stop(); }
  });

  it('LOW: with a terminal that never answers OSC 11, previews of system ask it once, not at every key', async () => {
    const h = await start({ theme: 'graphite', themeVariant: 'system' }, { answer: false });
    try {
      await openPicker(h);
      for (let i = 0; i < 3; i++) { h.send('\x1b[B'); await new Promise(resolve => setTimeout(resolve, 20)); }
      await vi.waitFor(() => expect(h.home.currentTheme().colors.bg).toBe(themeColors('dune', 'dark').bg));
      expect(h.tty.output.split(BACKGROUND_QUERY).length - 1).toBe(1);
    } finally { await h.stop(); }
  });

  it('LOW: theme files that could not be read say so, not that yours is missing', async () => {
    const h = await start({ theme: 'ocean', themeVariant: 'dark' }, { themes: 'fail' });
    try {
      await vi.waitFor(async () => expect(await screen(h.tty)).toContain('What do you want to build?'), { timeout: 5000 });
      await new Promise(resolve => setTimeout(resolve, 100));
      const text = await screen(h.tty);
      expect(text).toContain("your theme files couldn't be read");
      expect(text).not.toContain("isn't in ~/.ai-term/themes");
    } finally { await h.stop(); }
  });
});

describe('system in the app follows macOS, not the window', () => {
  it('appearance is an app command', () => {
    expect(isAppCommand('appearance light')).toBe(true); expect(isAppCommand('appearance dark')).toBe(true);
    expect(isAppCommand('appearance blue')).toBe(false);
  });

  it('MEDIUM: a system variant uses the appearance main reports, even while the window still shows the other one; previews too', async () => {
    const h = await start({ theme: 'dune', themeVariant: 'system' }, { app: true });
    try {
      h.command('appearance light'); h.command('theme-changed');
      await vi.waitFor(() => expect(h.home.currentTheme().colors.bg).toBe(themeColors('dune', 'light').bg));
      await openPicker(h);
      h.send('\x1b[A'); h.send('\x1b[A');
      await vi.waitFor(() => expect(h.home.currentTheme().colors.bg).toBe(themeColors('slate', 'light').bg));
    } finally { await h.stop(); }
  });

  it('MEDIUM: macOS flipping while the picker is open: Esc goes back to the saved theme in the new appearance', async () => {
    const h = await start({ theme: 'dune', themeVariant: 'system' }, { app: true });
    try {
      h.command('appearance dark'); h.command('theme-changed');
      await vi.waitFor(() => expect(h.home.currentTheme().colors.bg).toBe(themeColors('dune', 'dark').bg));
      await openPicker(h);
      h.send('\x1b[A');
      await vi.waitFor(() => expect(h.home.currentTheme().colors.bg).toBe(themeColors('ink', 'dark').bg));
      h.command('appearance light'); h.command('theme-changed');
      await new Promise(resolve => setTimeout(resolve, 100));
      h.send('\x1b');
      await vi.waitFor(() => expect(h.home.currentTheme().colors.bg).toBe(themeColors('dune', 'light').bg));
    } finally { await h.stop(); }
  });
});

describe('the app sends a look only when it changed, and never an older one', () => {
  it('MEDIUM: an unrelated settings change sends nothing; a slow older read that ends last is dropped; a renderer request always gets one', async () => {
    const sent: AppLook[] = [];
    const slate = appLook({ theme: 'slate' }, { themes: [], refused: [] }, true), dune = appLook({ theme: 'dune' }, { themes: [], refused: [] }, true);
    const reads: { look: AppLook; delay: number }[] = [{ look: slate, delay: 0 }, { look: slate, delay: 0 }, { look: slate, delay: 60 }, { look: dune, delay: 0 }];
    const publish = lookPublisher(async () => { const next = reads.shift(); if (!next) throw new Error('no read'); await new Promise(resolve => setTimeout(resolve, next.delay)); return next.look; }, look => { sent.push(look); });
    await publish.refresh();
    await publish.refresh();
    expect(sent).toEqual([slate]);
    const older = publish.refresh(), newer = publish.refresh();
    await Promise.all([older, newer]);
    expect(sent).toEqual([slate, dune]);
    publish.resend();
    expect(sent).toEqual([slate, dune, dune]);
  });
});
