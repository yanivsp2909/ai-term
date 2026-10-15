import type { KeyProvider } from './protocol.js';
import type { AgentDiff } from './diff.js';
import { cleanNote } from './handoff.js';
import { redactSecrets } from './redact.js';
import { PROVIDER_LABELS } from './providers.js';

// v0.7.4 /review [agent]: one reviewer pass over an agent's diff by a keyed model you pick (D49 asks first). The diff goes
// to that provider with secrets removed; the answer comes back as plain text, one finding per line with its severity.
export const REVIEW_OUTPUT_TOKENS = 3_000, REVIEW_DIFF_CHARS = 120_000, REVIEW_TEXT_BYTES = 24_000, REVIEW_MAX_MODELS = 40;
export interface ReviewModel { keyId: string; provider: KeyProvider; keyLabel: string; last4: string; model: string; priceUsd: { low: number; high: number } }
export interface ReviewPlan { title: string; files: number; added: number; removed: number; cut: boolean; inputTokens: { low: number; high: number }; outputTokens: { low: number; high: number }; models: ReviewModel[]; selected: number; fingerprint: string }
export interface FindingCounts { high: number; medium: number; low: number }
export interface ReviewResult { title: string; model: string; text: string; counts: FindingCounts; inputTokens: number; outputTokens: number; costUsd: number | null }
// On the card: running, the counts of the last review (auto: auto-review did it), or failed.
export type ReviewState = { state: 'running' } | ({ state: 'done'; auto?: true } & FindingCounts) | { state: 'failed' };

// The diff as the reviewer reads it: one header per file, git's own lines (already cleaned of controls by the daemon),
// secrets removed; past REVIEW_DIFF_CHARS it is cut between files and says so.
export function diffForReview(diff: AgentDiff): string {
  const parts: string[] = [];
  let used = 0, shown = 0;
  for (const file of diff.files) {
    const part = [`--- ${file.from ? `${file.from} → ` : ''}${file.path} (${file.status}, +${file.added} −${file.removed})`, ...file.lines, ...(file.cut ? ['(this file is cut here)'] : [])].join('\n');
    if (used + part.length > REVIEW_DIFF_CHARS) break;
    parts.push(part); used += part.length + 1; shown++;
  }
  if (shown < diff.files.length) parts.push(`(the diff is cut here: ${diff.files.length - shown} more file${diff.files.length - shown === 1 ? '' : 's'} not shown)`);
  else if (diff.capped) parts.push('(parts of this diff were too large to show)');
  return redactSecrets(parts.join('\n'));
}
export function reviewPrompt(diffText: string): string {
  return [
    'You are reviewing a change an AI coding agent made in a git worktree. Review only the diff below.',
    'Report real problems: bugs, security issues, data loss, broken error handling, and risky logic without tests. Skip style nits.',
    'Write one finding per line, most severe first, at most 20: start with HIGH:, MEDIUM: or LOW:, then path:line, then one or two sentences.',
    'If nothing is worth fixing, write exactly: No issues found.',
    'Never repeat secrets, keys or tokens.',
    '', '<diff>', diffText, '</diff>',
  ].join('\n');
}
// Lines that start with a severity (after a list mark or bold), counted; other text is ignored.
export function countFindings(text: string): FindingCounts {
  const counts: FindingCounts = { high: 0, medium: 0, low: 0 };
  for (const match of text.matchAll(/^\s*(?:[-*•]|\d+[.)])?\s*\**\s*(HIGH|MEDIUM|LOW)\s*\**\s*:/gim)) counts[(match[1] ?? '').toLowerCase() as keyof FindingCounts]++;
  return counts;
}
// The reviewer's answer as shown: plain text (no escapes or controls), secrets removed, bounded.
export function reviewText(text: string): string {
  let clean = cleanNote(text);
  while (Buffer.byteLength(clean) > REVIEW_TEXT_BYTES) clean = [...clean].slice(0, Math.floor([...clean].length * 0.9)).join('');
  return clean;
}

// eslint-disable-next-line no-control-regex -- refusing controls is the point.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/;
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isMoney = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isRange = (v: unknown, valid: (n: unknown) => boolean): boolean => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 2 && 'low' in v && 'high' in v && valid(v.low) && valid(v.high) && Number(v.low) <= Number(v.high);
const isLabel = (v: unknown, max: number): v is string => typeof v === 'string' && [...v].length <= max && !CONTROL.test(v) && !v.includes('\n');
const record = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const exact = (v: Record<string, unknown>, keys: string[], optional: string[] = []) => keys.every(k => k in v) && Object.keys(v).every(k => keys.includes(k) || optional.includes(k));
const isCounts = (v: unknown): boolean => { const c = record(v); return !!c && exact(c, ['high', 'medium', 'low']) && isCount(c.high) && isCount(c.medium) && isCount(c.low); };
function isReviewModel(v: unknown): v is ReviewModel {
  const m = record(v);
  return !!m && exact(m, ['keyId', 'provider', 'keyLabel', 'last4', 'model', 'priceUsd']) && typeof m.keyId === 'string' && /^[0-9a-f-]{36}$/.test(m.keyId) && typeof m.provider === 'string' && Object.hasOwn(PROVIDER_LABELS, m.provider) && isLabel(m.keyLabel, 80) && isLabel(m.last4, 4) && isLabel(m.model, 200) && !!m.model && isRange(m.priceUsd, isMoney);
}
export function validateReviewPlan(value: unknown): ReviewPlan {
  const p = record(value);
  if (!p || !exact(p, ['title', 'files', 'added', 'removed', 'cut', 'inputTokens', 'outputTokens', 'models', 'selected', 'fingerprint']) || !isLabel(p.title, 60) || !isCount(p.files) || !isCount(p.added) || !isCount(p.removed) || typeof p.cut !== 'boolean'
    || !isRange(p.inputTokens, isCount) || !isRange(p.outputTokens, isCount) || !Array.isArray(p.models) || p.models.length > REVIEW_MAX_MODELS || !p.models.every(isReviewModel) || !isCount(p.selected) || p.models.length && Number(p.selected) >= p.models.length
    || typeof p.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(p.fingerprint)) throw new Error('Invalid review plan');
  return p as unknown as ReviewPlan;
}
export function validateReviewResult(value: unknown): ReviewResult {
  const r = record(value);
  if (!r || !exact(r, ['title', 'model', 'text', 'counts', 'inputTokens', 'outputTokens', 'costUsd']) || !isLabel(r.title, 60) || !isLabel(r.model, 200) || typeof r.text !== 'string' || Buffer.byteLength(r.text) > REVIEW_TEXT_BYTES || CONTROL.test(r.text.replace(/\t/g, ''))
    || !isCounts(r.counts) || !isCount(r.inputTokens) || !isCount(r.outputTokens) || !(r.costUsd === null || isMoney(r.costUsd))) throw new Error('Invalid review');
  return r as unknown as ReviewResult;
}
export function validateReviewState(value: unknown): ReviewState {
  const r = record(value);
  const ok = !!r && ((r.state === 'running' || r.state === 'failed') && exact(r, ['state'])
    || r.state === 'done' && exact(r, ['state', 'high', 'medium', 'low'], ['auto']) && isCount(r.high) && isCount(r.medium) && isCount(r.low) && (r.auto === undefined || r.auto === true));
  if (!ok) throw new Error('Invalid review state');
  return r as unknown as ReviewState;
}
