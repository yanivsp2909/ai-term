import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import headless from '@xterm/headless';
import type { SessionInfo, SuccessResponse, SystemStats } from '../src/shared/protocol.js';
import type { RequestBody } from '../src/client/connection.js';
const base = { auth: { kind: 'account' }, cwd: '/tmp', permission: 'ask', status: 'running', statusDetail: 'running', statusSince: '2026-10-11T10:00:00Z', exitCode: null, lastOutputAt: null, ctxPercent: null } as const;
const selected: SessionInfo = { ...base, id: randomUUID(), title: 'busy shell', engine: 'shell', model: null, createdAt: '2026-10-11T10:05:00Z' };
const other: SessionInfo = { ...base, id: randomUUID(), title: 'older shell', engine: 'shell', model: null, createdAt: '2026-10-11T10:00:00Z' };
const GiB = 1024 ** 3, MiB = 1024 ** 2;
const stats = (cpuPercent: number): SystemStats => ({ cpuPercent, memUsedBytes: 14.2 * GiB, memTotalBytes: 32 * GiB, netRxBytesPerSec: 1.4e6, netTxBytesPerSec: 2e5,
  sessions: [{ sessionId: selected.id, cpuPercent: 4, rssBytes: 310 * MiB }, { sessionId: other.id, cpuPercent: 15, rssBytes: 2 * GiB }] });
class TTY extends EventEmitter {
  isTTY = true; isRaw = false; columns = 130; rows = 45; output = '';
  setRawMode(raw: boolean) { this.isRaw = raw; } resume() {} pause() {}
  write(value: string | Buffer) { this.output += value.toString(); return true; }
}
class Client extends EventEmitter {
  requests: RequestBody[] = [];
  async request(body: RequestBody): Promise<SuccessResponse> {
    this.requests.push(body);
    return { id: randomUUID(), ok: true, ...(body.kind === 'sessions.list' ? { sessions: [selected, other] } : {}), ...(body.kind === 'settings.get' ? { settings: { theme: 'graphite' } } : {}), ...(body.kind === 'sessions.preview' ? { snapshot: '', cols: 80, rows: 20 } : {}) };
  }
  subscriptions(): boolean[] { return this.requests.flatMap(r => r.kind === 'system.subscribe' ? [r.on] : []); }
}
async function fixture() {
  const { Homepage } = await import('../src/client/tui/homepage.js');
  const tty = new TTY(), client = new Client(), signals = new EventEmitter();
  let returnHome: (reason: 'home key') => void = () => {};
  const attachSession = vi.fn(async () => { expect(client.subscriptions().at(-1)).toBe(false); return new Promise<'home key'>(resolve => { returnHome = resolve; }); });
  const home = new Homepage(client, { stdin: tty, stdout: tty, signals, cwd: '/tmp', attachSession });
  await home.start();
  const display = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true });
  const screen = async () => { await new Promise<void>(r => display.write(tty.output.slice(written), r)); written = tty.output.length; return Array.from({ length: 45 }, (_, y) => display.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n'); };
  let written = 0;
  return { home, tty, client, screen, attachSession, back: () => returnHome('home key'), done: () => { display.dispose(); } };
}
it('subscribes on open, draws This Mac and the selected agent\'s usage from samples, and keeps the last 10 for the sparkline', async () => {
  const { home, client, screen, done } = await fixture();
  try {
    expect(client.subscriptions()).toEqual([true]);
    expect(await screen()).toContain('CPU —');
    for (const cpu of [5, 15, 25, 35, 45, 55, 65, 75, 85, 95, 100, 31]) client.emit('event', { kind: 'system.stats', stats: stats(cpu) });
    const text = await screen();
    expect(text).toContain('CPU 31% ▃▃▄▅▆▇▇██▃');
    expect(text).toMatch(/CPU 31% ▃▃▄▅▆▇▇██▃\s+agents 19%/);
    expect(text).toMatch(/RAM 14\.2\/32 GB\s+agents 2\.3 GB/);
    expect(text).toContain('NET ↓ 1.4 MB/s  ↑ 0.2 MB/s');
    expect(text).toMatch(/shell\s+cpu 4% · 310 MB/);
  } finally { done(); await home.stop(); }
});
it('redraws only when a new sample arrives', async () => {
  const { home, tty, client, done } = await fixture();
  try {
    await new Promise(r => setTimeout(r, 100));
    const idle = tty.output.length; await new Promise(r => setTimeout(r, 300));
    expect(tty.output.length).toBe(idle);
    client.emit('event', { kind: 'system.stats', stats: stats(40) });
    expect(tty.output.length).toBeGreaterThan(idle);
    const after = tty.output.length; await new Promise(r => setTimeout(r, 300));
    expect(tty.output.length).toBe(after);
  } finally { done(); await home.stop(); }
});
it('unsubscribes before attaching, ignores samples while attached, resubscribes on return and unsubscribes on quit', async () => {
  const { home, tty, client, attachSession, back, done } = await fixture();
  try {
    tty.emit('data', Buffer.from('\r'));
    await expect.poll(() => attachSession.mock.calls.length).toBe(1);
    expect(client.subscriptions()).toEqual([true, false]);
    const attached = tty.output.length;
    client.emit('event', { kind: 'system.stats', stats: stats(50) });
    expect(tty.output.length).toBe(attached);
    back();
    await expect.poll(() => client.subscriptions()).toEqual([true, false, true]);
  } finally { done(); await home.stop(); }
  expect(client.subscriptions()).toEqual([true, false, true, false]);
});
it('a stats event that breaks the contract stops the homepage like any invalid daemon event', async () => {
  const { home, client, done } = await fixture();
  try {
    client.emit('event', { kind: 'system.stats', stats: { ...stats(10), command: '/usr/bin/secret' } });
    await expect(home.done).rejects.toThrow();
  } finally { done(); }
});
