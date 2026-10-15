import type { AgentCaps, AgentFacts, BudgetRefusal } from '../shared/agent-facts.js';
import type { ModelPrice } from '../shared/protocol.js';
import { estimateCost } from '../daemon/usage-prices.js';

// D49/D53: AI Term's agent checks before every model request (a "turn" here: one request, a reply or a tool round) that it
// stays inside the run's caps and your budgets, using the worst case for that request (estimateTokens for the input, the
// full output allowance). A check it can't make is a pause too.
export const CHARS_PER_TOKEN = 3, TOOL_SCHEMA_TOKENS = 1400, DEFAULT_MAX_OUTPUT = 16_000, MAX_OUTPUT_CAP = 32_000;
// Below this many output tokens a reply isn't useful, so a request that can't get them pauses like any other cap.
export const MIN_USEFUL_OUTPUT = 1000;
// Worst-case input tokens: a third of a token per ASCII character (real tokenizers do better), a whole token for every other
// character, because CJK text and emoji can cost about one each.
export function estimateTokens(text: string): number {
  let ascii = 0, other = 0;
  for (const char of text) { if ((char.codePointAt(0) ?? 0) < 0x80) ascii++; else other++; }
  return Math.ceil(ascii / CHARS_PER_TOKEN) + other;
}
export interface Pause { text: string; onContinue?: () => void }
const usd = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
export const NOT_ANSWERING = "AI Term isn't answering, so budgets and caps can't be checked · ⏎ asks again · Esc stops";
const BUDGET_LABEL = { daily: 'today', weekly: 'this week', monthly: 'this month' } as const;
const held = (reserved: number) => reserved > 0 ? ` · ${usd(reserved)} held by other agents' requests` : '';
// B25: the daemon refused this request's reservation even after a fresh check (another agent took the room).
export function refusalPause(refused: BudgetRefusal): Pause {
  if (refused.budget === 'unavailable') return { text: NOT_ANSWERING };
  return { text: `budget: ${BUDGET_LABEL[refused.budget]} ${usd(refused.spent)} of ${usd(refused.limit)}${held(refused.reserved)} · raise it on the homepage (b), then ⏎ checks again · Esc stops` };
}

export function maxOutputTokens(facts: AgentFacts | null): number { return facts?.output ? Math.min(facts.output, MAX_OUTPUT_CAP) : DEFAULT_MAX_OUTPUT; }
export function worstCase(price: ModelPrice, inputTokens: number, maxOutput: number): number {
  return ((inputTokens + TOOL_SCHEMA_TOKENS) * price.input + maxOutput * price.output) / 1e6;
}
// Exact cost of one request from the provider's own counts, priced as the Usage panel prices it (usage-prices.ts):
// cached input at the cache rate, the rest of input at the input rate, output (reasoning included) at the output rate.
export function requestCost(price: ModelPrice | null, input: number, cached: number, output: number): number | null {
  return estimateCost(price ?? undefined, input, output, Math.min(cached, input));
}

