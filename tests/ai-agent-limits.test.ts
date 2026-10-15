import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { Agent, type AgentIO } from '../src/agent/agent.js';
import { AgentApp } from '../src/agent/app.js';
import { Screen } from '../src/agent/screen.js';
import { Transcript } from '../src/agent/transcript.js';
import { RunLimits, requestCost, worstCase, TOOL_SCHEMA_TOKENS } from '../src/agent/limits.js';
import { killAllBash, runBash } from '../src/agent/bash.js';
import { findPrice, type PriceSnapshot } from '../src/daemon/usage-prices.js';
import { createTheme } from '../src/client/tui/theme.js';
import { buildBashEnv } from '../src/daemon/env.js';
import prices from '../data/usage-prices.json' with { type: 'json' };
import type { AgentFacts } from '../src/shared/agent-facts.js';
import type { AgentStatus, Reporter, TokenUsage } from '../src/agent/report.js';
import { stubFacts } from './fixtures/agent-facts.js';

// v0.4.2: what a turn costs, and that AI Term's agent can never spend past a cap or budget without asking first.
const roots: string[] = [];
afterEach(async () => { killAllBash(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const usage = (input: number, output: number, cached = 0, reasoning = 0) => ({ inputTokens: { total: input, noCache: input - cached, cacheRead: cached, cacheWrite: undefined }, outputTokens: { total: output, text: output - reasoning, reasoning } });
const toolStep = (toolName: string, input: unknown, u = usage(100, 10)) => ({ stream: convertArrayToReadableStream([{ type: 'stream-start' as const, warnings: [] }, { type: 'tool-call' as const, toolCallId: `c${Math.random()}`, toolName, input: JSON.stringify(input) }, { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage: u }]) });
const textStep = (text: string, u = usage(150, 20)) => ({ stream: convertArrayToReadableStream([{ type: 'stream-start' as const, warnings: [] }, { type: 'text-start' as const, id: 't' }, { type: 'text-delta' as const, id: 't', delta: text }, { type: 'text-end' as const, id: 't' }, { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage: u }]) });

class Harness implements Reporter, AgentIO {
  statuses: AgentStatus[] = []; usages: TokenUsage[] = []; notes: { text: string; tone?: string }[] = []; pauses: string[] = [];
  constructor(public current: AgentFacts | null, private readonly answers: boolean[] = []) {}
  async status(update: AgentStatus) { this.statuses.push(update); }
  async usage(_model: string, tokens: TokenUsage) { this.usages.push(tokens); }
  async facts() { return this.current; }
  text() {} toolStart() {} toolEnd() {}
  async approve() { return true; }
  note(text: string, tone?: 'info' | 'warn' | 'error') { this.notes.push({ text, ...(tone ? { tone } : {}) }); }
  async pause(text: string) { this.pauses.push(text); return this.answers.shift() ?? false; }
}
async function agent(steps: NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>['doStream'], harness: Harness) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-limits-'))); roots.push(root);
  const model = new MockLanguageModelV4({ doStream: steps });
  return { model, agent: new Agent({ root, permission: 'dontAsk', model, modelId: 'm1', instructions: { text: '', files: [], notes: [] }, reporter: harness, transcript: new Transcript(null, t => t, () => {}), io: harness, redact: t => t, bashEnv: buildBashEnv(process.env), rg: null }) };
}
const go = () => new AbortController().signal;

it('cost per request uses the provider\'s own counts: cached at the cache rate, reasoning inside output, per provider', () => {
  const snapshot = prices as PriceSnapshot, sonnet = findPrice(snapshot, 'anthropic', 'claude-sonnet-5', {}), sol = findPrice(snapshot, 'openai', 'gpt-6.1-sol', {});
  expect(sonnet).toEqual({ input: 2, output: 10, cacheRead: 0.2 });
  // 1,000 input of which 400 cached, 500 output of which 200 reasoning: (600×2 + 400×0.2 + 500×10) / 1e6.
  expect(requestCost(sonnet ?? null, 1000, 400, 500)).toBeCloseTo(0.00628, 10);
  expect(requestCost(sol ?? null, 2000, 0, 100)).toBeCloseTo((2000 * (sol?.input ?? 0) + 100 * (sol?.output ?? 0)) / 1e6, 12);
  // A Foundry deployment marked "this is model X" is priced as X; its own override still wins.
  expect(findPrice(snapshot, 'foundry', 'my-kimi', {}, 'kimi-k2.6')).toEqual(snapshot.providers.azure['kimi-k2.6']);
  expect(findPrice(snapshot, 'foundry', 'my-kimi', { 'my-kimi': { input: 9, output: 9 } }, 'kimi-k2.6')).toEqual({ input: 9, output: 9, cacheRead: 9 });
  expect(requestCost(null, 10, 0, 10)).toBeNull();
  expect(worstCase({ input: 3, output: 15 }, 2000, 16_000)).toBeCloseTo(((2000 + TOOL_SCHEMA_TOKENS) * 3 + 16_000 * 15) / 1e6, 12);
});

it('each turn shows its exact cost from the provider\'s counts and reports reasoning with usage', async () => {
  const h = new Harness(stubFacts({ price: { input: 2, output: 10, cacheRead: 0.2 } }));
  const { agent: a } = await agent([toolStep('read', { path: '.' }, usage(1000, 500, 400, 200)), textStep('ok', usage(1200, 100))], h);
  expect(await a.turn('go', go())).toBe('done');
  expect(h.usages).toEqual([{ input: 1000, cached: 400, output: 500, reasoning: 200 }, { input: 1200, cached: 0, output: 100, reasoning: 0 }]);
  const cost = 0.00628 + (1200 * 2 + 100 * 10) / 1e6;
  expect(h.notes.at(-1)?.text).toBe(`turn · 2.2k in · 400 cached · 600 out · 200 reasoning · $${cost.toFixed(4)} · run 2 turns (no cap) · $0.010 (no spend cap) this run`);
});

it('a budget stop happens before the request that would cross it: nothing is sent, and you are asked', async () => {
  const h = new Harness(stubFacts({ price: { input: 2, output: 10 }, budgets: { daily: 1, weekly: null, monthly: null }, spent: { day: 0.99, week: 0.99, month: 0.99 } }));
  const { model, agent: a } = await agent([textStep('never')], h);
  expect(await a.turn('hi', go())).toBe('interrupted');
  expect(model.doStreamCalls).toHaveLength(0);
  expect(h.pauses[0]).toBe("budget: today $0.990 of $1.00 · what's left fits under 1,000 output tokens · raise it on the homepage (b), then ⏎ checks again · Esc stops");
  expect(h.statuses.map(s => s.event)).toEqual(['turn-start', 'paused', 'answered', 'done']);
  // Raised on the homepage meanwhile: ⏎ checks again and the request goes.
  const raised = new Harness(stubFacts({ price: { input: 2, output: 10 }, budgets: { daily: 1, weekly: null, monthly: null }, spent: { day: 0.99, week: 0, month: 0 } }), [true]);
  const second = await agent([textStep('ok')], raised);
  raised.pause = async text => { raised.pauses.push(text); raised.current = stubFacts({ price: { input: 2, output: 10 }, budgets: { daily: 5, weekly: null, monthly: null } }); return true; };
  expect(await second.agent.turn('hi', go())).toBe('done'); expect(second.model.doStreamCalls).toHaveLength(1);
});

it('the turn cap pauses after N requests; ⏎ allows N more, Esc stops with nothing else sent', async () => {
  const steps = () => Array.from({ length: 6 }, (_, i) => toolStep('read', { path: '.' }, usage(10 + i, 1)));
  const stopper = new Harness(stubFacts({ caps: { turns: 2, spendUsd: null } }));
  const stopped = await agent(steps(), stopper);
  expect(await stopped.agent.turn('loop', go())).toBe('interrupted');
  expect(stopped.model.doStreamCalls).toHaveLength(2); expect(stopper.pauses).toEqual(['cap reached: 2 turns this run · ⏎ allows 2 more · /caps changes it · Esc stops']);
  const raiser = new Harness(stubFacts({ caps: { turns: 2, spendUsd: null } }), [true, false]);
  const raised = await agent(steps(), raiser);
  expect(await raised.agent.turn('loop', go())).toBe('interrupted'); expect(raised.model.doStreamCalls).toHaveLength(4); expect(raiser.pauses).toHaveLength(2);
});

it('the spend cap counts real cost: the next request gets only what is left, and pauses when that is too little', async () => {
  const h = new Harness(stubFacts({ price: { input: 1, output: 1 }, caps: { turns: null, spendUsd: 0.05 } }), [false]);
  const { model, agent: a } = await agent([toolStep('read', { path: '.' }, usage(30_000, 10_000)), toolStep('read', { path: '.' }, usage(5_000, 4_000)), textStep('never')], h);
  expect(await a.turn('go', go())).toBe('interrupted');
  expect(a.limits.spent).toBeCloseTo(0.049, 10);
  // $0.01 left after the first request: the second carries what fits (input and output at $1/M), not 16k.
  expect(model.doStreamCalls).toHaveLength(2); expect(model.doStreamCalls[1]?.maxOutputTokens).toBeLessThan(10_000);
  expect(h.pauses[0]).toBe("cap reached: $0.050 this run · spent $0.049 · what's left fits under 1,000 output tokens · ⏎ allows $0.050 more · Esc stops");
});

it('an unknown price with limits set pauses once per model and run; with no limits it doesn\'t', async () => {
  const h = new Harness(stubFacts({ caps: { turns: null, spendUsd: 1 } }), [true]);
  const { agent: a } = await agent([toolStep('read', { path: '.' }), textStep('ok'), textStep('again')], h);
  expect(await a.turn('go', go())).toBe('done'); expect(await a.turn('more', go())).toBe('done');
  expect(h.pauses).toHaveLength(1); expect(h.pauses[0]).toContain("no price known for m1, so what it spends is not counted in this run's spend cap");
  const free = new Harness(stubFacts());
  expect(await (await agent([textStep('ok')], free)).agent.turn('go', go())).toBe('done'); expect(free.pauses).toEqual([]);
  // A daemon that doesn't answer is a pause too: nothing goes unchecked.
  const silent = new Harness(null); const lost = await agent([textStep('never')], silent);
  expect(await lost.agent.turn('go', go())).toBe('interrupted'); expect(lost.model.doStreamCalls).toHaveLength(0); expect(silent.pauses[0]).toContain("AI Term isn't answering");
});

it('context % is reported per request and the 85% warning shows once per crossing (and not when turned off)', async () => {
  const h = new Harness(stubFacts({ context: 1000 }));
  const { agent: a } = await agent([toolStep('read', { path: '.' }, usage(900, 1)), textStep('a', usage(950, 1)), textStep('b', usage(400, 1)), textStep('c', usage(870, 1))], h);
  await a.turn('one', go()); await a.turn('two', go()); await a.turn('three', go());
  expect(h.statuses.filter(s => s.event === 'context')).toEqual([90, 95, 40, 87].map(percent => ({ event: 'context', percent })));
  expect(h.notes.filter(n => n.tone === 'warn').map(n => n.text)).toEqual(['context 90% · /clear or start fresh', 'context 87% · /clear or start fresh']);
  const off = new Harness(stubFacts({ context: 1000, contextWarning: false }));
  await (await agent([textStep('a', usage(990, 1))], off)).agent.turn('one', go());
  expect(off.notes.some(n => n.tone === 'warn')).toBe(false);
});

it('the kill switch (Ctrl+K) ends the request and a running command at once', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-kill-'))); roots.push(root);
  const statuses: AgentStatus[] = [];
  const reporter: Reporter = { status: async s => { statuses.push(s); }, usage: async () => {}, facts: async () => stubFacts() };
  let out = ''; const screen = new Screen({ write: t => { out += t; }, columns: 100, rows: 40 }, createTheme('graphite'));
  const model = new MockLanguageModelV4({ doStream: [toolStep('bash', { command: 'trap "" TERM; sleep 30' }), textStep('never')] });
  const app = new AgentApp({ screen, permission: 'dontAsk', models: ['m1'], quit: vi.fn(), makeModel: async () => model,
    agent: io => new Agent({ root, permission: 'dontAsk', model, modelId: 'm1', instructions: { text: '', files: [], notes: [] }, reporter, transcript: new Transcript(null, t => t, () => {}), io, redact: t => t, bashEnv: buildBashEnv(process.env), rg: null }) });
  app.start(); app.input('run it\r');
  await vi.waitFor(() => expect(statuses).toContainEqual({ event: 'tool-start', tool: 'bash' }));
  await new Promise(resolve => setTimeout(resolve, 200));
  const killed = Date.now(); app.input('\x0b');
  await vi.waitFor(() => expect(app.running).toBe(false), { timeout: 3000 });
  expect(Date.now() - killed).toBeLessThan(1000);
  expect(out).toContain('killed: the request and 1 running command'); expect(model.doStreamCalls).toHaveLength(1);
});

it('killAllBash ends every running command group with no grace period, even one ignoring SIGTERM', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-kill-'))); roots.push(root);
  const started = Date.now(), run = runBash('trap "" TERM; sleep 30', { cwd: root, env: buildBashEnv(process.env) });
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(killAllBash()).toBe(1);
  expect((await run).signal).toBe('SIGKILL'); expect(Date.now() - started).toBeLessThan(1500);
  expect(killAllBash()).toBe(0);
});

it('/caps shows and changes this run\'s caps only', () => {
  const limits = new RunLimits();
  limits.setCaps({ turns: 100, spendUsd: 5 });
  expect(limits.describe()).toBe('caps: 0/100 turns · $0.000 of $5.00 this run');
  limits.change({ turns: null }); expect(limits.describe()).toBe('caps: 0 turns (no cap) · $0.000 of $5.00 this run');
  // The run's caps win over the defaults the daemon reports.
  expect(limits.check(stubFacts({ price: { input: 1, output: 1 }, caps: { turns: 1, spendUsd: null } }), 10)).toBeNull();
});
