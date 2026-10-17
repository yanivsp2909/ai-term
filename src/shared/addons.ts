import type { AgentEngine, AuthRef } from './protocol.js';
import { isAgentEngine, isAuthRef, isModel, isUUID, isSafeAbsolutePath } from './validate.js';
import { isTestCommand } from './test-run.js';

export interface AddonTarget { engine: AgentEngine; model: string | null; auth: AuthRef }
// How the command's argument is read (v1.1): free text, a file or text, an agent (its diff), a path in the folder
// (default the whole folder), a path or a benchmark command, or /bisect's test command with an optional good ref.
export const ADDON_INPUTS = ['text', 'file-or-text', 'agent', 'path', 'path-or-command', 'command-ref'] as const;
export type AddonInput = typeof ADDON_INPUTS[number];
export interface Addon {
  name: string; summary: string; args: string; defaultEngine: AgentEngine | 'none'; engines: AgentEngine[];
  skills: string[]; agents: string[]; brain: 'none' | 'recommended' | 'required'; worktree: boolean; readOnly: boolean; prompt: string;
  // Optional metadata (v1.1). tests: the project's tests run in the sandbox after the run even with auto-test off.
  // cost: high shows the worst-case price first. local: runs no model (only bisect so far).
  input: AddonInput; tests: boolean; cost: 'normal' | 'high'; local: 'bisect' | null;
}
// What /bisect will do, shown before anything runs; good and bad are commit ids read from your checkout.
export interface BisectAsk { command: string[]; good: string; bad: string; goodLabel: string; commits: number; sandbox: boolean }
export interface AddonAsk {
  receipt: string; name: string; summary: string; cwd: string; target: AddonTarget | null; authLabel?: string; subject?: string; cost?: 'high'; bisect?: BisectAsk;
  brain: 'none' | 'stale' | 'fresh'; brainNeed: Addon['brain']; worktree: boolean; readOnly: boolean; files: string[];
  inputTokens: { low: number; high: number }; outputTokens: { low: number; high: number };
  priceUsd: { low: number; high: number } | null; subscription: boolean;
}
const object = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
export const addonName = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(v);
const text = (v: unknown, max = 16000): v is string => typeof v === 'string' && v.trim().length > 0 && Buffer.byteLength(v) <= max && !/[\p{C}]/u.test(v.replace(/[\n\t]/g, ''));
export function isAddonTarget(v: unknown): v is AddonTarget {
  const t = object(v); return !!t && Object.keys(t).every(k => ['engine', 'model', 'auth'].includes(k)) && isAgentEngine(t.engine) && isModel(t.model) && isAuthRef(t.auth) && (t.engine === 'ai-term' ? t.auth.kind === 'key' && t.model !== null : t.auth.kind === 'account');
}
const REQUIRED = ['name', 'summary', 'args', 'defaultEngine', 'engines', 'skills', 'agents', 'brain', 'worktree', 'readOnly'], OPTIONAL = ['input', 'tests', 'cost', 'local'];
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
  const addon = { input: 'text', tests: false, cost: 'normal', local: null, ...v, prompt } as Record<string, unknown>;
  const common = REQUIRED.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => REQUIRED.includes(k) || OPTIONAL.includes(k)) && v.name === expected && addonName(v.name) && text(v.summary, 200) && text(v.args, 120)
    && list(v.skills) && list(v.agents) && ['none', 'recommended', 'required'].includes(String(v.brain)) && typeof v.worktree === 'boolean' && typeof v.readOnly === 'boolean' && !(v.readOnly && v.worktree) && text(prompt)
    && (ADDON_INPUTS as readonly string[]).includes(String(addon.input)) && typeof addon.tests === 'boolean' && ['normal', 'high'].includes(String(addon.cost)) && (addon.local === null || addon.local === 'bisect');
  // A local add-on runs no model: no engines, skills, agents or brain, nothing it could edit, and a command argument.
  const local = addon.local === 'bisect' && v.defaultEngine === 'none' && Array.isArray(v.engines) && !v.engines.length && !(v.skills as unknown[]).length && !(v.agents as unknown[]).length && v.brain === 'none' && v.readOnly === true && addon.input === 'command-ref' && !addon.tests;
  const model = addon.local === null && isAgentEngine(v.defaultEngine) && Array.isArray(v.engines) && v.engines.length > 0 && v.engines.length <= 3 && v.engines.every(isAgentEngine) && v.engines.includes(v.defaultEngine) && prompt.includes('{{args}}') && prompt.includes('{{brainIndex}}') && addon.input !== 'command-ref';
  if (!common || !(local || model)) throw new Error('Invalid add-on definition');
  return addon as unknown as Addon;
}
function isBisectAsk(v: unknown): v is BisectAsk {
  const b = object(v), id = (x: unknown) => typeof x === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(x);
  return !!b && Object.keys(b).length === 6 && isTestCommand(b.command) && id(b.good) && id(b.bad) && text(b.goodLabel, 120) && Number.isSafeInteger(b.commits) && Number(b.commits) >= 1 && typeof b.sandbox === 'boolean';
}
export function validateAddonAsk(value: unknown): AddonAsk {
  const p = object(value), range = (v: unknown) => { const r = object(v); return !!r && Object.keys(r).length === 2 && typeof r.low === 'number' && typeof r.high === 'number' && Number.isFinite(r.low) && Number.isFinite(r.high) && r.low >= 0 && r.high >= r.low; };
  const optional = ['authLabel', 'subject', 'cost', 'bisect'].filter(k => p && p[k] !== undefined).length;
  if (!p || Object.keys(p).length !== 14 + optional || p.authLabel !== undefined && !text(p.authLabel, 160) || p.subject !== undefined && !text(p.subject, 300) || p.cost !== undefined && p.cost !== 'high' || p.bisect !== undefined && !isBisectAsk(p.bisect)
    || !isUUID(p.receipt) || !addonName(p.name) || !text(p.summary, 200) || !isSafeAbsolutePath(p.cwd) || !(p.target === null ? p.bisect !== undefined : isAddonTarget(p.target)) || !['none', 'stale', 'fresh'].includes(String(p.brain)) || !['none', 'recommended', 'required'].includes(String(p.brainNeed)) || typeof p.worktree !== 'boolean' || typeof p.readOnly !== 'boolean' || !Array.isArray(p.files) || p.files.length > 20 || !p.files.every(f => typeof f === 'string' && /^(?:skills\/[a-z][a-z0-9-]*\/SKILL|agents\/[a-z][a-z0-9-]*)\.md$/.test(f)) || !range(p.inputTokens) || !range(p.outputTokens) || !(p.priceUsd === null || range(p.priceUsd)) || typeof p.subscription !== 'boolean') throw new Error('Invalid add-on estimate');
  return p as unknown as AddonAsk;
}
