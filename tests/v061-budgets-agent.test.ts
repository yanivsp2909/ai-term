import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { Agent, type AgentIO } from '../src/agent/agent.js';
import { Transcript } from '../src/agent/transcript.js';
import { buildBashEnv } from '../src/daemon/env.js';
import { BudgetLedger, type Reservation } from '../src/daemon/budget-ledger.js';
import type { BudgetAnswer } from '../src/shared/agent-facts.js';
import type { AgentStatus, Reporter, TokenUsage } from '../src/agent/report.js';
import { stubFacts } from './fixtures/agent-facts.js';

// v0.6.1 (B25), the agent's side: nothing is sent without the daemon's grant, and every grant is settled.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const usage = (input: number, output: number) => ({ inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: output, text: output, reasoning: undefined } });
const noUsage = { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } };
const textStep = (text: string, u: typeof noUsage | ReturnType<typeof usage> = usage(100, 10)) => ({ stream: convertArrayToReadableStream([{ type: 'stream-start' as const, warnings: [] }, { type: 'text-start' as const, id: 't' }, { type: 'text-delta' as const, id: 't', delta: text }, { type: 'text-end' as const, id: 't' }, { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage: u }]) });
const PRICE = { input: 2, output: 10 };

// One daemon: a real ledger and the spend it has recorded, shared by every agent's reporter.
class Daemon {
  spent = 0; booked: Reservation[] = []; settled: { id: string; worstCase: boolean }[] = [];
  ledger = new BudgetLedger({ book: async r => { this.booked.push(r); this.spent += r.amountUsd; }, log: { error() {} } });
  constructor(public limit: number) {}
  facts() { return stubFacts({ price: PRICE, budgets: { daily: this.limit, weekly: null, monthly: null }, spent: { day: this.spent, week: this.spent, month: this.spent }, reserved: this.ledger.reserved() }); }
}
class Harness implements Reporter, AgentIO {
  statuses: AgentStatus[] = []; usages: TokenUsage[] = []; pauses: string[] = [];
  answer: ((text: string) => boolean) = () => false;
  gate?: Promise<void>;
  reserveAnswer?: BudgetAnswer | null;
  constructor(private readonly daemon: Daemon, readonly sessionId: string) {}
  async status(update: AgentStatus) { this.statuses.push(update); }
  async usage(_model: string, tokens: TokenUsage) { this.usages.push(tokens); this.daemon.spent += (tokens.input * PRICE.input + tokens.output * PRICE.output) / 1e6; return true; }
  async facts() { const facts = this.daemon.facts(); await this.gate; return facts; }
  async reserve(model: string, amountUsd: number): Promise<BudgetAnswer | null> {
    if (this.reserveAnswer !== undefined) return this.reserveAnswer;
    const f = this.daemon.facts();
    return this.daemon.ledger.reserve({ sessionId: this.sessionId, provider: 'foundry', model, amountUsd }, f.budgets, f.spent);
  }
  async settle(id: string, worstCase: boolean | Promise<boolean>) { const worst = await worstCase; this.daemon.settled.push({ id, worstCase: worst }); await this.daemon.ledger.settle(this.sessionId, id, worst); }
  text() {} toolStart() {} toolEnd() {} note() {}
  async approve() { return true; }
  async pause(text: string) { this.pauses.push(text); return this.answer(text); }
}
async function agent(steps: NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>['doStream'], harness: Harness) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-b25-'))); roots.push(root);
  const model = new MockLanguageModelV4({ doStream: steps });
  return { model, agent: new Agent({ root, permission: 'dontAsk', model, modelId: 'm1', instructions: { text: '', files: [], notes: [] }, reporter: harness, transcript: new Transcript(null, t => t, () => {}), io: harness, redact: t => t, bashEnv: buildBashEnv(process.env), rg: null }) };
}
const go = () => new AbortController().signal;

it('two agents racing for the last of a budget: exactly one request is sent, the other pauses with the usual ask', async () => {
  // One full request's worst case is about $0.163 here (16k output at $10/M plus input); $0.17 fits exactly one.
  const daemon = new Daemon(0.17), a = new Harness(daemon, crypto.randomUUID()), b = new Harness(daemon, crypto.randomUUID());
  let release = () => {}; const both = new Promise<void>(resolve => { release = resolve; }); let asked = 0;
  for (const h of [a, b]) { h.gate = both; const facts = h.facts.bind(h); h.facts = async () => { if (++asked === 2) release(); return facts(); }; }
  const one = await agent([textStep('A')], a), two = await agent([textStep('B')], b);
  const results = await Promise.all([one.agent.turn('go', go()), two.agent.turn('go', go())]);
  expect(one.model.doStreamCalls.length + two.model.doStreamCalls.length).toBe(1);
  expect([...results].sort()).toEqual(['done', 'interrupted']);
  const paused = a.pauses.length ? a : b;
  expect(paused.pauses).toHaveLength(1);
  expect(paused.pauses[0]).toMatch(/^budget: today \$0\.\d{3} of \$0\.170 · /);
  expect(daemon.ledger.reserved()).toBe(0);
});

it('no grant, no request: a refusal re-checks with fresh facts, and a daemon that does not answer pauses', async () => {
  const daemon = new Daemon(5), quiet = new Harness(daemon, crypto.randomUUID());
  quiet.reserveAnswer = null;
  const q = await agent([textStep('never')], quiet);
  expect(await q.agent.turn('go', go())).toBe('interrupted');
  expect(q.model.doStreamCalls).toHaveLength(0);
  expect(quiet.pauses[0]).toBe("AI Term isn't answering, so budgets and caps can't be checked · ⏎ asks again · Esc stops");
  const refused = new Harness(daemon, crypto.randomUUID());
  refused.reserveAnswer = { refused: { budget: 'daily', spent: 4.9, reserved: 0.05, limit: 5 } };
  const r = await agent([textStep('never')], refused);
  expect(await r.agent.turn('go', go())).toBe('interrupted');
  expect(r.model.doStreamCalls).toHaveLength(0);
  expect(refused.pauses[0]).toBe("budget: today $4.90 of $5.00 · $0.050 held by other agents' requests · raise it on the homepage (b), then ⏎ checks again · Esc stops");
});

it('every grant is settled: released when usage was reported, booked at its worst case when it never will be', async () => {
  const daemon = new Daemon(5), h = new Harness(daemon, crypto.randomUUID());
  const first = await agent([textStep('ok', usage(100, 10))], h);
  expect(await first.agent.turn('go', go())).toBe('done');
  expect(daemon.settled).toEqual([{ id: expect.any(String), worstCase: false }]); expect(daemon.booked).toEqual([]);
  const second = await agent([textStep('ok', noUsage)], h);
  expect(await second.agent.turn('go', go())).toBe('done');
  expect(daemon.settled.at(-1)?.worstCase).toBe(true); expect(daemon.booked).toHaveLength(1);
  // Cut off mid-reply (Esc): the provider may bill it, so it is booked at its worst case too.
  const controller = new AbortController();
  const cut = await agent([{ stream: new ReadableStream({ start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'text-start', id: 't' }); c.enqueue({ type: 'text-delta', id: 't', delta: 'par' }); setTimeout(() => controller.abort(), 5); } }) }], h);
  expect(await cut.agent.turn('go', controller.signal)).toBe('interrupted');
  expect(daemon.settled.at(-1)?.worstCase).toBe(true); expect(daemon.booked).toHaveLength(2);
  expect(daemon.ledger.reserved()).toBe(0);
});
