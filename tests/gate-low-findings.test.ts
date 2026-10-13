// v0.2 gate, bounty-hunt LOW findings that contradict a stated rule (S12 always-204, S15 copy drops separators).
import { expect, it } from 'vitest';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { UsageReceiver } from '../src/daemon/usage-receiver.js';
import { safeText } from '../src/client/tui/grid.js';
function raw(port: number, text: string): Promise<string> {
  return new Promise((done, fail) => { let data = ''; const socket = connect(port, '127.0.0.1', () => socket.write(text)); socket.setEncoding('utf8'); socket.on('data', (c: string) => { data += c; }); socket.on('error', fail); socket.on('close', () => done(data)); setTimeout(() => socket.destroy(), 3000); });
}
it('S12: a status request with any Expect header still gets an empty 204, never Node\'s 417', async () => {
  const updates: unknown[] = [], receiver = new UsageReceiver(async () => {}, { error: () => {} }, async (id, body) => { updates.push({ id, body }); });
  await receiver.listen();
  try {
    const port = receiver.port(), token = receiver.registerStatus(randomUUID()), body = '{"hook_event_name":"Stop"}';
    const reply = await raw(port, `POST /v1/status/claude HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nx-ai-term-session: ${token}\r\nExpect: AITERMCANARY\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
    expect(reply.split('\r\n')[0]).toBe('HTTP/1.1 204 No Content');
    expect(reply.split('\r\n\r\n')[1] ?? '').toBe('');
  } finally { await receiver.close(); }
});
it('S15: text drawn from agent cells drops line and paragraph separators, like copy', () => {
  expect(safeText('rm -rf  xyz')).toBe('rm-rf xyz');
});
