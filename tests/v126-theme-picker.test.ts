import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import headless from '@xterm/headless';
import { Homepage } from '../src/client/tui/homepage.js';
import { ThemePicker, type ThemeChoice } from '../src/client/tui/theme-picker.js';
import { createTheme } from '../src/client/tui/theme.js';
import { plainText, Grid } from '../src/client/tui/grid.js';
import { themeColors } from '../src/shared/theme-tokens.js';
import type { ThemeList } from '../src/shared/user-themes.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SuccessResponse } from '../src/shared/protocol.js';

// v1.2.6 /theme: a list of the themes with the homepage behind it drawn live in the highlighted one. ↑↓ picks a
// theme, ←→ its variant (dark, light, system); ⏎ keeps it, Esc goes back without changing anything. Nothing animates.
const ocean = { name: 'ocean', label: 'Ocean', dark: { ...themeColors('slate', 'dark'), bg: '#0a1a2a' }, light: { ...themeColors('slate', 'light'), bg: '#f0f8ff' } };
const LIST: ThemeList = { themes: [ocean], refused: [{ file: 'broken.json', reason: 'missing light.bg' }] };
function picker(current: ThemeChoice = { name: 'graphite', variant: 'dark' }) {
  const seen: ThemeChoice[] = [], picked: ThemeChoice[] = []; let cancelled = 0;
  const p = new ThemePicker(LIST, current, { preview: c => seen.push(c), pick: c => picked.push(c), cancel: () => { cancelled++; } });
  return { p, seen, picked, cancelled: () => cancelled };
}
const text = (p: ThemePicker) => plainText(p.draw(new Grid(130, 45, createTheme('graphite')).cells, createTheme('graphite')));

describe('the theme picker', () => {
  it('lists the built-ins, your files, match my terminal, and each refused file in one line', () => {
    const shown = text(picker().p);
    for (const part of ['Theme', 'Graphite', 'Slate', 'Ink', 'Dune', 'High contrast', 'Ocean · your file', 'Match my terminal', '✗ broken.json refused · missing light.bg',
      '↑↓ theme · ←→ dark, light or system · ⏎ picks · Esc goes back']) expect(shown, part).toContain(part);
    // The current one is marked in words, the highlighted one with ›, its variant in brackets: never color alone.
    expect(shown).toMatch(/› Graphite .*\[dark\] · light · system/);
    expect(shown).toContain('in use');
  });

  it('↑↓ and ←→ preview each choice; Esc cancels; ⏎ picks the one shown', () => {
    const { p, seen, picked, cancelled } = picker();
    p.key('down'); p.key('right'); p.key('right'); p.key('left');
    expect(seen).toEqual([{ name: 'slate', variant: 'dark' }, { name: 'slate', variant: 'light' }, { name: 'slate', variant: 'system' }, { name: 'slate', variant: 'light' }]);
    p.key('escape'); expect(cancelled()).toBe(1); expect(picked).toEqual([]);
    const second = picker({ name: 'dune', variant: 'light' });
    expect(text(second.p)).toMatch(/› Dune .*dark · \[light\] · system/);
    second.p.key('down'); second.p.key('down');
    expect(second.seen.at(-1)).toEqual({ name: 'ocean', variant: 'light' });
    second.p.key('enter'); expect(second.picked).toEqual([{ name: 'ocean', variant: 'light' }]);
  });

  it('match my terminal has no variant; the list wraps; a refused file is never a choice', () => {
    const { p, seen } = picker();
    p.key('up'); expect(seen.at(-1)).toEqual({ name: 'auto', variant: 'dark' });
    p.key('right'); expect(seen).toHaveLength(1);
    expect(text(p)).toMatch(/› Match my terminal .*its own background/);
    p.key('down'); expect(seen.at(-1)).toEqual({ name: 'graphite', variant: 'dark' });
  });
});

