import type { ClaudeStatusEvent } from '../shared/protocol.js';
import { isToolName, isValidModelId } from '../shared/validate.js';
import { capReply } from '../shared/last-reply.js';

// Bodies AI Term's own agent posts to /v1/status/ai-term (src/agent/report.ts). They map onto the reducer events Claude's
// hooks produce, so cards, notifications, toolsInFlight and the /send gate (D50) treat both alike. Exact keys only.
const FAILURES = new Set(['rate_limit', 'overloaded', 'authentication_failed', 'billing_error', 'invalid_request', 'server_error', 'unknown']);
export interface AgentUpdate { event?: ClaudeStatusEvent; reply?: string; model?: string }
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));

export function parseAgentStatus(raw: unknown, seq: number, at: string): AgentUpdate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>, base = { seq, at };
  switch (value.event) {
    case 'turn-start': return only(value, ['event']) ? { event: { ...base, kind: 'running', phase: 'turn-start' } } : null;
    case 'tool-start': case 'tool-finish':
      return only(value, ['event', 'tool']) && isToolName(value.tool) ? { event: { ...base, kind: 'running', phase: value.event, tool: value.tool } } : null;
    case 'permission': return only(value, ['event']) ? { event: { ...base, kind: 'waiting', reason: 'permission' } } : null;
    // A cap or budget pause: the agent asks whether to go on, shown like a question.
    case 'paused': return only(value, ['event']) ? { event: { ...base, kind: 'waiting', reason: 'question' } } : null;
    // The approval was answered: running again, the tool still in flight.
    case 'answered': return only(value, ['event']) ? { event: { ...base, kind: 'running' } } : null;
    case 'done': return only(value, ['event', 'reply']) && typeof value.reply === 'string' ? { event: { ...base, kind: 'done' }, reply: capReply(value.reply) } : null;
    case 'turn-failed': return only(value, ['event', 'error']) && typeof value.error === 'string' ? { event: { ...base, kind: 'waiting', reason: 'turn failed', error: FAILURES.has(value.error) ? value.error : 'unknown' } } : null;
    // null: unknown again (a model switch); the card drops its old percentage.
    case 'context': return only(value, ['event', 'percent']) && (value.percent === null || typeof value.percent === 'number' && Number.isFinite(value.percent) && value.percent >= 0 && value.percent <= 100) ? { event: { ...base, kind: 'context', percent: value.percent } } : null;
    case 'model': return only(value, ['event', 'model']) && typeof value.model === 'string' && isValidModelId(value.model) ? { model: value.model } : null;
    default: return null;
  }
}
