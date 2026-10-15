import { stripVTControlCharacters } from 'node:util';

// v0.7.1 /diff and d: what an agent changed in its worktree since it started, from git's own output. Only text crosses
// the socket, cleaned and capped here; the client draws it as plain cells (D22: never the agent's raw output).
export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
// added/removed count every changed line, even past a cut; lines are the unified diff's (hunk headers, ' ', '+', '-').
export interface DiffFile { path: string; status: DiffStatus; from?: string; added: number; removed: number; lines: string[]; binary?: true; cut?: true }
export interface AgentDiff { title: string; branch: string; base: string; files: DiffFile[]; added: number; removed: number; capped: boolean }
export interface DiffStat { added: number; removed: number; files: number }
export const DIFF_MAX_FILES = 500, DIFF_MAX_LINES = 20_000, DIFF_FILE_LINES = 4_000, DIFF_LINE_CHARS = 400, DIFF_PATH_CHARS = 1024;
const TAB = '    ';
// Escapes and every control or invisible format character go (OSC 52 included); a tab becomes four spaces; a line longer
// than DIFF_LINE_CHARS is cut and ends in an ellipsis.
export function diffLine(text: string): string {
  // eslint-disable-next-line no-control-regex -- removing controls is the point.
  const clean = stripVTControlCharacters(text).replace(/\t/g, TAB).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]|(?!\u200d)\p{Cf}/gu, '');
  return [...clean].length > DIFF_LINE_CHARS ? [...clean].slice(0, DIFF_LINE_CHARS).join('') + '…' : clean;
}
// A path as git printed it, shown as text: no controls, no escapes, bounded.
// A name of nothing printable (only controls or zero-width characters) still gets a visible row.
export function diffPath(path: string): string { return [...diffLine(path)].slice(0, DIFF_PATH_CHARS).join('').trim() || '(unprintable name)'; }

const STATUSES: readonly DiffStatus[] = ['added', 'modified', 'deleted', 'renamed', 'untracked'];
// eslint-disable-next-line no-control-regex -- refusing controls is the point.
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && [...v].length <= max && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const exact = (v: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(k => k in v) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
function isDiffFile(v: unknown): v is DiffFile {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const f = v as Record<string, unknown>;
  return exact(f, ['path', 'status', 'added', 'removed', 'lines'], ['from', 'binary', 'cut']) && isText(f.path, DIFF_PATH_CHARS) && !!f.path && STATUSES.includes(f.status as DiffStatus)
    && (f.from === undefined || isText(f.from, DIFF_PATH_CHARS)) && isCount(f.added) && isCount(f.removed) && (f.binary === undefined || f.binary === true) && (f.cut === undefined || f.cut === true)
    && Array.isArray(f.lines) && f.lines.length <= DIFF_FILE_LINES && f.lines.every(line => isText(line, DIFF_LINE_CHARS + 1));
}
export function validateAgentDiff(value: unknown): AgentDiff {
  const d = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!d || !exact(d, ['title', 'branch', 'base', 'files', 'added', 'removed', 'capped']) || !isText(d.title, 60) || !isText(d.branch, 200) || !isText(d.base, 200) || !isCount(d.added) || !isCount(d.removed) || typeof d.capped !== 'boolean'
    || !Array.isArray(d.files) || d.files.length > DIFF_MAX_FILES || !d.files.every(isDiffFile) || d.files.reduce((n: number, f: DiffFile) => n + f.lines.length, 0) > DIFF_MAX_LINES) throw new Error('Invalid diff');
  return d as unknown as AgentDiff;
}
export function isDiffStat(v: unknown): v is DiffStat {
  return !!v && typeof v === 'object' && !Array.isArray(v) && exact(v as Record<string, unknown>, ['added', 'removed', 'files']) && isCount((v as DiffStat).added) && isCount((v as DiffStat).removed) && isCount((v as DiffStat).files);
}
