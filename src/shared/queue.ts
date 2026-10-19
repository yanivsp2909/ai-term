import type { AgentEngine, AuthRef, Effort, Permission, TaskUsage } from './protocol.js';
import type { AgentCaps } from './agent-facts.js';
import { ValidationError, isAgentEngine, isAuthRef, isEffortForEngine, isFirstMessage, isModel, isPermissionForEngine, isSafeAbsolutePath, isTitle, isUUID } from './validate.js';
import { engineTitle } from './models.js';

// v0.9.1 queue (D55, off by default): an agent set up in the start box waits here and starts like a manual start when its
// trigger fires: after a named agent finishes, or at a local time. Nothing waits without a limit: AI Term's agent a turn
// cap and a $ budget, a CLI on a key a $ budget, a CLI on your subscription a stop time.
export type QueueTrigger = { kind: 'after'; agent: string } | { kind: 'at'; time: string; due?: string };
export interface QueueLimit { usd?: number; turns?: number; until?: string }
export interface QueueRequest { engine: AgentEngine; model: string | null; auth: AuthRef; cwd: string; permission: Permission; effort: Effort | null; firstMessage?: string; useWorktree?: boolean; brain?: boolean }
// waiting: not yet; started: its agent runs (sessionId); failed: the start or its trigger failed (note says why, never
// retried); missed: its time passed while AI Term wasn't running, so it never starts by itself.
export type QueueState = 'waiting' | 'started' | 'failed' | 'missed';
export interface QueueItem { id: string; createdAt: string; trigger: QueueTrigger; limit: QueueLimit; request: QueueRequest; state: QueueState; sessionId?: string; note?: string }
export const MAX_QUEUE_ITEMS = 20, MAX_QUEUE_USD = 1000, MAX_QUEUE_TURNS = 1000;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
export function isQueueTime(value: unknown): value is string { return typeof value === 'string' && TIME.test(value); }
// Which limits an agent needs before it may wait.
export function limitFields(engine: AgentEngine, auth: AuthRef['kind']): readonly ('usd' | 'turns' | 'until')[] {
  return engine === 'ai-term' ? ['turns', 'usd'] : auth === 'key' ? ['usd'] : ['until'];
}
// The next local time it is HH:MM (today if still ahead, else tomorrow).
export function nextLocalTime(time: string, now: Date): Date {
  const match = time.match(TIME); if (!match) throw new ValidationError('Use a 24-hour time like 21:30');
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(match[1]), Number(match[2]), 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}
export function stopDelayMs(time: string, now: Date): number { return nextLocalTime(time, now).getTime() - now.getTime(); }
// A stop time comes within 12 hours after the start (review: `at 21:30 until 21:00` would otherwise run 23½ hours).
export const MAX_RUN_MS = 12 * 60 * 60_000;
export function untilWithin(start: string, until: string): boolean {
  const minutes = (time: string) => { const match = time.match(TIME); return match ? Number(match[1]) * 60 + Number(match[2]) : NaN; };
  const span = ((minutes(until) - minutes(start)) % 1440 + 1440) % 1440;
  return span > 0 && span * 60_000 <= MAX_RUN_MS;
}
// AI Term's agent: the item's turns and $ are this run's caps.
// A key CLI request that AI Term runs on its own agent (keys run on AI Term's agent by default) keeps its $ as the run's
// cap (review: it was dropped).
export function limitCaps(limit: QueueLimit, defaults: AgentCaps): AgentCaps {
  return { turns: limit.turns ?? defaults.turns, spendUsd: limit.usd ?? defaults.spendUsd };
}
// A key CLI past its $, or with spend AI Term can't price (it can't be held to a budget it can't count).
// A tokens-only report (costUsd null, price known) is not yet priced: only a spend marked unpriceable stops it at once.
export function overLimit(limit: QueueLimit, usage: TaskUsage | undefined): boolean {
  if (limit.usd === undefined || !usage) return false;
  return usage.unknownPrice === true || usage.costUsd !== null && usage.costUsd >= limit.usd;
}
function validateLimit(value: unknown, request: QueueRequest): QueueLimit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Invalid queue limit');
  const v = value as Record<string, unknown>, needed = limitFields(request.engine, request.auth.kind);
  if (Object.keys(v).some(key => !needed.includes(key as 'usd')) || needed.some(key => v[key] === undefined)) throw new ValidationError(request.engine === 'ai-term' ? "AI Term's agent needs a turn cap and a $ budget" : request.auth.kind === 'key' ? 'An agent on a key needs a $ budget' : 'An agent on your subscription needs a stop time');
  if (v.usd !== undefined && (typeof v.usd !== 'number' || !Number.isFinite(v.usd) || v.usd <= 0 || v.usd > MAX_QUEUE_USD)) throw new ValidationError(`Use a $ budget above 0 and up to ${MAX_QUEUE_USD}`);
  if (v.turns !== undefined && (!Number.isSafeInteger(v.turns) || Number(v.turns) < 1 || Number(v.turns) > MAX_QUEUE_TURNS)) throw new ValidationError(`Use a turn cap from 1 to ${MAX_QUEUE_TURNS}`);
  if (v.until !== undefined && !isQueueTime(v.until)) throw new ValidationError('Use a 24-hour stop time like 23:00');
  return { ...v.usd !== undefined ? { usd: Number(v.usd) } : {}, ...v.turns !== undefined ? { turns: Number(v.turns) } : {}, ...v.until !== undefined ? { until: String(v.until) } : {} };
}
export function validateQueueTrigger(value: unknown): QueueTrigger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Invalid queue trigger');
  const v = value as Record<string, unknown>;
  if (v.kind === 'after' && Object.keys(v).every(key => key === 'kind' || key === 'agent') && isTitle(v.agent)) return { kind: 'after', agent: v.agent };
  if (v.kind === 'at' && Object.keys(v).every(key => ['kind', 'time', 'due'].includes(key)) && isQueueTime(v.time) && (v.due === undefined || typeof v.due === 'string' && !Number.isNaN(Date.parse(v.due)))) return { kind: 'at', time: v.time, ...v.due !== undefined ? { due: String(v.due) } : {} };
  throw new ValidationError('Start after an agent by name, or at a 24-hour time like 21:30');
}
export function validateQueueRequest(value: unknown): QueueRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Invalid queued agent');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !['engine', 'model', 'auth', 'cwd', 'permission', 'effort', 'firstMessage', 'useWorktree', 'brain'].includes(key))) throw new ValidationError('Invalid queued agent');
  if (!isAgentEngine(v.engine) || !isModel(v.model) || !isAuthRef(v.auth) || !isSafeAbsolutePath(v.cwd) || !isPermissionForEngine(v.engine, v.permission) || !(v.effort === null || isEffortForEngine(v.engine, v.effort))
    || v.firstMessage !== undefined && !isFirstMessage(v.firstMessage) || v.brain !== undefined && typeof v.brain !== 'boolean' || v.useWorktree !== undefined && typeof v.useWorktree !== 'boolean') throw new ValidationError('Invalid queued agent');
  if (v.engine === 'ai-term' && v.auth.kind !== 'key') throw new ValidationError('AI Term agent needs an API key');
  return { engine: v.engine, model: v.model, auth: v.auth, cwd: v.cwd, permission: v.permission, effort: v.effort as Effort | null, ...v.firstMessage !== undefined ? { firstMessage: v.firstMessage } : {}, ...v.brain !== undefined ? { brain: v.brain } : {}, ...v.useWorktree !== undefined ? { useWorktree: v.useWorktree } : {} };
}
// What queue.add carries (the daemon adds id, time and state).
export function validateQueueAdd(value: Record<string, unknown>): { trigger: QueueTrigger; limit: QueueLimit; request: QueueRequest } {
  const request = validateQueueRequest(value.request);
  const trigger = validateQueueTrigger(value.trigger);
  if (trigger.kind === 'at' && trigger.due !== undefined) throw new ValidationError('Invalid queue trigger');
  return { trigger, limit: validateLimit(value.limit, request), request };
}
const NOTE = /^[^\p{C}]{1,200}$/u;
export function validateQueueItem(value: unknown): QueueItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Invalid queue item');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !['id', 'createdAt', 'trigger', 'limit', 'request', 'state', 'sessionId', 'note'].includes(key)) || !isUUID(v.id) || typeof v.createdAt !== 'string'
    || !['waiting', 'started', 'failed', 'missed'].includes(String(v.state)) || v.sessionId !== undefined && !isUUID(v.sessionId) || v.note !== undefined && !(typeof v.note === 'string' && NOTE.test(v.note))) throw new ValidationError('Invalid queue item');
  const request = validateQueueRequest(v.request);
  return { id: v.id, createdAt: v.createdAt, trigger: validateQueueTrigger(v.trigger), limit: validateLimit(v.limit, request), request, state: v.state as QueueState, ...v.sessionId !== undefined ? { sessionId: String(v.sessionId) } : {}, ...v.note !== undefined ? { note: String(v.note) } : {} };
}
// Backlog F6: queued items AI Term couldn't read at start, kept aside in AI Term's folder under this file name.
export interface QueueUnreadable { items: number | null; file: string }
export function validateQueueUnreadable(value: unknown): QueueUnreadable | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Invalid queue note');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => key !== 'items' && key !== 'file') || !(v.items === null || typeof v.items === 'number' && Number.isSafeInteger(v.items) && v.items >= 0 && v.items <= 10_000)
    || typeof v.file !== 'string' || !/^queue\.json\.unreadable-\d{1,16}$/.test(v.file)) throw new ValidationError('Invalid queue note');
  return { items: v.items as number | null, file: v.file };
}
export function validateQueue(value: unknown): QueueItem[] {
  if (!Array.isArray(value) || value.length > MAX_QUEUE_ITEMS) throw new ValidationError('Invalid queue');
  return value.map(validateQueueItem);
}
// The /queue popup's rows: trigger · limit · engine · folder · mode · state. Don't ask and failures in red.
export function queueLines(items: readonly QueueItem[]): { text: string; tone: 'ink-2' | 'status-error' | 'ink-3' }[] {
  return items.map(item => {
    const trigger = item.trigger.kind === 'after' ? `after ${item.trigger.agent}` : `at ${item.trigger.time}`;
    const limit = [item.limit.turns !== undefined ? `${item.limit.turns} turns` : '', item.limit.usd !== undefined ? `up to $${item.limit.usd.toFixed(2)}` : '', item.limit.until ? `stops at ${item.limit.until}` : ''].filter(Boolean).join(' · ');
    const mode = item.request.permission === 'dontAsk' ? "! don't ask" : item.request.permission;
    const state = item.state === 'failed' ? `✗ ${item.note ?? 'failed'}` : item.state === 'missed' ? `missed · ${item.note ?? "AI Term wasn't running"}` : item.state === 'started' ? '▶ started' : 'waiting';
    const tone = item.state === 'failed' || item.request.permission === 'dontAsk' ? 'status-error' : item.state === 'waiting' ? 'ink-2' : 'ink-3';
    return { text: `${trigger} · ${limit} · ${engineTitle(item.request.engine)} · ${item.request.cwd} · ${mode} · ${state}`, tone };
  });
}
