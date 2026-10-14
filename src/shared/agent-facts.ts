import type { Budgets, ModelPrice } from './protocol.js';
// What AI Term's agent asks the daemon before every model request (POST /v1/agent/ai-term, §12.5): how to reach the model,
// how big its context is, what it costs, what has been spent, and the limits that apply. Exact keys, finite numbers.
export interface AgentCaps { turns: number | null; spendUsd: number | null }
export interface AgentFacts {
  model: string; wire: 'responses' | 'chat' | null; context: number | null; output: number | null; price: ModelPrice | null;
  spent: { day: number; week: number; month: number }; budgets: Budgets; caps: AgentCaps; contextWarning: boolean;
  // B25: USD held right now by every agent's granted, unsettled requests (budget-ledger.ts). Budgets count it as spent.
  reserved: number;
}
// B25: before each request the agent asks POST /v1/agent/ai-term {kind:'budget.reserve', model, amountUsd} (the request's
// worst case) and sends nothing without a grant; after it, {kind:'budget.settle', id, worstCase}. worstCase: no usage will
// arrive for it (cut off, failed after the provider answered, no counts, usage not taken), so it is booked at its worst case.
export interface BudgetRefusal { budget: 'daily' | 'weekly' | 'monthly' | 'unavailable'; spent: number; reserved: number; limit: number }
export type BudgetAnswer = { grant: { id: string } } | { refused: BudgetRefusal };
// D53: a run stops and asks after this many model requests or this much spend unless /settings or /caps says otherwise.
export const DEFAULT_AGENT_CAPS: AgentCaps = { turns: 100, spendUsd: 5 };
export const MAX_CAP_TURNS = 100_000, MAX_CAP_USD = 1_000_000;

const object = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => k in v);
const amount = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
const nullable = (v: unknown, max?: number): v is number | null => v === null || amount(v, max);
export function isAgentCaps(v: unknown): v is AgentCaps {
  const caps = object(v);
  return !!caps && exact(caps, ['turns', 'spendUsd']) && (caps.turns === null || Number.isSafeInteger(caps.turns) && amount(caps.turns, MAX_CAP_TURNS) && caps.turns > 0) && nullable(caps.spendUsd, MAX_CAP_USD) && caps.spendUsd !== 0;
}
export function parseAgentFacts(v: unknown): AgentFacts | null {
  const f = object(v), spent = object(f?.spent), budgets = object(f?.budgets), price = f?.price === null ? null : object(f?.price);
  if (!f || !spent || !budgets || f.price !== null && price === null || !exact(f, ['model', 'wire', 'context', 'output', 'price', 'spent', 'budgets', 'caps', 'contextWarning', 'reserved'])) return null;
  if (typeof f.model !== 'string' || ![null, 'responses', 'chat'].includes(f.wire as string | null) || !nullable(f.context) || !nullable(f.output) || typeof f.contextWarning !== 'boolean' || !amount(f.reserved) || !isAgentCaps(f.caps)) return null;
  if (!exact(spent, ['day', 'week', 'month']) || ![spent.day, spent.week, spent.month].every(n => amount(n)) || !exact(budgets, ['daily', 'weekly', 'monthly']) || ![budgets.daily, budgets.weekly, budgets.monthly].every(n => nullable(n))) return null;
  if (price && (!amount(price.input) || !amount(price.output) || price.cacheRead !== undefined && !amount(price.cacheRead) || Object.keys(price).some(k => !['input', 'output', 'cacheRead'].includes(k)))) return null;
  return f as unknown as AgentFacts;
}
const BUDGETS = ['daily', 'weekly', 'monthly', 'unavailable'];
export function parseBudgetAnswer(v: unknown): BudgetAnswer | null {
  const answer = object(v);
  if (!answer || Object.keys(answer).length !== 1) return null;
  const grant = object(answer.grant), refused = object(answer.refused);
  if (grant) return exact(grant, ['id']) && typeof grant.id === 'string' && /^[0-9a-f-]{36}$/.test(grant.id) ? { grant: { id: grant.id } } : null;
  if (refused && exact(refused, ['budget', 'spent', 'reserved', 'limit']) && BUDGETS.includes(refused.budget as string) && amount(refused.spent) && amount(refused.reserved) && amount(refused.limit)) return { refused: refused as unknown as BudgetRefusal };
  return null;
}
