import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { UsageService } from '../src/daemon/usage-service.js';
it('B19 caps unique usage records per session per minute, logs once and renews independently', async () => {
  const root = await mkdtemp('/tmp/ai-b19-'), logs: string[] = [];
  const usage = new UsageService(root, { error: text => logs.push(text) });
  try {
    await usage.start(); vi.useFakeTimers({ toFake: ['Date'] });
    const a = usage.register({ sessionId: randomUUID(), engine: 'codex', provider: 'openai', model: 'unknown' });
    const b = usage.register({ sessionId: randomUUID(), engine: 'codex', provider: 'openai', model: 'unknown' });
    let time = 0;
    const send = (t: typeof a, count: number) => fetch(`http://127.0.0.1:${t.port}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ai-term-session': t.credential }, body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: Array.from({ length: count }, () => ({ timeUnixNano: String(++time), attributes: [{ key: 'event.name', value: { stringValue: 'codex.sse_event' } }, { key: 'event.kind', value: { stringValue: 'response.completed' } }, { key: 'input_token_count', value: { intValue: '1' } }, { key: 'output_token_count', value: { intValue: '0' } }] })) }] }] }) });
    expect((await send(a, 121)).status).toBe(200); expect((await send(a, 5)).status).toBe(200);
    expect(usage.summary().today.tokens).toBe(120); expect(logs).toEqual(['Usage record limit exceeded; excess records dropped']);
    expect((await send(b, 1)).status).toBe(200); expect(usage.summary().today.tokens).toBe(121);
    vi.setSystemTime(Date.now() + 60000);
    expect((await send(a, 122)).status).toBe(200); expect(usage.summary().today.tokens).toBe(241);
    expect(logs).toHaveLength(2);
    const text = await readFile(join(root, 'usage', new Date().toISOString().slice(0, 7) + '.jsonl'), 'utf8');
    expect(text.trim().split('\n')).toHaveLength(241); expect(logs.join('')).not.toContain(a.credential);
  } finally { vi.useRealTimers(); await usage.close(); await rm(root, { recursive: true, force: true }); }
});
