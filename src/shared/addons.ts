import type { AgentEngine, AuthRef } from './protocol.js';
import { isAgentEngine, isAuthRef, isModel, isUUID, isSafeAbsolutePath } from './validate.js';
import { redactSecrets } from './redact.js';

export interface AddonTarget { engine: AgentEngine; model: string | null; auth: AuthRef }
export interface Addon {
  name: string; summary: string; args: string; defaultEngine: AgentEngine; engines: AgentEngine[];
  skills: string[]; agents: string[]; brain: 'none' | 'recommended' | 'required'; worktree: boolean; readOnly: boolean; prompt: string;
}
export interface AddonAsk {
  receipt: string; name: string; summary: string; cwd: string; target: AddonTarget;
  brain: 'none' | 'stale' | 'fresh'; brainNeed: Addon['brain']; worktree: boolean; readOnly: boolean; files: string[];
  inputTokens: { low: number; high: number }; outputTokens: { low: number; high: number };
  priceUsd: { low: number; high: number } | null; subscription: boolean;
}
export type AddonResult = { kind: 'plan'; title: string; steps: { title: string; prompt: string }[] }
  | { kind: 'prompt'; issues: string[]; diff: string }
  | { kind: 'explain'; why: string; diagram: string[]; chunks: string[][]; recap: string[] };
const object = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
export const addonName = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(v);
const text = (v: unknown, max = 16000): v is string => typeof v === 'string' && v.trim().length > 0 && Buffer.byteLength(v) <= max && !/[\p{C}]/u.test(v.replace(/[\n\t]/g, ''));
export function isAddonTarget(v: unknown): v is AddonTarget {
  const t = object(v); return !!t && Object.keys(t).every(k => ['engine', 'model', 'auth'].includes(k)) && isAgentEngine(t.engine) && isModel(t.model) && isAuthRef(t.auth) && (t.engine === 'ai-term' ? t.auth.kind === 'key' && t.model !== null : t.auth.kind === 'account');
}
// A deliberately small YAML subset: scalars and JSON arrays. No tags, aliases, imports or executable metadata.
export function parseAddon(source: string, expected: string): Addon {
  const lines = source.replace(/\r\n/g, '\n').split('\n'), end = lines.indexOf('---', 1), v: Record<string, unknown> = {};
  if (lines[0] !== '---' || end < 0 || Buffer.byteLength(source) > 16000) throw new Error('Invalid add-on definition');
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^([A-Za-z]+): (.+)$/); if (!m || !m[1] || !m[2] || Object.hasOwn(v, m[1])) throw new Error('Invalid add-on metadata');
    const raw = m[2]; v[m[1]] = raw.startsWith('[') || raw.startsWith('"') ? JSON.parse(raw) as unknown : raw === 'true' || raw === 'yes' ? true : raw === 'false' || raw === 'no' ? false : raw;
  }
  const prompt = lines.slice(end + 1).join('\n').trim();
  const list = (x: unknown): x is string[] => Array.isArray(x) && x.length <= 10 && x.every(addonName) && new Set(x).size === x.length;
  if (Object.keys(v).length !== 10 || v.name !== expected || !addonName(v.name) || !text(v.summary, 200) || !text(v.args, 120) || !isAgentEngine(v.defaultEngine) || !Array.isArray(v.engines) || !v.engines.length || v.engines.length > 3 || !v.engines.every(isAgentEngine) || !v.engines.includes(v.defaultEngine) || !list(v.skills) || !list(v.agents) || !['none', 'recommended', 'required'].includes(String(v.brain)) || typeof v.worktree !== 'boolean' || typeof v.readOnly !== 'boolean' || v.readOnly && v.worktree || !text(prompt) || !prompt.includes('{{args}}') || !prompt.includes('{{brainIndex}}')) throw new Error('Invalid add-on definition');
  return { ...v, prompt } as unknown as Addon;
}
export function parseAddonResult(source: string, name: string): AddonResult {
  if (Buffer.byteLength(source) > 64000) throw new Error('Add-on result is too large');
  const p = object(JSON.parse(redactSecrets(source)) as unknown), lines = (v: unknown, max: number) => Array.isArray(v) && v.length > 0 && v.length <= max && v.every(x => text(x, 180) && !String(x).includes('\n'));
  if (!p || p.kind !== name) throw new Error('Add-on result has the wrong kind');
  if (name === 'plan' && Object.keys(p).length === 3 && text(p.title, 120) && Array.isArray(p.steps) && p.steps.length > 0 && p.steps.length <= 24 && p.steps.every(s => { const v = object(s); return v && Object.keys(v).length === 2 && text(v.title, 120) && text(v.prompt, 8000); })) return p as unknown as AddonResult;
  if (name === 'prompt' && Object.keys(p).length === 3 && Array.isArray(p.issues) && p.issues.length <= 24 && p.issues.every(s => text(s, 600)) && text(p.diff, 24000) && p.diff.startsWith('--- ') && p.diff.includes('\n+++ ')) return p as unknown as AddonResult;
  if (name === 'explain' && Object.keys(p).length === 5 && text(p.why, 180) && !p.why.includes('\n') && lines(p.diagram, 4) && Array.isArray(p.chunks) && p.chunks.length > 0 && p.chunks.length <= 16 && p.chunks.every(c => lines(c, 6) && c.some((s: string) => /^Example:/i.test(s)) && c.some((s: string) => /^You are here:/i.test(s)) && c.some((s: string) => /^Quick check:/i.test(s))) && lines(p.recap, 3) && Array.isArray(p.recap) && p.recap.length === 3) return p as unknown as AddonResult;
  throw new Error('Add-on result does not match its format');
}
export function extractAddonResult(source: string, nonce: string, name: string): AddonResult | null {
  const begin = `RESULT_${nonce}_BEGIN`, end = `RESULT_${nonce}_END`, start = source.lastIndexOf(begin), finish = source.indexOf(end, start + begin.length);
  if (start < 0 || finish < 0) return null;
  const body = source.slice(start + begin.length, finish).trim();
  return parseAddonResult(body, name);
}
export function validateAddonAsk(value: unknown): AddonAsk {
  const p = object(value), range = (v: unknown) => { const r = object(v); return !!r && Object.keys(r).length === 2 && typeof r.low === 'number' && typeof r.high === 'number' && Number.isFinite(r.low) && Number.isFinite(r.high) && r.low >= 0 && r.high >= r.low; };
  if (!p || Object.keys(p).length !== 14 || !isUUID(p.receipt) || !addonName(p.name) || !text(p.summary, 200) || !isSafeAbsolutePath(p.cwd) || !isAddonTarget(p.target) || !['none', 'stale', 'fresh'].includes(String(p.brain)) || !['none', 'recommended', 'required'].includes(String(p.brainNeed)) || typeof p.worktree !== 'boolean' || typeof p.readOnly !== 'boolean' || !Array.isArray(p.files) || p.files.length > 20 || !p.files.every(f => typeof f === 'string' && /^(?:skills\/[a-z][a-z0-9-]*\/SKILL|agents\/[a-z][a-z0-9-]*)\.md$/.test(f)) || !range(p.inputTokens) || !range(p.outputTokens) || !(p.priceUsd === null || range(p.priceUsd)) || typeof p.subscription !== 'boolean') throw new Error('Invalid add-on estimate');
  return p as unknown as AddonAsk;
}
