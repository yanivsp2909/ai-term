import { afterEach, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { Agent, type AgentIO } from '../src/agent/agent.js';
import { Transcript } from '../src/agent/transcript.js';
import { redactor, streamRedactor } from '../src/agent/display.js';
import type { AgentStatus } from '../src/agent/report.js';
import { stubFacts } from './fixtures/agent-facts.js';

// v0.4 gate (S19): the key never reaches the screen or the daemon's last reply, even when the model streams it in pieces.
const KEY = 'sk-test-CANARY0000000000000000';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('a stream redactor catches a key split across chunks, and one that repeats its own prefix', () => {
  for (const [secret, chunks] of [[KEY, ['say sk-test-CANA', 'RY000000', '0000000000 ok']], ['abcab', ['xabc', 'ab', 'y']], [KEY, ['s', 'k', '-', 'test-CANARY0000000000000000']]] as const) {
    const stream = streamRedactor(secret), out = chunks.map(c => stream.push(c)).join('') + stream.flush();
    expect(out).not.toContain(secret);
    expect(out).toBe(redactor(secret)(chunks.join('')));
  }
  const tail = streamRedactor(KEY);
  expect(tail.push('ends with sk-te')).toBe('ends with ');
  expect(tail.flush()).toBe('sk-te');
});

it("a key streamed in two deltas never reaches the screen or the reply sent to the daemon", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-gate-redact-'))); roots.push(root);
  const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
  const model = new MockLanguageModelV4({ doStream: [{ stream: convertArrayToReadableStream([{ type: 'stream-start' as const, warnings: [] }, { type: 'text-start' as const, id: 't' }, { type: 'text-delta' as const, id: 't', delta: 'key: sk-test-CANA' }, { type: 'text-delta' as const, id: 't', delta: 'RY0000000000000000 done' }, { type: 'text-end' as const, id: 't' }, { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage }]) }] });
  let screen = ''; const statuses: AgentStatus[] = [];
  const io: AgentIO = { text: t => { screen += t; }, toolStart: () => {}, toolEnd: () => {}, note: () => {}, pause: async () => false, approve: async () => false };
  const agent = new Agent({ root, permission: 'ask', model, modelId: 'm1', instructions: { text: '', files: [], notes: [] }, reporter: { status: async s => { statuses.push(s); }, usage: async () => true, facts: async () => stubFacts() }, transcript: new Transcript(null, t => t, () => {}), io, redact: redactor(KEY), redactStream: () => streamRedactor(KEY), bashEnv: {}, rg: null });
  expect(await agent.turn('go', new AbortController().signal)).toBe('done');
  expect(screen).toBe('key: [redacted] done');
  expect(JSON.stringify(statuses)).not.toContain('CANARY');
  expect(statuses.at(-1)).toEqual({ event: 'done', reply: 'key: [redacted] done' });
});
