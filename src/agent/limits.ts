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
  // /caps typed before the first request: applied over the daemon's defaults when they arrive.
  private pending: Partial<AgentCaps> = {};
  // Requests sent but never finished (Esc, kill): their worst case, which the daemon never hears about.
  unreported = 0;
  // The worst case of the request the last check let through.
  lastWorst = 0;
  get current(): AgentCaps | null { return this.caps; }
  setCaps(caps: AgentCaps): void { const merged = { ...caps, ...this.pending }; this.pending = {}; this.caps = merged; this.base = { ...merged }; }
  chargeUnfinished(worst: number): void { this.spent += worst; this.unreported += worst; }
  record(cost: number | null): void { if (cost !== null) this.spent += cost; }
  // The first pause that applies before the next request, or null when it may go.
  check(facts: AgentFacts | null, inputChars: number): Pause | null {
    if (!facts) return { text: "AI Term isn't answering, so budgets and caps can't be checked · ⏎ asks again · Esc stops" };
    if (!this.caps) this.setCaps(facts.caps);
    const caps = this.caps ?? facts.caps, base = this.base ?? facts.caps;
    this.lastWorst = 0;
    if (caps.turns !== null && this.turns >= caps.turns) return { text: `cap reached: ${caps.turns} turns this run · ⏎ allows ${base.turns ?? caps.turns} more · /caps changes it · Esc stops`, onContinue: () => { caps.turns = (caps.turns ?? 0) + (base.turns ?? caps.turns ?? 0); } };
    const limited = caps.spendUsd !== null || facts.budgets.daily !== null || facts.budgets.weekly !== null || facts.budgets.monthly !== null;
    if (!facts.price) {
      if (!limited || this.unpriced.has(facts.model)) return null;
      return { text: `no price known for ${facts.model}, so spend limits can't be checked · mark the deployment's model in /settings, or ⏎ goes on without them for this model this run · Esc stops`, onContinue: () => { this.unpriced.add(facts.model); } };
    }
    const next = worstCase(facts.price, inputChars, maxOutputTokens(facts)), extra = this.unreported;
    if (caps.spendUsd !== null && this.spent + next > caps.spendUsd) return { text: `cap reached: ${usd(caps.spendUsd)} this run · spent ${usd(this.spent)} · the next request could cost up to ${usd(next)} · ⏎ allows ${usd(base.spendUsd ?? caps.spendUsd)} more · Esc stops`, onContinue: () => { caps.spendUsd = (caps.spendUsd ?? 0) + (base.spendUsd ?? caps.spendUsd ?? 0); } };
    for (const [limit, spent, label] of [[facts.budgets.daily, facts.spent.day, 'today'], [facts.budgets.weekly, facts.spent.week, 'this week'], [facts.budgets.monthly, facts.spent.month, 'this month']] as const)
      if (limit !== null && spent + extra + next > limit) return { text: `budget: ${label} ${usd(spent)} of ${usd(limit)} · the next request could cost up to ${usd(next)} · raise it on the homepage (b), then ⏎ checks again · Esc stops` };
    this.lastWorst = next;
    return null;
  }
  // /caps: change this run's caps; null turns a cap off.
  change(next: Partial<AgentCaps>): void { if (!this.caps) { this.pending = { ...this.pending, ...next }; return; } const caps = { ...this.caps, ...next }; this.caps = caps; this.base = { ...caps }; }
  describe(): string {
    const caps = this.caps;
    if (!caps) return `caps: set at the first request${Object.keys(this.pending).length ? ` (yours: ${this.pending.turns === undefined ? '' : this.pending.turns === null ? 'no turn cap ' : `${this.pending.turns} turns `}${this.pending.spendUsd === undefined ? '' : this.pending.spendUsd === null ? 'no spend cap' : usd(this.pending.spendUsd)})`.replace(' )', ')') : ''}`;
    return caps ? `caps: ${this.turns}${caps.turns === null ? ' turns (no cap)' : `/${caps.turns} turns`} · ${usd(this.spent)}${caps.spendUsd === null ? ' (no spend cap)' : ` of ${usd(caps.spendUsd)}`} this run` : 'caps: set at the first request';
  }
}
