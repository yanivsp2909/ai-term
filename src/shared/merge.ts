import type { SecretHit } from './secret-scan.js';

// v0.7.3 /merge and /pr: what the daemon shows before anything runs (the exact commands, the secret scan's hits by file
// and line only), bound by a fingerprint the y (or a typed `override` when there are hits) must send back.
interface Common { title: string; branch: string; base: string; commands: string[]; hits: SecretHit[]; moreHits: number; scanOff?: true; fingerprint: string }
export interface MergePlan extends Common { repo: string; ahead: number }
export interface PrPlan extends Common { remote: string; gh: 'ready' | 'missing' | 'logged out' }
// eslint-disable-next-line no-control-regex -- refusing controls is the point.
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
function isHit(v: unknown): v is SecretHit {
  const h = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  return !!h && Object.keys(h).length === 4 && text(h.file, 1024) && count(h.line) && text(h.kind, 60) && count(h.length);
}
function common(p: Record<string, unknown> | null, extra: string[]): p is Record<string, unknown> {
  const keys = ['title', 'branch', 'base', 'commands', 'hits', 'moreHits', 'scanOff', 'fingerprint', ...extra];
  return !!p && Object.keys(p).every(k => keys.includes(k)) && text(p.title, 60) && text(p.branch, 200) && text(p.base, 200) && Array.isArray(p.commands) && p.commands.length <= 6 && p.commands.every(c => text(c, 4200))
    && Array.isArray(p.hits) && p.hits.length <= 100 && p.hits.every(isHit) && count(p.moreHits) && (p.scanOff === undefined || p.scanOff === true) && typeof p.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(p.fingerprint);
}
const object = (v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
export function validateMergePlan(value: unknown): MergePlan {
  const p = object(value);
  if (!common(p, ['repo', 'ahead']) || !text(p.repo, 4096) || !count(p.ahead)) throw new Error('Invalid merge plan');
  return p as unknown as MergePlan;
}
export function validatePrPlan(value: unknown): PrPlan {
  const p = object(value);
  if (!common(p, ['remote', 'gh']) || !text(p.remote, 4096) || !['ready', 'missing', 'logged out'].includes(String(p.gh))) throw new Error('Invalid PR plan');
  return p as unknown as PrPlan;
}
