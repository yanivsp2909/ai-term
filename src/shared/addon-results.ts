import { redactSecrets } from './redact.js';
import { isTestCommand } from './test-run.js';

// What an add-on run returns. A model's answer arrives between nonce markers and is checked field by field here, on the
// daemon before it is kept and again on the client before it is shown; /bisect's result comes from AI Term itself.
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export interface Finding { file: string; line: number; severity: Severity; title: string; detail: string; fix?: string; reviewer?: 'code' | 'security'; reproduction?: string }
type Explained = { why: string; diagram: string[]; chunks: string[][]; recap: string[] };
export type FindingsKind = 'types' | 'failures' | 'review-deep' | 'security' | 'pr-review' | 'context' | 'opensource' | 'a11y';
// An add-on that changes files in its worktree and says what it did (v1.1 batch 2).
export type MadeKind = 'issue' | 'docs' | 'handover' | 'adr' | 'polish' | 'e2e';
// Batch 3: add-ons that make files you look at. Every file stays under its command's folder in the agent's worktree,
// and only these are opened (o) or saved to Downloads (s), and only when you press the key.
export const OUTPUT_FOLDERS: Readonly<Record<string, string>> = { deck: 'out/deck/', slides: 'out/slides/', design: 'out/design/', video: 'out/video/', diagram: 'docs/diagrams/', research: 'docs/research/' };
// Only file types meant to be looked at (review: macOS opens a .command, .terminal, .webloc or a +x script by running
// it). Anything else is refused in the result and again before o or s.
const PAGES = ['.html', '.svg', '.png', '.pdf', '.md'];
export const OUTPUT_TYPES: Readonly<Record<string, readonly string[]>> = { deck: PAGES, slides: PAGES, design: PAGES, diagram: ['.mmd', '.d2', '.svg', '.png', '.md'], video: ['.mp4', '.webm', '.gif', '.tape', '.tsx', '.ts', '.md'], research: ['.md'] };
const extension = (file: string) => { const name = file.split('/').at(-1) ?? '', dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot).toLowerCase() : ''; };
// The command whose folder holds this file, and whether its type may be opened or saved.
export function viewable(file: string): boolean {
  const kind = Object.keys(OUTPUT_FOLDERS).find(k => file.startsWith(OUTPUT_FOLDERS[k] ?? '\0'));
  return !!kind && (OUTPUT_TYPES[kind] ?? []).includes(extension(file));
}
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
  | { kind: 'bisect'; commit: string; subject: string; author: string; date: string; steps: number; diff: string[] }
  | { kind: MadeKind; summary: string; files: string[] }
  | { kind: 'deps'; summary: string; files: string[]; upgraded: string[]; skipped: string[] }
  | { kind: 'commit'; subject: string; body: string }
  | { kind: 'changelog'; section: string }
  | { kind: 'standup'; lines: string[] }
  | { kind: 'standup-polish'; text: string }
  | { kind: 'deck' | 'slides'; summary: string; files: string[]; todo: string[] }
  | { kind: 'design'; summary: string; files: string[] }
  | { kind: 'diagram'; summary: string; files: string[]; rendered: boolean }
  | { kind: 'video'; summary: string; files: string[]; rendered: boolean; missing: string[] }
  | { kind: 'research'; summary: string; files: string[]; sources: string[] }
  | { kind: 'animate'; verdict: 'animate' | 'skip'; why: string; summary: string; files: string[] }
  | { kind: 'study'; why: string; chunks: string[][]; recap: string[] }
  | { kind: 'study-due'; topics: { topic: string; due: string; step: number }[] }
  // v1.0.7 /reverse: what the target does, each finding with the evidence REA showed, and what couldn't be seen.
  | { kind: 'reverse'; summary: string; findings: { title: string; detail: string; evidence: string }[]; limits: string[] };
