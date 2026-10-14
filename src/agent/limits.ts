import type { AgentCaps, AgentFacts } from '../shared/agent-facts.js';
import type { ModelPrice } from '../shared/protocol.js';
import { estimateCost } from '../daemon/usage-prices.js';

// D49/D53: AI Term's agent checks before every model request (a "turn" here: one request, a reply or a tool round) that it
// stays inside the run's caps and your budgets, using the worst case for that request: every input character counted as a
// third of a token (more than real tokenizers produce) and the full output allowance. A check it can't make is a pause too.
export const CHARS_PER_TOKEN = 3, TOOL_SCHEMA_CHARS = 4000, DEFAULT_MAX_OUTPUT = 16_000, MAX_OUTPUT_CAP = 32_000;
export interface Pause { text: string; onContinue?: () => void }
const usd = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

export function maxOutputTokens(facts: AgentFacts | null): number { return facts?.output ? Math.min(facts.output, MAX_OUTPUT_CAP) : DEFAULT_MAX_OUTPUT; }
export function worstCase(price: ModelPrice, inputChars: number, maxOutput: number): number {
  return (Math.ceil((inputChars + TOOL_SCHEMA_CHARS) / CHARS_PER_TOKEN) * price.input + maxOutput * price.output) / 1e6;
}
// Exact cost of one request from the provider's own counts, priced as the Usage panel prices it (usage-prices.ts):
// cached input at the cache rate, the rest of input at the input rate, output (reasoning included) at the output rate.
export function requestCost(price: ModelPrice | null, input: number, cached: number, output: number): number | null {
  return estimateCost(price ?? undefined, input, output, Math.min(cached, input));
}

export class RunLimits {
  turns = 0;
  spent = 0;
  private caps: AgentCaps | null = null;
  private base: AgentCaps | null = null;
  private unpriced = new Set<string>();
  get current(): AgentCaps | null { return this.caps; }
  setCaps(caps: AgentCaps): void { this.caps = { ...caps }; this.base = { ...caps }; }
  record(cost: number | null): void { if (cost !== null) this.spent += cost; }
  // The first pause that applies before the next request, or null when it may go.
  check(facts: AgentFacts | null, inputChars: number): Pause | null {
    if (!facts) return { text: "AI Term isn't answering, so budgets and caps can't be checked · ⏎ asks again · Esc stops" };
    if (!this.caps) this.setCaps(facts.caps);
    const caps = this.caps ?? facts.caps, base = this.base ?? facts.caps;
    if (caps.turns !== null && this.turns >= caps.turns) return { text: `cap reached: ${caps.turns} turns this run · ⏎ allows ${base.turns ?? caps.turns} more · /caps changes it · Esc stops`, onContinue: () => { caps.turns = (caps.turns ?? 0) + (base.turns ?? caps.turns ?? 0); } };
    const limited = caps.spendUsd !== null || facts.budgets.daily !== null || facts.budgets.weekly !== null || facts.budgets.monthly !== null;
    if (!facts.price) {
      if (!limited || this.unpriced.has(facts.model)) return null;
      return { text: `no price known for ${facts.model}, so spend limits can't be checked · mark the deployment's model in /settings, or ⏎ goes on without them for this model this run · Esc stops`, onContinue: () => { this.unpriced.add(facts.model); } };
    }
    const next = worstCase(facts.price, inputChars, maxOutputTokens(facts));
    if (caps.spendUsd !== null && this.spent + next > caps.spendUsd) return { text: `cap reached: ${usd(caps.spendUsd)} this run · spent ${usd(this.spent)} · the next request could cost up to ${usd(next)} · ⏎ allows ${usd(base.spendUsd ?? caps.spendUsd)} more · Esc stops`, onContinue: () => { caps.spendUsd = (caps.spendUsd ?? 0) + (base.spendUsd ?? caps.spendUsd ?? 0); } };
    for (const [limit, spent, label] of [[facts.budgets.daily, facts.spent.day, 'today'], [facts.budgets.weekly, facts.spent.week, 'this week'], [facts.budgets.monthly, facts.spent.month, 'this month']] as const)
      if (limit !== null && spent + next > limit) return { text: `budget: ${label} ${usd(spent)} of ${usd(limit)} · the next request could cost up to ${usd(next)} · raise it on the homepage (b), then ⏎ checks again · Esc stops` };
    return null;
  }
  // /caps: change this run's caps; null turns a cap off.
  change(next: Partial<AgentCaps>): AgentCaps { const caps = { ...(this.caps ?? { turns: null, spendUsd: null }), ...next }; this.caps = caps; this.base = { ...caps }; return caps; }
  describe(): string {
    const caps = this.caps;
    return caps ? `caps: ${this.turns}${caps.turns === null ? ' turns (no cap)' : `/${caps.turns} turns`} · ${usd(this.spent)}${caps.spendUsd === null ? ' (no spend cap)' : ` of ${usd(caps.spendUsd)}`} this run` : 'caps: set at the first request';
  }
}
