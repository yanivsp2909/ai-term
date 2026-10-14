import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { Agent, type AgentIO } from '../src/agent/agent.js';
import { AgentApp } from '../src/agent/app.js';
import { Screen } from '../src/agent/screen.js';
import { Transcript } from '../src/agent/transcript.js';
import { RunLimits, requestCost } from '../src/agent/limits.js';
import { findPrice, estimateCost, type PriceSnapshot } from '../src/daemon/usage-prices.js';
import { parseAgentFacts, DEFAULT_AGENT_CAPS } from '../src/shared/agent-facts.js';
import { catalogIds } from '../src/shared/model-catalog.js';
import { CredentialsPanel } from '../src/client/tui/credentials.js';
import { createTheme } from '../src/client/tui/theme.js';
import { buildBashEnv } from '../src/daemon/env.js';
import prices from '../data/usage-prices.json' with { type: 'json' };
import type { AgentStatus, Reporter, TokenUsage } from '../src/agent/report.js';
import type { AgentFacts } from '../src/shared/agent-facts.js';
import type { KeyView, Settings } from '../src/shared/protocol.js';
import { stubFacts } from './fixtures/agent-facts.js';
import { randomUUID } from 'node:crypto';

// v0.4.2 typescript review findings, each reproduced here before its fix.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const usage = (input: number, output: number, cached = 0) => ({ inputTokens: { total: input, noCache: input - cached, cacheRead: cached, cacheWrite: undefined }, outputTokens: { total: output, text: output, reasoning: undefined } });
const toolStep = (input: number, cached = 0) => ({ stream: convertArrayToReadableStream([{ type: 'stream-start' as const, warnings: [] }, { type: 'tool-call' as const, toolCallId: `c${Math.random()}`, toolName: 'read', input: JSON.stringify({ path: '.' }) }, { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage: usage(input, 10, cached) }]) });
const textStep = (text: string, u = usage(10, 1)) => ({ stream: convertArrayToReadableStream([{ type: 'stream-start' as const, warnings: [] }, { type: 'text-start' as const, id: 't' }, { type: 'text-delta' as const, id: 't', delta: text }, { type: 'text-end' as const, id: 't' }, { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage: u }]) });

class Harness implements Reporter, AgentIO {
  statuses: AgentStatus[] = []; pauses: string[] = []; usages: TokenUsage[] = [];
  constructor(public current: AgentFacts | null, private readonly answers: boolean[] = []) {}
  async status(update: AgentStatus) { this.statuses.push(update); }
  async usage(_m: string, t: TokenUsage) { this.usages.push(t); }
  async facts() { return this.current; }
  text() {} toolStart() {} toolEnd() {} note() {}
  async approve() { return true; }
  async pause(text: string) { this.pauses.push(text); return this.answers.shift() ?? false; }
}
async function agent(steps: NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>['doStream'], harness: Harness) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-r042-'))); roots.push(root);
  const model = new MockLanguageModelV4({ doStream: steps });
  return { root, model, agent: new Agent({ root, permission: 'dontAsk', model, modelId: 'm1', instructions: { text: '', files: [], notes: [] }, reporter: harness, transcript: new Transcript(null, t => t, () => {}), io: harness, redact: t => t, bashEnv: buildBashEnv(process.env), rg: null }) };
}
const go = () => new AbortController().signal;

it('HIGH: a model priced without a cache rate still counts cache hits (at the input rate), so caps and budgets see them', async () => {
  const kimi = findPrice(prices as PriceSnapshot, 'foundry', 'my-kimi', {}, 'kimi-k2.6');
  expect(kimi?.cacheRead).toBeUndefined();
  expect(requestCost(kimi ?? null, 1000, 500, 100)).toBeCloseTo((1000 * (kimi?.input ?? 0) + 100 * (kimi?.output ?? 0)) / 1e6, 12);
  expect(estimateCost({ input: 2, output: 10 }, 1000, 100, 500)).toBeCloseTo((1000 * 2 + 100 * 10) / 1e6, 12);
  const h = new Harness(stubFacts({ price: { input: 1, output: 1 }, caps: { turns: null, spendUsd: 0.05 } }));
  const { model, agent: a } = await agent([toolStep(40_000, 30_000), textStep('small')], h);
  await a.turn('go', go());
  // The cache hits count, so the next request gets only what is left of the cap (v0.4 gate: sized allowance, not a pause).
  expect(a.limits.spent).toBeGreaterThan(0.04); expect(h.pauses).toEqual([]);
  expect(model.doStreamCalls[1]?.maxOutputTokens).toBeLessThan(Math.floor((0.05 - a.limits.spent + 0.000001) * 1e6));
});

it('MEDIUM: /caps before the first request changes only what it names; the daemon\'s defaults fill the rest', () => {
  const limits = new RunLimits();
  limits.change({ spendUsd: 2 });
  limits.check(stubFacts({ price: { input: 1, output: 1 }, caps: DEFAULT_AGENT_CAPS }), 0);
  expect(limits.current).toEqual({ turns: 100, spendUsd: 2 });
});

