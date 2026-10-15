// v0.7.2 /undo and /redo: what the daemon shows before it restores anything (the ask), and what the client may accept.
export type UndoChange = { path: string; change: 'modified' | 'removed' | 'restored' };
// target: the checkpoint number undo goes back to (null for redo: the state saved by the last /undo). fingerprint binds
// the y to exactly this plan: the daemon refuses if the worktree or the target changed in between.
export interface UndoPlan { kind: 'undo' | 'redo'; title: string; target: number | null; targetAt: string; changes: UndoChange[]; more: number; fingerprint: string }
export const UNDO_SHOWN = 200;
const CHANGES = ['modified', 'removed', 'restored'];
// eslint-disable-next-line no-control-regex -- refusing controls is the point.
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
export function validateUndoPlan(value: unknown): UndoPlan {
  const p = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!p || Object.keys(p).length !== 7 || !['undo', 'redo'].includes(String(p.kind)) || !text(p.title, 60) || !(p.target === null || Number.isSafeInteger(p.target) && (p.target as number) > 0)
    || typeof p.targetAt !== 'string' || !Number.isFinite(Date.parse(p.targetAt)) || !Number.isSafeInteger(p.more) || (p.more as number) < 0 || typeof p.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(p.fingerprint)
    || !Array.isArray(p.changes) || p.changes.length > UNDO_SHOWN || !p.changes.every(c => c && typeof c === 'object' && Object.keys(c).length === 2 && text((c as UndoChange).path, 1024) && CHANGES.includes((c as UndoChange).change))) throw new Error('Invalid undo plan');
  return p as unknown as UndoPlan;
}
