import { redactSecrets } from './redact.js';
import { isTestCommand } from './test-run.js';

// What an add-on run returns. A model's answer arrives between nonce markers and is checked field by field here, on the
// daemon before it is kept and again on the client before it is shown; /bisect's result comes from AI Term itself.
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export interface Finding { file: string; line: number; severity: Severity; title: string; detail: string; fix?: string; reviewer?: 'code' | 'security'; reproduction?: string }
type Explained = { why: string; diagram: string[]; chunks: string[][]; recap: string[] };
export type FindingsKind = 'types' | 'failures' | 'review-deep' | 'security';
export type AddonResult = { kind: 'plan'; title: string; steps: { title: string; prompt: string }[] }
  | { kind: 'prompt'; issues: string[]; diff: string }
  | ({ kind: 'explain' } & Explained)
  | ({ kind: 'teach'; quiz: { question: string; answer: string }[] } & Explained)
  | { kind: 'fix'; reproduced: true; rootCause: string; test: string; fix: string; files: string[] }
  | { kind: 'fix'; reproduced: false; rootCause: string; reason: string }
  | { kind: 'cover'; tests: { file: string; name: string; behavior: string; wouldFailIf: string }[]; gaps: string[] }
  | { kind: 'refactor'; items: { title: string; why: string; files: string[]; risk: 'low' | 'medium' | 'high' }[] }
  | { kind: 'perf'; measured: string; change: string; benchmark: string[]; files: string[] }
  | { kind: FindingsKind; summary: string; findings: Finding[]; dropped: number }
  | { kind: 'bisect'; commit: string; subject: string; author: string; date: string; steps: number; diff: string[] };
// /perf's A/B, run by AI Term on the code before and after the change, back to back on this machine.
// AI Term's answer when /perf's A/B has no sandbox: the popup then accepts a capital Y, like /dev.
export const AB_NO_SANDBOX = 'No sandbox here · Y runs the A/B with your rights';
export type AbView = { state: 'running' } | { state: 'failed'; reason: string } | { state: 'done'; rounds: number; beforeMs: number; afterMs: number; sandbox: boolean };

const object = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const text = (v: unknown, max = 16000): v is string => typeof v === 'string' && v.trim().length > 0 && Buffer.byteLength(v) <= max && !/[\p{C}]/u.test(v.replace(/[\n\t]/g, ''));
const line = (v: unknown, max = 180): v is string => text(v, max) && !v.includes('\n');
const lines = (v: unknown, most: number, max = 180): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= most && v.every(x => line(x, max));
const keys = (p: Record<string, unknown>, ...names: string[]) => Object.keys(p).length === names.length && names.every(name => Object.hasOwn(p, name));
// A repository-relative path a model may name: no absolute path, no way up.
const relPath = (v: unknown): v is string => line(v, 240) && !v.startsWith('/') && !/^[A-Za-z]:/.test(v) && !v.split(/[\\/]/).includes('..');
const paths = (v: unknown, most: number): v is string[] => Array.isArray(v) && v.length <= most && v.every(relPath);
const list = <T>(v: unknown, most: number, each: (x: Record<string, unknown>) => boolean, least = 1): v is T[] => Array.isArray(v) && v.length >= least && v.length <= most && v.every(x => { const o = object(x); return !!o && each(o); });
const SEVERITIES: readonly string[] = ['critical', 'high', 'medium', 'low'];
// A reproduction must stay inside the repository: anything that reaches a host other than this Mac is dropped.
const OUTSIDE = /\b(?:https?|wss?|ftp):\/\/(?!(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/]|$))/i;

function explained(p: Record<string, unknown>): boolean {
  const chunk = (c: unknown): boolean => lines(c, 6) && c.some(s => /^Example:/i.test(s)) && c.some(s => /^You are here:/i.test(s)) && c.some(s => /^Quick check:/i.test(s));
  return line(p.why) && lines(p.diagram, 4) && Array.isArray(p.chunks) && p.chunks.length > 0 && p.chunks.length <= 16 && p.chunks.every(chunk) && lines(p.recap, 3) && p.recap.length === 3;
}
function finding(kind: FindingsKind, f: Record<string, unknown>): boolean {
  const extra = kind === 'types' ? 'fix' : kind === 'review-deep' ? 'reviewer' : kind === 'security' ? 'reproduction' : null;
  return keys(f, 'file', 'line', 'severity', 'title', 'detail', ...extra ? [extra] : []) && relPath(f.file) && Number.isSafeInteger(f.line) && Number(f.line) >= 1 && SEVERITIES.includes(String(f.severity)) && line(f.title) && text(f.detail, 1200)
    && (kind !== 'types' || text(f.fix, 600)) && (kind !== 'review-deep' || f.reviewer === 'code' || f.reviewer === 'security') && (kind !== 'security' || text(f.reproduction, 1600));
}
function findings(kind: FindingsKind, p: Record<string, unknown>, kept: boolean): AddonResult {
  // dropped is AI Term's count, never the model's: only a result the daemon already checked (kept) carries it.
  if (!(kept ? keys(p, 'kind', 'summary', 'findings', 'dropped') && Number.isSafeInteger(p.dropped) && Number(p.dropped) >= 0 : keys(p, 'kind', 'summary', 'findings')) || !line(p.summary, 400) || !list<Finding>(p.findings, 24, f => finding(kind, f), 0)) throw new Error('Add-on result does not match its format');
  const safe = p.findings.filter(f => kind !== 'security' || !OUTSIDE.test(f.reproduction ?? ''));
  return { kind, summary: p.summary, findings: safe, dropped: (typeof p.dropped === 'number' ? p.dropped : 0) + p.findings.length - safe.length };
}