// /perf's A/B, run by AI Term on the code before and after the change, back to back on this machine.
// AI Term's answer when /perf's A/B has no sandbox: the popup then accepts a capital Y, like /dev.
export const AB_NO_SANDBOX = 'No sandbox here · Y runs the A/B with your rights';
// Backlog F1: what the popup says after x stopped the A/B.
export const AB_STOPPED = 'you stopped it; its processes ended and its temporary copy was removed';
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
// A reproduction must stay inside the repository. Two rules (security reviews): every scheme://host or //host is parsed as
// a URL and its real host must be loopback (userinfo can't pass for one; file:// leaves the repository); and once a
// reproduction shows any network capability at all (a network tool in any case, socket code, /dev/tcp, git's remote
// commands), every host-like word in it must be loopback, and it must name one. Anything else is dropped, not guessed.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const NETWORK = /\b(?:curl|wget|nc|ncat|netcat|socat|ssh|scp|sftp|rsync|telnet|ftp|nmap|ping|dig|nslookup|openssl|s_client|socket|create_connection|connect|fetch|urlopen|requests|axios|http\.(?:get|request)|git\s+(?:push|fetch|pull|clone|ls-remote|remote))\b|\/dev\/(?:tcp|udp)\//i;
// A dotted name or an IPv4 address, unless it is a file name the repository could hold.
const HOSTISH = /(?:^|[^\w./-])((?:\d{1,3}(?:\.\d{1,3}){3})|(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*)(?=$|[^\w-])/gi;
const FILE_NAME = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|sh|py|rb|go|rs|java|txt|md|yml|yaml|toml|lock|html|css|c|h|cc|cpp)$/i;
function outside(text: string): boolean {
  let loopback = false;
  for (const match of text.matchAll(/([a-z][a-z0-9+.-]*:)?\/\/[^\s'"`<>()]+/gi)) {
    let url: URL; try { url = new URL(match[1] ? match[0] : `http:${match[0]}`); } catch (error) { if (error instanceof TypeError) return true; throw error; }
    if (url.protocol === 'file:' || !LOOPBACK.has(url.hostname)) return true;
    loopback = true;
  }
  if (!NETWORK.test(text)) return false;
  for (const match of text.matchAll(HOSTISH)) { const host = match[1] ?? ''; if (LOOPBACK.has(host)) loopback = true; else if (!FILE_NAME.test(host)) return true; }
  return !loopback && !/\blocalhost\b|\b127\.0\.0\.1\b|\[::1\]/i.test(text);
}

// A source shown as a link names its real host: no user:password@ in front of it (review).
function plainUrl(value: string): boolean { try { const url = new URL(value); return !url.username && !url.password; } catch (error) { if (error instanceof TypeError) return false; throw error; } }
// Made files: a summary, at least one file, every file under the command's own folder.
function made(kind: string, p: Record<string, unknown>): boolean {
  const folder = OUTPUT_FOLDERS[kind] ?? '';
  return text(p.summary, 600) && paths(p.files, 40) && p.files.length > 0 && p.files.every(f => f.startsWith(folder) && f.length > folder.length && (OUTPUT_TYPES[kind] ?? []).includes(extension(f)));
}
function explained(p: Record<string, unknown>): boolean {
  const chunk = (c: unknown): boolean => lines(c, 6) && c.some(s => /^Example:/i.test(s)) && c.some(s => /^You are here:/i.test(s)) && c.some(s => /^Quick check:/i.test(s));
  return line(p.why) && lines(p.diagram, 4) && Array.isArray(p.chunks) && p.chunks.length > 0 && p.chunks.length <= 16 && p.chunks.every(chunk) && lines(p.recap, 3) && p.recap.length === 3;
}
function finding(kind: FindingsKind, f: Record<string, unknown>): boolean {
  // /opensource's fix is optional: only some findings can be fixed by changing files.
  const extra = kind === 'types' || kind === 'context' || kind === 'a11y' || kind === 'opensource' && f.fix !== undefined ? 'fix' : kind === 'review-deep' ? 'reviewer' : kind === 'security' ? 'reproduction' : null;
  return keys(f, 'file', 'line', 'severity', 'title', 'detail', ...extra ? [extra] : []) && relPath(f.file) && Number.isSafeInteger(f.line) && Number(f.line) >= 1 && SEVERITIES.includes(String(f.severity)) && line(f.title) && text(f.detail, 1200)
    && (extra !== 'fix' || text(f.fix, 600)) && (kind !== 'review-deep' || f.reviewer === 'code' || f.reviewer === 'security') && (kind !== 'security' || text(f.reproduction, 1600));
}
function findings(kind: FindingsKind, p: Record<string, unknown>, kept: boolean): AddonResult {
  // dropped is AI Term's count, never the model's: only a result the daemon already checked (kept) carries it.
  if (!(kept ? keys(p, 'kind', 'summary', 'findings', 'dropped') && Number.isSafeInteger(p.dropped) && Number(p.dropped) >= 0 : keys(p, 'kind', 'summary', 'findings')) || !line(p.summary, 400) || !list<Finding>(p.findings, 24, f => finding(kind, f), 0)) throw new Error('Add-on result does not match its format');
  const safe = p.findings.filter(f => kind !== 'security' || !outside(f.reproduction ?? ''));
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
    case 'types': case 'failures': case 'review-deep': case 'security': case 'pr-review': case 'context': case 'opensource': case 'a11y': return findings(name, p, kept);
    case 'deck': case 'slides': return ok(keys(p, 'kind', 'summary', 'files', 'todo') && made(name, p) && Array.isArray(p.todo) && p.todo.length <= 24 && p.todo.every(t => line(t, 300)));
    case 'design': return ok(keys(p, 'kind', 'summary', 'files') && made(name, p));
    // "rendered" must come with the rendering itself among the files (review: a claim alone isn't shown as done).
    case 'diagram': return ok(keys(p, 'kind', 'summary', 'files', 'rendered') && made(name, p) && typeof p.rendered === 'boolean' && (!p.rendered || (p.files as string[]).some(f => ['.svg', '.png'].includes(extension(f)))));
    case 'video': return ok(keys(p, 'kind', 'summary', 'files', 'rendered', 'missing') && made(name, p) && typeof p.rendered === 'boolean' && (!p.rendered || (p.files as string[]).some(f => ['.mp4', '.webm', '.gif'].includes(extension(f)))) && Array.isArray(p.missing) && p.missing.length <= 12 && p.missing.every(m => line(m, 200)));
    // Sources are shown and copied, never opened by AI Term: https or http only (no javascript:, file: or data:).
    case 'research': return ok(keys(p, 'kind', 'summary', 'files', 'sources') && made(name, p) && Array.isArray(p.sources) && p.sources.length <= 40 && p.sources.every(u => line(u, 500) && /^https?:\/\/[^\s/]+/i.test(u) && plainUrl(u)));
    case 'animate': return ok(keys(p, 'kind', 'verdict', 'why', 'summary', 'files') && (p.verdict === 'animate' || p.verdict === 'skip') && line(p.why, 300) && text(p.summary, 600) && paths(p.files, 40) && (p.verdict === 'animate' || p.files.length === 0));
    case 'reverse': return ok(keys(p, 'kind', 'summary', 'findings', 'limits') && text(p.summary, 600) && list(p.findings, 24, f => keys(f, 'title', 'detail', 'evidence') && line(f.title, 120) && text(f.detail, 1200) && text(f.evidence, 1200), 0) && Array.isArray(p.limits) && p.limits.length <= 12 && p.limits.every(l => line(l, 300)));
    case 'study': return ok(keys(p, 'kind', 'why', 'chunks', 'recap') && line(p.why) && Array.isArray(p.chunks) && p.chunks.length > 0 && p.chunks.length <= 16 && p.chunks.every(c => lines(c, 6) && c.some(x => /^Check:/i.test(x))) && lines(p.recap, 3) && p.recap.length === 3);
    // AI Term's own schedule (no model): only a kept copy.
    case 'study-due': return ok(kept && keys(p, 'kind', 'topics') && list(p.topics, 200, t => keys(t, 'topic', 'due', 'step') && line(t.topic, 200) && typeof t.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.due) && Number.isSafeInteger(t.step) && Number(t.step) >= 0, 0));
    case 'issue': case 'docs': case 'handover': case 'adr': case 'polish': case 'e2e': return ok(keys(p, 'kind', 'summary', 'files') && text(p.summary, 600) && paths(p.files, 40));
    case 'deps': return ok(keys(p, 'kind', 'summary', 'files', 'upgraded', 'skipped') && text(p.summary, 600) && paths(p.files, 40) && [p.upgraded, p.skipped].every(l => Array.isArray(l) && l.length <= 40 && l.every(x => line(x, 300))));
    case 'commit': return ok(keys(p, 'kind', 'subject', 'body') && line(p.subject, 120) && typeof p.body === 'string' && (p.body === '' || text(p.body, 4000)));
    case 'changelog': return ok(keys(p, 'kind', 'section') && text(p.section, 8000));
    case 'standup-polish': return ok(keys(p, 'kind', 'text') && text(p.text, 4000));
    // AI Term's own record (no model): only a kept copy.
    case 'standup': return ok(kept && keys(p, 'kind', 'lines') && lines(p.lines, 60, 300));
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