class TTY extends EventEmitter { isTTY = true; columns = 130; rows = 45; output = ''; setRawMode() {} resume() {} pause() {} write(s: string | Buffer) { this.output += String(s); return true; } }
async function screen(tty: TTY) { const term = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true }); try { await new Promise<void>(r => term.write(tty.output, r)); return Array.from({ length: 45 }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n'); } finally { term.dispose(); } }
async function homepage(settings: Record<string, unknown>, list: ThemeList = LIST) {
  const requests: RequestBody[] = [];
  let saved: Record<string, unknown> = { theme: 'graphite', setup: 'done', ...settings };
  const client = Object.assign(new EventEmitter(), { async request(body: RequestBody): Promise<SuccessResponse> {
    requests.push(body); const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.get') response.settings = { theme: 'graphite', ...saved };
    if (body.kind === 'settings.set') { saved = { ...saved, ...body.patch }; response.settings = { theme: 'graphite', ...saved }; }
    if (body.kind === 'themes.list') response.themes = list;
    if (body.kind === 'sessions.list') response.sessions = [];
    if (body.kind === 'keys.list') response.keys = [];
    if (body.kind === 'engines.status') response.engines = { claudeCode: { installed: true, path: '/bin/claude', version: '2.1.300', loggedIn: true, authMethod: 'subscription' }, codex: { installed: false, path: null, version: null, loggedIn: null, authMethod: 'unknown' } };
    return response;
  } });
  const tty = new TTY(), home = new Homepage(client as never, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', terminalProgram: 'unknown' });
  await home.start();
  return { tty, home, requests, type: (s: string) => { for (const ch of s) tty.emit('data', Buffer.from(ch)); } };
}
const sets = (requests: RequestBody[]) => requests.filter(r => r.kind === 'settings.set').map(r => r.kind === 'settings.set' ? r.patch : null);

describe('/theme on the homepage', () => {
  it('opens the picker; moving repaints the homepage in that theme; Esc puts the old one back and saves nothing', async () => {
    const h = await homepage({});
    try {
      h.type('/theme'); h.tty.emit('data', Buffer.from('\r'));
      await vi.waitFor(async () => expect(await screen(h.tty)).toContain('↑↓ theme · ←→ dark, light or system'), { timeout: 5000 });
      expect(h.requests.some(r => r.kind === 'themes.list')).toBe(true);
      h.tty.emit('data', Buffer.from('\x1b[B'));
      await vi.waitFor(() => expect(h.home.currentTheme().colors.bg).toBe(themeColors('slate', 'dark').bg));
      h.tty.emit('data', Buffer.from('\x1b[C'));
      await vi.waitFor(() => expect(h.home.currentTheme().colors.bg).toBe(themeColors('slate', 'light').bg));
      // The homepage behind is drawn in the previewed theme: its ground is slate light's, in truecolor.
      const [r, g, b] = [1, 3, 5].map(i => Number.parseInt(themeColors('slate', 'light').bg.slice(i, i + 2), 16));
      expect(h.tty.output.slice(-20000)).toContain(`48;2;${r};${g};${b}`);
      h.tty.emit('data', Buffer.from('\x1b'));
      await vi.waitFor(async () => expect(await screen(h.tty)).not.toContain('↑↓ theme'));
      expect(h.home.currentTheme().colors.bg).toBe(themeColors('graphite', 'dark').bg);
      expect(sets(h.requests).filter(p => p && 'theme' in p)).toEqual([]);
    } finally { await h.home.stop(); }
  });

  it('⏎ saves the theme and its variant, and says so', async () => {
    const h = await homepage({});
    try {
      h.type('/theme'); h.tty.emit('data', Buffer.from('\r'));
      await vi.waitFor(async () => expect(await screen(h.tty)).toContain('↑↓ theme'), { timeout: 5000 });
      for (const key of ['\x1b[B', '\x1b[B', '\x1b[B', '\x1b[C']) h.tty.emit('data', Buffer.from(key));
      h.tty.emit('data', Buffer.from('\r'));
      await vi.waitFor(() => expect(sets(h.requests)).toContainEqual({ theme: 'dune', themeVariant: 'light' }));
      await vi.waitFor(async () => expect(await screen(h.tty)).toContain('✓ theme Dune · light'));
      expect(h.home.currentTheme().colors.bg).toBe(themeColors('dune', 'light').bg);
    } finally { await h.home.stop(); }
  });

  it('/theme <name> [variant] still sets it directly; an unknown name says which ones there are', async () => {
    const h = await homepage({});
    try {
      h.type('/theme contrast light'); h.tty.emit('data', Buffer.from('\r'));
      await vi.waitFor(() => expect(sets(h.requests)).toContainEqual({ theme: 'contrast', themeVariant: 'light' }));
      expect(h.home.currentTheme().colors.bg).toBe(themeColors('contrast', 'light').bg);
      h.type('/theme slate'); h.tty.emit('data', Buffer.from('\r'));
      await vi.waitFor(() => expect(sets(h.requests)).toContainEqual({ theme: 'slate' }));
      expect(h.home.currentTheme().colors.bg).toBe(themeColors('slate', 'light').bg);
      h.type('/theme nope'); h.tty.emit('data', Buffer.from('\r'));
      await vi.waitFor(async () => expect(await screen(h.tty)).toContain('/theme graphite|slate|ink|dune|contrast|auto|ocean [dark|light|system]'));
    } finally { await h.home.stop(); }
  });

  it('a saved theme of your own loads at start; one that is gone or refused falls back to graphite and says so', async () => {
    const mine = await homepage({ theme: 'ocean', themeVariant: 'dark' });
    try { expect(mine.home.currentTheme().colors.bg).toBe('#0a1a2a'); } finally { await mine.home.stop(); }
    const gone = await homepage({ theme: 'ocean', themeVariant: 'dark' }, { themes: [], refused: [{ file: 'ocean.json', reason: 'missing dark.bg' }] });
    try {
      expect(gone.home.currentTheme().colors.bg).toBe(themeColors('graphite', 'dark').bg);
      await vi.waitFor(async () => expect(await screen(gone.tty)).toContain("theme ocean can't be used (missing dark.bg) · graphite for now"));
    } finally { await gone.home.stop(); }
  });

  it('the variant you never set stays dark in a terminal, as before; light is graphite light', async () => {
    const plain = await homepage({ theme: 'slate' });
    try { expect(plain.home.currentTheme().colors.bg).toBe(themeColors('slate', 'dark').bg); } finally { await plain.home.stop(); }
    const light = await homepage({ theme: 'light' });
    try { expect(light.home.currentTheme().colors.bg).toBe(themeColors('graphite', 'light').bg); } finally { await light.home.stop(); }
  });
});