// kept: the daemon's already-checked copy, as the client receives it (it may carry AI Term's own fields).
export function parseAddonResult(source: string, name: string, kept = false): AddonResult {
  if (Buffer.byteLength(source) > 64000) throw new Error('Add-on result is too large');
  const p = object(JSON.parse(redactSecrets(source)) as unknown);
  if (!p || p.kind !== name) throw new Error('Add-on result has the wrong kind');
  const ok = (valid: boolean): AddonResult => { if (!valid) throw new Error('Add-on result does not match its format'); return p as unknown as AddonResult; };
  switch (name) {
    case 'plan': return ok(keys(p, 'kind', 'title', 'steps') && line(p.title, 120) && list(p.steps, 24, s => keys(s, 'title', 'prompt') && line(s.title, 120) && text(s.prompt, 8000)));
    case 'prompt': return ok(keys(p, 'kind', 'issues', 'diff') && Array.isArray(p.issues) && p.issues.length <= 24 && p.issues.every(s => text(s, 600)) && text(p.diff, 24000) && p.diff.startsWith('--- ') && p.diff.includes('\n+++ '));
    case 'explain': return ok(keys(p, 'kind', 'why', 'diagram', 'chunks', 'recap') && explained(p));
    case 'teach': return ok(keys(p, 'kind', 'why', 'diagram', 'chunks', 'recap', 'quiz') && explained(p) && list(p.quiz, 5, q => keys(q, 'question', 'answer') && line(q.question, 300) && line(q.answer, 300)));
    case 'fix': return ok(p.reproduced === true ? keys(p, 'kind', 'reproduced', 'rootCause', 'test', 'fix', 'files') && line(p.rootCause, 300) && line(p.test, 300) && text(p.fix, 600) && paths(p.files, 20)
      : p.reproduced === false && keys(p, 'kind', 'reproduced', 'rootCause', 'reason') && line(p.rootCause, 300) && text(p.reason, 600));
    case 'cover': return ok(keys(p, 'kind', 'tests', 'gaps') && list(p.tests, 24, t => keys(t, 'file', 'name', 'behavior', 'wouldFailIf') && relPath(t.file) && line(t.name, 240) && line(t.behavior, 300) && line(t.wouldFailIf, 300) && t.behavior !== t.wouldFailIf) && Array.isArray(p.gaps) && p.gaps.length <= 12 && p.gaps.every(g => line(g, 300)));
    case 'refactor': return ok(keys(p, 'kind', 'items') && list(p.items, 24, i => keys(i, 'title', 'why', 'files', 'risk') && line(i.title, 120) && line(i.why, 400) && paths(i.files, 12) && ['low', 'medium', 'high'].includes(String(i.risk))));
    // The benchmark runs on the code before and after: argv only, new files only under bench/.
    case 'perf': return ok(keys(p, 'kind', 'measured', 'change', 'benchmark', 'files') && text(p.measured, 600) && text(p.change, 600) && isTestCommand(p.benchmark) && paths(p.files, 5) && p.files.every(f => f.startsWith('bench/')));
    case 'types': case 'failures': case 'review-deep': case 'security': return findings(name, p, kept);
    // Only AI Term writes this one (no model runs), so only a kept copy is accepted.
    case 'bisect': return ok(kept && keys(p, 'kind', 'commit', 'subject', 'author', 'date', 'steps', 'diff') && typeof p.commit === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(p.commit) && line(p.subject, 300) && line(p.author, 200) && line(p.date, 64) && Number.isSafeInteger(p.steps) && Number(p.steps) >= 0 && Array.isArray(p.diff) && p.diff.length <= 400 && p.diff.every(d => typeof d === 'string' && Buffer.byteLength(d) <= 400 && !/[\p{C}]/u.test(d.replace(/\t/g, ''))));
    default: throw new Error('Add-on result has the wrong kind');
  }
}
export function extractAddonResult(source: string, nonce: string, name: string): AddonResult | null {
  const begin = `RESULT_${nonce}_BEGIN`, end = `RESULT_${nonce}_END`, start = source.lastIndexOf(begin), finish = source.indexOf(end, start + begin.length);
  if (start < 0 || finish < 0) return null;
  const body = source.slice(start + begin.length, finish).trim();
  if (body === '(the JSON result goes here)') return null;
  return parseAddonResult(body, name);
}
export function validateAbView(value: unknown): AbView {
  const p = object(value), ms = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (p && keys(p, 'state') && p.state === 'running') return { state: 'running' };
  if (p && keys(p, 'state', 'reason') && p.state === 'failed' && line(p.reason, 300)) return { state: 'failed', reason: p.reason };
  if (p && keys(p, 'state', 'rounds', 'beforeMs', 'afterMs', 'sandbox') && p.state === 'done' && Number.isSafeInteger(p.rounds) && Number(p.rounds) > 0 && ms(p.beforeMs) && ms(p.afterMs) && typeof p.sandbox === 'boolean') return { state: 'done', rounds: Number(p.rounds), beforeMs: Number(p.beforeMs), afterMs: Number(p.afterMs), sandbox: p.sandbox };
  throw new Error('Invalid A/B result');
}
