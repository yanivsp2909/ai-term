import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import headless from '@xterm/headless';
import { remoteLines } from '../src/client/tui/remote-panel.js';
import { Homepage } from '../src/client/tui/homepage.js';
import { validateRemoteStatus, type RemoteStatus } from '../src/shared/remote.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SuccessResponse } from '../src/shared/protocol.js';

// v1.0.8 /remote on the homepage: the panel says on or off with a word and a glyph, shows the QR only right after /remote
// on, and lists the phones; the commands go only to the daemon's socket.
const ON: RemoteStatus = { state: 'on', host: 'mac.tail1234.ts.net:8443', since: new Date().toISOString(), lastRequest: new Date().toISOString(), awake: true, phones: [{ id: 'a1b2c3d4e5f60718', name: 'pixel', pairedAt: new Date().toISOString(), lastSeen: null }], pair: { url: `https://mac.tail1234.ts.net:8443/pair#${'x'.repeat(43)}`, expiresAt: new Date(Date.now() + 120_000).toISOString() } };

it('the panel shows the state in words, the QR and its expiry after /remote on, and the phones', () => {
  const lines = remoteLines(validateRemoteStatus(ON), true).map(l => l.text);
  expect(lines[0]).toContain('● remote on · https://mac.tail1234.ts.net:8443');
  expect(lines.join('\n')).toContain('works once, until');
  expect(lines.some(l => /[▀▄█]/.test(l))).toBe(true);
  expect(lines.join('\n')).toContain('pixel · a1b2c3d4e5f60718 · paired');
  const off = remoteLines({ state: 'off', phones: [] }, false).map(l => l.text);
  expect(off[0]).toContain('○ remote off');
  expect(off.some(l => /[▀▄█]/.test(l))).toBe(false);
  expect(() => validateRemoteStatus({ ...ON, pair: { url: 'https://evil.example/pair#short', expiresAt: ON.pair?.expiresAt } })).toThrow();
});

it('/remote, /remote on, /remote off and /remote revoke <phone> each send one request', async () => {
  const requests: RequestBody[] = [];
  const client = Object.assign(new EventEmitter(), { async request(body: RequestBody): Promise<SuccessResponse> {
    requests.push(body); const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.get') response.settings = { theme: 'graphite' }; if (body.kind === 'sessions.list') response.sessions = []; if (body.kind === 'keys.list') response.keys = [];
    if (body.kind.startsWith('remote.')) response.remote = body.kind === 'remote.off' ? { state: 'off', phones: [] } : ON;
    return response;
  } });
  class TTY extends EventEmitter { isTTY = true; columns = 130; rows = 50; output = ''; setRawMode() {} resume() {} pause() {} write(s: string | Buffer) { this.output += String(s); return true; } }
  const screen = async (t: TTY) => { const term = new headless.Terminal({ cols: 130, rows: 50, allowProposedApi: true }); try { await new Promise<void>(r => term.write(t.output, r)); return Array.from({ length: 50 }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n'); } finally { term.dispose(); } };
  const tty = new TTY(), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', terminalProgram: 'unknown' }); await home.start();
  try {
    for (const [typed, expected] of [['/remote on', { kind: 'remote.on' }], ['/remote', { kind: 'remote.status' }], ['/remote revoke pixel', { kind: 'remote.revoke', phone: 'pixel' }], ['/remote off', { kind: 'remote.off' }]] as const) {
      tty.emit('data', Buffer.from(`${typed}\r`));
      const drawn = tty.output.split('remote on · https://').length;
      await vi.waitFor(() => expect(requests.filter(r => r.kind.startsWith('remote.')).at(-1)).toEqual(expected), { timeout: 10_000 });
      // The panel is open once it has been drawn again (off shows a note instead); Esc then closes it.
      if (expected.kind !== 'remote.off') await vi.waitFor(() => expect(tty.output.split('remote on · https://').length).toBeGreaterThan(drawn), { timeout: 10_000 });
      tty.emit('data', Buffer.from('\x1b'));
      await vi.waitFor(async () => expect(await screen(tty)).not.toContain('remote on · https://'), { timeout: 10_000 });
    }
  } finally { await home.stop(); }
}, 30_000);
