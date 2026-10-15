import type { AgentEngine, AuthRef, Effort } from './protocol.js';
import { isAgentEngine, isAuthRef, isEffortForEngine, isModel } from './validate.js';

// v0.7.4 /fork [agent] <model>: the same first message on a second model, in its own worktree from the same start commit.
// It spends tokens, so D49 asks first with what runs and an estimate: the source agent's own run so far is the best
// guess there is (half to twice its tokens), priced at the new model's price when it runs on a key.
export interface ForkTarget { engine: AgentEngine; model: string | null; auth: AuthRef; effort?: Effort | null }
export interface ForkPlan { source: string; engine: AgentEngine; model: string | null; authLabel: string; firstMessage: string; base: string; tokens: { low: number; high: number } | null; priceUsd: { low: number; high: number } | null; subscription: boolean }
export const FORK_PREVIEW_CHARS = 300;
export function isForkTarget(value: unknown): value is ForkTarget {
  const t = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  return !!t && Object.keys(t).every(k => ['engine', 'model', 'auth', 'effort'].includes(k)) && isAgentEngine(t.engine) && isModel(t.model) && isAuthRef(t.auth) && (t.effort === undefined || isEffortForEngine(t.engine, t.effort))
    && (t.engine !== 'ai-term' || isAuthRef(t.auth) && t.auth.kind === 'key');
}
// eslint-disable-next-line no-control-regex -- refusing controls is the point.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/;
const isRange = (v: unknown): boolean => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 2 && 'low' in v && 'high' in v && typeof v.low === 'number' && typeof v.high === 'number' && Number.isFinite(v.low) && Number.isFinite(v.high) && v.low >= 0 && v.low <= v.high;
export function validateForkPlan(value: unknown): ForkPlan {
  const p = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const text = (v: unknown, max: number) => typeof v === 'string' && [...v].length <= max && !CONTROL.test(v);
  if (!p || Object.keys(p).length !== 9 || !text(p.source, 60) || !isAgentEngine(p.engine) || !isModel(p.model) || !text(p.authLabel, 120) || !text(p.firstMessage, FORK_PREVIEW_CHARS + 1) || !text(p.base, 120)
    || !(p.tokens === null || isRange(p.tokens)) || !(p.priceUsd === null || isRange(p.priceUsd)) || typeof p.subscription !== 'boolean') throw new Error('Invalid fork plan');
  return p as unknown as ForkPlan;
}

// A fork's name: the source's name plus " fork", at most 60 characters, cut between whole characters (an emoji stays whole).
export function forkTitle(source: string): string { return [...`${source} fork`].slice(0, 60).join(''); }
