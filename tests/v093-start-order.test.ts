import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import headless from '@xterm/headless';
import { Homepage } from '../src/client/tui/homepage.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SuccessResponse } from '../src/shared/protocol.js';

// v0.9.3 perf review: the homepage draws before the engine check now, so you can start typing before it answers; the
// "nothing is logged in" popup must not then take over what you started.
class TTY extends EventEmitter { isTTY = true; isRaw = false; columns = 130; rows = 45; output = ''; setRawMode(v: boolean) { this.isRaw = v; } resume() {} pause() {} write(data: string | Buffer) { this.output += data.toString(); return true; } }
async function screen(tty: TTY): Promise<string> { const terminal = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true }); try { await new Promise<void>(resolve => terminal.write(tty.output, resolve)); return Array.from({ length: 45 }, (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n'); } finally { terminal.dispose(); } }
async function start(engineDelay: number) {
  const requests: RequestBody[] = [];
  const client = Object.assign(new EventEmitter(), { async request(body: RequestBody): Promise<SuccessResponse> {
    requests.push(body); const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.get') response.settings = { theme: 'graphite' };
    if (body.kind === 'sessions.list') response.sessions = [];
    if (body.kind === 'keys.list') response.keys = [];
    if (body.kind === 'engines.status') { await new Promise(resolve => setTimeout(resolve, engineDelay)); response.engines = { claudeCode: { installed: true, path: '/x', version: '1', loggedIn: false, authMethod: null }, codex: { installed: true, path: '/y', version: '1', loggedIn: false, authMethod: null } } as never; }
    return response;
  } });
  const tty = new TTY(), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', terminalProgram: 'unknown' });
  return { tty, home, requests, started: home.start() };
}

it('with nothing logged in and nothing typed, the login popup opens as before', async () => {
  const { requests, started } = await start(0);
  await started;
  expect(requests.some(body => body.kind === 'keys.list')).toBe(true);
  await vi.waitFor(() => expect(requests.filter(body => body.kind === 'keys.list').length).toBeGreaterThan(1));
});

it('typing before the engine check answers keeps what you typed; the popup stays closed and a note says how to log in', async () => {
  const { tty, home, requests, started } = await start(300);
  await vi.waitFor(() => expect(tty.output).toContain('AI Term'));
  for (const char of 'fix the') tty.emit('data', Buffer.from(char));
  await started;
  expect(requests.filter(body => body.kind === 'keys.list').length).toBe(1);
  expect((home as unknown as { field: { text: string } }).field.text).toBe('fix the');
  await vi.waitFor(async () => expect(await screen(tty)).toContain('No engine is logged in and no API key is saved · /login connects one'));
});