function appHarness(steps: NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>['doStream'], facts: (model: string) => Promise<AgentFacts | null> = async () => stubFacts()) {
  return (async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-r042-'))); roots.push(root);
    const statuses: AgentStatus[] = []; let out = '';
    const reporter: Reporter = { status: async s => { statuses.push(s); }, usage: async () => {}, facts };
    const screen = new Screen({ write: t => { out += t; }, columns: 100, rows: 40 }, createTheme('graphite'));
    const model = new MockLanguageModelV4({ doStream: steps });
    let release = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
    const app = new AgentApp({ screen, permission: 'dontAsk', models: ['m1', 'm2'], quit: vi.fn(), makeModel: async id => { if (id === 'm2') await gate; return model; },
      agent: io => new Agent({ root, permission: 'dontAsk', model, modelId: 'm1', instructions: { text: '', files: [], notes: [] }, reporter, transcript: new Transcript(null, t => t, () => {}), io, redact: t => t, bashEnv: buildBashEnv(process.env), rg: null }) });
    return { app, model, statuses, release, output: () => out };
  })();
}

it('MEDIUM: a message queued behind a queued command still runs', async () => {
  const h = await appHarness([textStep('one'), textStep('two')]);
  h.app.start(); h.app.input('first\r'); h.app.input('/clear\r'); h.app.input('second\r');
  await vi.waitFor(() => expect(h.model.doStreamCalls).toHaveLength(2));
});

it('MEDIUM: /clear and a model switch don\'t leave a stale context % (or warning) on the card', async () => {
  const h = new Harness(stubFacts({ context: 1000 }));
  const { agent: a } = await agent([textStep('a', usage(950, 1))], h);
  await a.turn('one', go());
  a.clear(); expect(h.statuses.at(-1)).toEqual({ event: 'context', percent: 0 });
  a.setModel(new MockLanguageModelV4(), 'm2'); expect(h.statuses.filter(s => s.event === 'context').at(-1)).toEqual({ event: 'context', percent: null });
});

it('MEDIUM: a model whose wire is unknown (no facts) is refused, never sent down the wrong API', async () => {
  const { foundryWireFor } = await import('../src/agent/main.js');
  await expect(foundryWireFor(async () => null, 'kimi-k3')).rejects.toThrow("couldn't learn how to reach kimi-k3");
  await expect(foundryWireFor(async () => stubFacts({ wire: 'chat' }), 'kimi-k3')).resolves.toBe('chat');
});

// Reversed by the v0.4 gate: with nothing sent, a provider writes up to its own maximum (128k for Claude) and one checked
// request could pass the $5 cap. The request now carries the 16k the check assumed (tests/v04-gate-money.test.ts).
it('MEDIUM: with no known output limit the request carries the 16k allowance the worst case assumes', async () => {
  const h = new Harness(stubFacts());
  const { model, agent: a } = await agent([textStep('ok')], h);
  await a.turn('go', go());
  expect(model.doStreamCalls[0]?.maxOutputTokens).toBe(16_000);
  const known = new Harness(stubFacts({ output: 8000 })), second = await agent([textStep('ok')], known);
  await second.agent.turn('go', go()); expect(second.model.doStreamCalls[0]?.maxOutputTokens).toBe(8000);
});

it('LOW: a request interrupted after it was sent counts its worst case against the run and the budgets', async () => {
  const hanging = { stream: new ReadableStream({ start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'text-start', id: 't' }); c.enqueue({ type: 'text-delta', id: 't', delta: 'x' }); } }) };
  const h = new Harness(stubFacts({ price: { input: 1, output: 1 }, caps: { turns: null, spendUsd: 1 } }));
  const { agent: a } = await agent([hanging as never], h), abort = new AbortController();
  setTimeout(() => abort.abort(), 100);
  await a.turn('go', abort.signal);
  expect(a.limits.spent).toBeGreaterThan(0.015);
});

it('LOW: a message typed while /model switches waits for the switch, and runs on the new model', async () => {
  const h = await appHarness([textStep('on m2')]);
  h.app.start(); h.app.input('/model m2\r');
  await new Promise(resolve => setTimeout(resolve, 20));
  h.app.input('hello\r');
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(h.model.doStreamCalls).toHaveLength(0);
  h.release();
  await vi.waitFor(() => expect(h.model.doStreamCalls).toHaveLength(1));
  expect(h.output()).toContain('model: m2');
});

it('LOW: typing a filter in "this deployment is…" selects the first match, not (not set)', async () => {
  const key: KeyView = { id: randomUUID(), provider: 'foundry', label: 'n', last4: 'abcd', endpoint: 'https://r.openai.azure.com/openai/v1', deployments: ['my-kimi'] };
  let settings: Settings = { theme: 'graphite', deploymentModels: { 'my-kimi': 'kimi-k2.5' } };
  const panel = new CredentialsPanel('settings', { request: async body => { if (body.kind === 'settings.set') settings = { ...settings, ...body.patch }; return { id: randomUUID(), ok: true, settings, keys: [key] }; }, changed() {}, close() {}, login: async () => {}, defaults() {}, theme: async () => {} });
  await panel.load(); await panel.key('m'); await panel.key('enter');
  for (const char of 'kimi-k2.6') await panel.key(char);
  await panel.key('enter');
  expect(settings.deploymentModels).toEqual({ 'my-kimi': 'kimi-k2.6' });
});

it('LOW: the deployment picker offers real chat models the /model filter left out (instruct, dated names)', () => {
  expect(catalogIds()).toEqual(expect.arrayContaining(['llama-3.3-70b-instruct', 'mistral-medium-2505', 'codestral-2501']));
  expect(catalogIds().some(id => /embed|image|tts|whisper/.test(id))).toBe(false);
});

it('LOW: facts with a malformed price are refused, not read as "no price"', () => {
  const good = stubFacts();
  expect(parseAgentFacts(good)).not.toBeNull();
  expect(parseAgentFacts({ ...good, price: 'free' })).toBeNull();
});