export class RunLimits {
  turns = 0;
  spent = 0;
  reserved = 0;
  private caps: AgentCaps | null = null;
  private base: AgentCaps | null = null;
  private unpriced = new Set<string>();
  // /caps typed before the first request: applied over the daemon's defaults when they arrive.
  private pending: Partial<AgentCaps> = {};
  // Requests sent but never finished (Esc, kill): their worst case, which the daemon never hears about.
  unreported = 0;
  // The worst case of the request the last check let through, and the output allowance it carries (maxOutputTokens).
  lastWorst = 0;
  lastMaxOutput = DEFAULT_MAX_OUTPUT;
  // B25: the daemon holds every agent's in-flight worst case and books cut-off requests itself (facts.reserved, spent), so
  // the budgets no longer add this run's own unreported or reserved amounts; the run's spend cap still does.
  ledger = false;
  get current(): AgentCaps | null { return this.caps; }
  setCaps(caps: AgentCaps): void { const merged = { ...caps, ...this.pending }; this.pending = {}; this.caps = merged; this.base = { ...merged }; }
  chargeUnfinished(worst: number): void { this.spent += worst; this.unreported += worst; }
  // A cost already in spent whose usage AI Term never took: the daemon's budgets don't know it, so checks add it here.
  unconfirmed(cost: number): void { this.unreported += cost; }
  record(cost: number | null): void { if (cost !== null) this.spent += cost; }
  // The first pause that applies before the next request, or null when it may go. A request that may go carries an output
  // allowance (lastMaxOutput) sized so its worst case, input plus that allowance at the output price, fits what is left of
  // the run cap and of every budget, never above the model's own limit. Reasoning is output: the Responses API, Anthropic's
  // max_tokens and Chat Completions all bound it by the same allowance and bill it at the output rate.
  check(facts: AgentFacts | null, inputTokens: number): Pause | null {
    if (!facts) return { text: NOT_ANSWERING };
    if (!this.caps) this.setCaps(facts.caps);
    const caps = this.caps ?? facts.caps, base = this.base ?? facts.caps, modelMax = maxOutputTokens(facts);
    this.lastWorst = 0; this.lastMaxOutput = modelMax;
    if (caps.turns !== null && this.turns >= caps.turns) return { text: `cap reached: ${caps.turns} turns this run · ⏎ allows ${base.turns ?? caps.turns} more · /caps changes it · Esc stops`, onContinue: () => { caps.turns = (caps.turns ?? 0) + (base.turns ?? caps.turns ?? 0); } };
    const limited = caps.spendUsd !== null || facts.budgets.daily !== null || facts.budgets.weekly !== null || facts.budgets.monthly !== null;
    // Unknown price: asked once per model and run; going on still sends the model's own allowance, never no limit.
    if (!facts.price) {
      // A budget is a promise across agents and days: an unpriced model would spend outside it (v0.6 gate), so with any
      // budget set it waits for a price (⏎ checks again). A spend cap alone is this run's, so you may go on without it.
      if (facts.budgets.daily !== null || facts.budgets.weekly !== null || facts.budgets.monthly !== null)
        return { text: `no price known for ${facts.model}, so your budgets can't count it · set its price in /settings (p, or m for a Foundry deployment), then ⏎ checks again · Esc stops` };
      if (!limited || this.unpriced.has(facts.model)) return null;
      return { text: `no price known for ${facts.model}, so what it spends is not counted in this run's spend cap · set its price in /settings (p, or m for a Foundry deployment), or ⏎ goes on for this model this run (at most ${modelMax.toLocaleString('en-US')} output tokens a request) · Esc stops`, onContinue: () => { this.unpriced.add(facts.model); } };
    }
    const price = facts.price, input = worstCase(price, inputTokens, 0), extra = this.ledger ? facts.reserved : this.unreported + this.reserved;
    const rooms: { room: number; pause: () => Pause }[] = [];
    if (caps.spendUsd !== null) rooms.push({ room: caps.spendUsd - this.spent - this.reserved, pause: () => ({ text: `cap reached: ${usd(caps.spendUsd ?? 0)} this run · spent ${usd(this.spent)} · what's left fits under ${MIN_USEFUL_OUTPUT.toLocaleString('en-US')} output tokens · ⏎ allows ${usd(base.spendUsd ?? caps.spendUsd ?? 0)} more · Esc stops`, onContinue: () => { caps.spendUsd = (caps.spendUsd ?? 0) + (base.spendUsd ?? caps.spendUsd ?? 0); } }) });
    for (const [limit, spent, label] of [[facts.budgets.daily, facts.spent.day, 'today'], [facts.budgets.weekly, facts.spent.week, 'this week'], [facts.budgets.monthly, facts.spent.month, 'this month']] as const)
      if (limit !== null) rooms.push({ room: limit - spent - extra, pause: () => ({ text: `budget: ${label} ${usd(spent)} of ${usd(limit)}${this.ledger ? held(facts.reserved) : ''} · what's left fits under ${MIN_USEFUL_OUTPUT.toLocaleString('en-US')} output tokens · raise it on the homepage (b), then ⏎ checks again · Esc stops` }) });
    let allowance = modelMax, binding: (typeof rooms)[number] | null = null;
    for (const limit of rooms) {
      const left = limit.room - input;
      // Floor, so the worst case never passes the room by a fraction of a token; a free output rate fits whatever is left.
      const fits = left < 0 ? -1 : price.output > 0 ? Math.floor(left * 1e6 / price.output) : modelMax;
      if (fits < allowance) { allowance = fits; binding = limit; }
    }
    if (binding && allowance < Math.min(MIN_USEFUL_OUTPUT, modelMax)) return binding.pause();
    this.lastMaxOutput = allowance; this.lastWorst = worstCase(price, inputTokens, allowance);
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
