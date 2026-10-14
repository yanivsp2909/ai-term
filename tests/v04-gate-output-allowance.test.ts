import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { Agent, type AgentIO } from '../src/agent/agent.js';
import { Transcript } from '../src/agent/transcript.js';
import { worstCase } from '../src/agent/limits.js';
import { catalogTokens, extensionTokens, type ExtensionAccess, type ExtensionFile } from '../src/shared/extensions.js';
import type { AgentFacts } from '../src/shared/agent-facts.js';
import type { AgentStatus, Reporter, TokenUsage } from '../src/agent/report.js';
import { stubFacts } from './fixtures/agent-facts.js';

// v0.4 gate (Yaniv): before each request the output allowance is sized so its worst case (input + max output × output
// price; reasoning is output, bounded by the same allowance) fits what's left of the run cap and every budget, never above
// the model's own limit. Under 1,000 tokens left, or an unknown price, it pauses and asks. Subagents follow the same rule.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 10, text: 10, reasoning: undefined } };
const textStep = () => ({ stream: convertArrayToReadableStream([{ type: 'stream-start' as const, warnings: [] }, { type: 'text-start' as const, id: 't' }, { type: 'text-delta' as const, id: 't', delta: 'ok' }, { type: 'text-end' as const, id: 't' }, { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage }]) });
const toolStep = (toolName: string, input: unknown) => ({ stream: convertArrayToReadableStream([{ type: 'stream-start' as const, warnings: [] }, { type: 'tool-call' as const, toolCallId: `c${Math.random()}`, toolName, input: JSON.stringify(input) }, { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage }]) });
const PRICE = { input: 1, output: 10 };

class Harness implements Reporter, AgentIO {
  statuses: AgentStatus[] = []; pauses: string[] = []; worst: number[] = [];
  constructor(public current: AgentFacts | null, private readonly answers: boolean[] = []) {}
  async status(update: AgentStatus) { this.statuses.push(update); }
  async usage(_model: string, _tokens: TokenUsage) { return true; }
  async facts(model: string) { return this.current && { ...this.current, model }; }
  text() {} toolStart() {} toolEnd() {} note() {}
  async approve() { return true; }
  async confirmJob() { return true; }
  async pause(text: string) { this.pauses.push(text); return this.answers.shift() ?? false; }
}
const reviewer = { id: '0000000000000000', kind: 'agent' as const, name: 'reviewer', description: 'r', source: 'shared' as const, enabled: true, tokens: extensionTokens('agent reviewer: r\n') };
const extensions: ExtensionAccess = { list: async () => ({ items: [reviewer], notes: [], tokens: catalogTokens([reviewer]) }), read: async (): Promise<ExtensionFile> => ({ item: { ...reviewer }, text: 'x', body: 'x' }), toggle: async () => { throw new Error('unused'); } };
async function agent(steps: NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>['doStream'], h: Harness) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-gate-allowance-'))); roots.push(root);
  const model = new MockLanguageModelV4({ doStream: steps });
  const a = new Agent({ root, permission: 'ask', model, modelId: 'm1', instructions: { text: '', files: [], notes: [] }, reporter: h, transcript: new Transcript(null, t => t, () => {}), io: h, redact: t => t, bashEnv: {}, rg: null, extensions, models: ['m1'] });
  return { model, agent: a };
}
const go = () => new AbortController().signal;
const sent = (model: MockLanguageModelV4) => model.doStreamCalls.map(c => c.maxOutputTokens ?? -1);

it('a tiny remaining run cap sends a small output allowance whose worst case still fits the cap', async () => {
  const h = new Harness(stubFacts({ price: PRICE, caps: { turns: null, spendUsd: 0.02 } }));
  const a = await agent([textStep()], h);
  expect(await a.agent.turn('go', go())).toBe('done');
  const [allowance = -1] = sent(a.model);
  expect(allowance).toBeGreaterThanOrEqual(1000); expect(allowance).toBeLessThan(2000);
  expect(h.pauses).toEqual([]);
});

it('the daily budget sizes the allowance too, when what is left of it is tighter than the cap', async () => {
  const h = new Harness(stubFacts({ price: PRICE, output: 100_000, caps: { turns: null, spendUsd: 5 }, budgets: { daily: 1, weekly: null, monthly: null }, spent: { day: 0.98, week: 0, month: 0 } }));
  const a = await agent([textStep()], h);
  expect(await a.agent.turn('go', go())).toBe('done');
  const [allowance = -1] = sent(a.model);
  expect(allowance).toBeGreaterThanOrEqual(1000); expect(allowance).toBeLessThan(2000);
  // Never above the model's own limit, however much is left.
  const roomy = new Harness(stubFacts({ price: PRICE, output: 4000, caps: { turns: null, spendUsd: 5 } })), b = await agent([textStep()], roomy);
  await b.agent.turn('go', go());
  expect(sent(b.model)).toEqual([4000]);
});

it('when what is left fits fewer than 1,000 output tokens it pauses and asks; ⏎ allows more and the request goes', async () => {
  const h = new Harness(stubFacts({ price: PRICE, caps: { turns: null, spendUsd: 0.008 } }), [true]);
  const a = await agent([textStep()], h);
  expect(await a.agent.turn('go', go())).toBe('done');
  expect(h.pauses).toHaveLength(1);
  expect(h.pauses[0]).toMatch(/^cap reached: \$0\.008 this run · spent \$0\.000 · what's left fits under 1,000 output tokens · ⏎ allows \$0\.008 more · Esc stops$/);
  const [allowance = -1] = sent(a.model);
  expect(allowance).toBeGreaterThanOrEqual(1000);
  expect(worstCase(PRICE, 0, allowance)).toBeLessThanOrEqual(0.016);
});

it('an unknown output price pauses and asks; ⏎ sends it bounded by the model limit, never with no limit', async () => {
  const stop = new Harness(stubFacts({ caps: { turns: null, spendUsd: 5 } }));
  const a = await agent([textStep()], stop);
  expect(await a.agent.turn('go', go())).toBe('interrupted');
  expect(a.model.doStreamCalls).toHaveLength(0);
  expect(stop.pauses[0]).toContain('no price known for m1');
  const goOn = new Harness(stubFacts({ caps: { turns: null, spendUsd: 5 } }), [true]), b = await agent([textStep()], goOn);
  expect(await b.agent.turn('go', go())).toBe('done');
  expect(sent(b.model)).toEqual([16_000]);
});

it('a subagent request follows the same rule: its allowance fits what the parent left of the cap', async () => {
  const h = new Harness(stubFacts({ price: PRICE, output: 2000, caps: { turns: null, spendUsd: 0.04 } }));
  const a = await agent([toolStep('task', { name: 'reviewer', prompt: 'review' }), textStep(), textStep()], h);
  expect(await a.agent.turn('go', go())).toBe('done');
  const [parent = -1, child = -1, after = -1] = sent(a.model);
  expect(parent).toBe(2000);
  // The parent's request is still open (reserved at its worst case) while the child spends, so the child gets less.
  expect(child).toBeGreaterThanOrEqual(1000); expect(child).toBeLessThan(2000);
  expect(after).toBe(2000);
});
