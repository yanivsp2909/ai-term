import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APICallError } from 'ai';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { Agent, type AgentIO } from '../src/agent/agent.js';
import { Transcript } from '../src/agent/transcript.js';
import { HttpReporter } from '../src/agent/report.js';
import { buildBashEnv } from '../src/daemon/env.js';
import type { AgentFacts } from '../src/shared/agent-facts.js';
import type { AgentStatus, Reporter, TokenUsage } from '../src/agent/report.js';
import { stubFacts } from './fixtures/agent-facts.js';

// v0.4 gate, money: every request is bounded by what the check assumed, and every request the provider may bill counts
// against the run cap and the budgets, even when it failed, sent no usage, or its usage never reached AI Term.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const usage = (input: number, output: number) => ({ inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: output, text: output, reasoning: undefined } });
const noUsage = { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } };
const textStep = (text: string, u: typeof noUsage | ReturnType<typeof usage> = usage(100, 10)) => ({ stream: convertArrayToReadableStream([{ type: 'stream-start' as const, warnings: [] }, { type: 'text-start' as const, id: 't' }, { type: 'text-delta' as const, id: 't', delta: text }, { type: 'text-end' as const, id: 't' }, { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage: u }]) });
const toolStep = (toolName: string, input: unknown, u = usage(100, 10)) => ({ stream: convertArrayToReadableStream([{ type: 'stream-start' as const, warnings: [] }, { type: 'tool-call' as const, toolCallId: `c${Math.random()}`, toolName, input: JSON.stringify(input) }, { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage: u }]) });
const PRICE = { input: 10, output: 50 };

class Harness implements Reporter, AgentIO {
  statuses: AgentStatus[] = []; usages: TokenUsage[] = []; notes: { text: string; tone?: string }[] = []; pauses: string[] = [];
  confirmed = true;
  constructor(public current: AgentFacts | null) {}
  async status(update: AgentStatus) { this.statuses.push(update); }
  async usage(_model: string, tokens: TokenUsage) { this.usages.push(tokens); return this.confirmed; }
  async facts() { return this.current; }
  text() {} toolStart() {} toolEnd() {}
  async approve() { return true; }
  note(text: string, tone?: 'info' | 'warn' | 'error') { this.notes.push({ text, ...(tone ? { tone } : {}) }); }
  async pause(text: string) { this.pauses.push(text); return false; }
}
async function agent(steps: NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>['doStream'], harness: Harness) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-gate-money-'))); roots.push(root);
  const model = new MockLanguageModelV4({ doStream: steps });
  return { model, agent: new Agent({ root, permission: 'dontAsk', model, modelId: 'm1', instructions: { text: '', files: [], notes: [] }, reporter: harness, transcript: new Transcript(null, t => t, () => {}), io: harness, redact: t => t, bashEnv: buildBashEnv(process.env), rg: null }) };
}
const go = () => new AbortController().signal;

it('every request carries the output allowance its check assumed, known limit or not', async () => {
  const unknown = new Harness(stubFacts({ price: PRICE, caps: { turns: 100, spendUsd: 5 } }));
  const a = await agent([toolStep('read', { path: '.' }), textStep('ok')], unknown);
  await a.agent.turn('go', go());
  expect(a.model.doStreamCalls.map(c => c.maxOutputTokens)).toEqual([16_000, 16_000]);
  // Facts that weren't there when the turn started still bound the next request (the check pauses without them).
  const late = new Harness(null), b = await agent([textStep('ok')], late);
  setTimeout(() => { late.current = stubFacts({ price: PRICE, output: 8000 }); }, 0);
  await b.agent.turn('go', go());
  expect(late.pauses).toHaveLength(1);
  const known = new Harness(stubFacts({ price: PRICE, output: 8000 })), c = await agent([textStep('ok')], known);
  await c.agent.turn('go', go());
  expect(c.model.doStreamCalls[0]?.maxOutputTokens).toBe(8000);
});

it('a request that fails after the provider started answering counts its worst case; one refused before that does not', async () => {
  const h = new Harness(stubFacts({ price: PRICE }));
  const broken = { stream: convertArrayToReadableStream([{ type: 'stream-start' as const, warnings: [] }, { type: 'text-start' as const, id: 't' }, { type: 'text-delta' as const, id: 't', delta: 'x'.repeat(2000) }, { type: 'error' as const, error: new Error('connection reset') }]) };
  const a = await agent([broken], h);
  expect(await a.agent.turn('go', go())).toBe('failed');
  expect(a.agent.limits.unreported).toBeGreaterThan(0.8);
  expect(a.agent.limits.spent).toBe(a.agent.limits.unreported);
  const refused = new Harness(stubFacts({ price: PRICE })), root = await realpath(await mkdtemp(join(tmpdir(), 'ai-gate-money-'))); roots.push(root);
  const model = new MockLanguageModelV4({ doStream: async () => { throw new APICallError({ message: 'bad request', url: 'https://example.invalid', requestBodyValues: {}, statusCode: 400, isRetryable: false }); } });
  const b = new Agent({ root, permission: 'dontAsk', model, modelId: 'm1', instructions: { text: '', files: [], notes: [] }, reporter: refused, transcript: new Transcript(null, t => t, () => {}), io: refused, redact: t => t, bashEnv: {}, rg: null });
  expect(await b.turn('go', go())).toBe('failed');
  expect(b.limits.spent).toBe(0);
});

it('a finished request without usage counts its worst case and says so, instead of costing nothing', async () => {
  const h = new Harness(stubFacts({ price: PRICE }));
  const a = await agent([textStep('a long reply', noUsage)], h);
  expect(await a.agent.turn('go', go())).toBe('done');
  expect(a.agent.limits.spent).toBeGreaterThan(0.8);
  expect(a.agent.limits.unreported).toBe(a.agent.limits.spent);
  expect(h.notes.some(n => n.tone === 'warn' && n.text.includes('no usage'))).toBe(true);
});

it('usage AI Term never confirmed still counts against the budgets, and the agent says so', async () => {
  const h = new Harness(stubFacts({ price: PRICE, budgets: { daily: 0.9, weekly: null, monthly: null } }));
  h.confirmed = false;
  const a = await agent([toolStep('read', { path: '.' }, usage(10_000, 10_000)), textStep('small')], h);
  // Request 1 ($0.60) fits the daily budget; the daemon never got its usage, so its spend stays at 0 there. Request 2's
  // allowance must still count request 1: what is left is $0.30, not $0.90 (at $50/M output, under 6,000 tokens).
  expect(await a.agent.turn('go', go())).toBe('done');
  expect(a.model.doStreamCalls[1]?.maxOutputTokens).toBeLessThan(6000);
  expect(h.notes.some(n => n.tone === 'warn' && n.text.includes("usage isn't reaching AI Term"))).toBe(true);
});

it("HttpReporter.usage says whether AI Term took the usage: a failed post or a missing usage credential is false", async () => {
  const server = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(req.url === '/v1/metrics' ? 503 : 204); res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const failing = new HttpReporter({ port, status: 'a'.repeat(64), usage: 'b'.repeat(64) }, () => {});
    expect(await failing.usage('m1', { input: 1, cached: 0, output: 1 })).toBe(false);
    const missing = new HttpReporter({ port, status: 'a'.repeat(64) }, () => {});
    expect(await missing.usage('m1', { input: 1, cached: 0, output: 1 })).toBe(false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
