import { stripVTControlCharacters } from 'node:util';
import type { CliEngine, KeyProvider } from './protocol.js';

// v0.6.3 engine handoff (D55, off by default: it spends tokens). An agent's screen text becomes a short summary that a new
// agent of another engine starts from, in the same worktree. The summary is written by the cheapest keyed model AI Term
// knows a price for, or, with no key, by the agent itself (D49 asks first either way).
export const HANDOFF_SECTIONS = ['Goal', 'Done', 'Left', 'Files touched', 'Open questions'] as const;
// The tail of the agent's screen and scrollback that goes into the summary; older text is cut first.
export const HANDOFF_SOURCE_CHARS = 48_000;
// The summary becomes the new agent's first message, so it stays well under the 16 KiB first-message limit.
export const HANDOFF_SUMMARY_BYTES = 12_000;
export const HANDOFF_OUTPUT_TOKENS = 2_000;
export const HANDOFF_ENGINES: readonly CliEngine[] = ['claude-code', 'codex'];
export type HandoffWriter = { kind: 'key'; provider: KeyProvider; model: string; keyLabel: string; last4: string } | { kind: 'agent' };
// What /handoff shows before anything runs (D49): who writes the summary, a token range and a price range (null when the
// writer is the agent itself on a subscription or no price is known; then "uses your plan's limits" or "price ?").
export interface HandoffPlan { source: string; engine: CliEngine; writer: HandoffWriter; inputTokens: { low: number; high: number }; outputTokens: { low: number; high: number }; priceUsd: { low: number; high: number } | null; subscription: boolean }
export function handoffInstructions(target: CliEngine): string {
  return `You are handing this work over to ${target === 'codex' ? 'Codex' : 'Claude Code'}, which starts fresh in the same folder and git worktree and sees nothing of this conversation. Write a handoff note with exactly these sections, short and concrete: ${HANDOFF_SECTIONS.map(s => `## ${s}`).join(', ')}. Name real files and commands. Do not include secrets, keys or tokens.`;
}
export function handoffPrompt(target: CliEngine, screen: string): string {
  const tail = screen.length > HANDOFF_SOURCE_CHARS ? screen.slice(screen.length - HANDOFF_SOURCE_CHARS) : screen;
  return `${handoffInstructions(target)}\n\nThe agent's terminal, most recent last:\n<terminal>\n${tail}\n</terminal>`;
}
// The note goes into the new CLI's argv: no escapes, C0/C1 controls, bidi overrides, BOM or line/paragraph separators,
// only text, new lines and tabs (whatever wrote it: a provider, or the agent's own last reply). ZWJ, ZWNJ, emoji tag
// characters and LRM/RLM stay: emoji sequences and Persian, Arabic and Indic text need them.
export function cleanNote(text: string): string {
  // eslint-disable-next-line no-control-regex -- removing terminal controls is the point.
  return stripVTControlCharacters(text).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u061c\ufeff\u2028\u2029]/g, '').trim();
}
// The new agent's first message: the cleaned note, cut on a character boundary to fit, under a fixed header.
export function handoffMessage(from: string, summary: string): string {
  const header = `Handoff from ${from}. Continue this work in this folder; check the state yourself before changing anything.\n\n`;
  let body = cleanNote(summary);
  while (Buffer.byteLength(header + body) > HANDOFF_SUMMARY_BYTES) body = [...body].slice(0, Math.floor([...body].length * 0.9)).join('');
  return header + body;
}
// What the client accepts from the daemon: exact keys, finite numbers, the fixed writer shapes.
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isRange = (v: unknown): v is { low: number; high: number } => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 2 && 'low' in v && 'high' in v && isCount(v.low) && isCount(v.high) && v.low <= v.high;
export function isHandoffWriter(value: unknown): value is HandoffWriter {
  const w = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  return !!w && (w.kind === 'agent' && Object.keys(w).length === 1 || w.kind === 'key' && Object.keys(w).length === 5 && ['anthropic', 'openai', 'foundry'].includes(String(w.provider)) && typeof w.model === 'string' && w.model.length <= 80 && typeof w.keyLabel === 'string' && w.keyLabel.length <= 80 && typeof w.last4 === 'string' && w.last4.length <= 4);
}
export function validateHandoffPlan(value: unknown): HandoffPlan {
  const p = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const writerOk = isHandoffWriter(p?.writer);
  if (!p || Object.keys(p).length !== 7 || typeof p.source !== 'string' || p.source.length > 60 || !HANDOFF_ENGINES.includes(p.engine as CliEngine) || !writerOk || !isRange(p.inputTokens) || !isRange(p.outputTokens) || !(p.priceUsd === null || isRange(p.priceUsd)) || typeof p.subscription !== 'boolean') throw new Error('Invalid handoff plan');
  return p as unknown as HandoffPlan;
}
export interface HandoffSummary { inputTokens: number; outputTokens: number; costUsd: number | null }
export function validateHandoffSummary(value: unknown): HandoffSummary | null {
  if (value === null || value === undefined) return null;
  const s = typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!s || Object.keys(s).length !== 3 || !isCount(s.inputTokens) || !isCount(s.outputTokens) || !(s.costUsd === null || isCount(s.costUsd))) throw new Error('Invalid handoff summary');
  return s as unknown as HandoffSummary;
}
