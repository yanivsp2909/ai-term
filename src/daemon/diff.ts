import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { DIFF_FILE_LINES, DIFF_LINE_CHARS, DIFF_MAX_FILES, DIFF_MAX_LINES, diffLine, diffPath, type AgentDiff, type DiffFile, type DiffStat, type DiffStatus } from '../shared/diff.js';
import { isFsError } from '../shared/paths.js';
import { diffNameStatus, diffNumstat, diffPatch, GitError, untrackedFiles } from './git.js';

// v0.7.1: an agent's worktree against the commit it started from: committed and uncommitted work from git's own diff,
// untracked (not ignored) files read here as all-added. Text only: every line goes through diffLine; the totals keep
// counting past the caps, and `capped` says something was cut.
const UNTRACKED_READ = 256 * 1024;
// What is shown stays well inside one 4 MiB protocol frame (JSON escaping can double a line).
const SHOWN_BYTES = 1536 * 1024;
const STATUS: Record<string, DiffStatus> = { A: 'added', M: 'modified', T: 'modified', D: 'deleted', R: 'renamed', C: 'added' };
type Body = Pick<AgentDiff, 'files' | 'added' | 'removed' | 'capped'>;

// Split git's unified diff into one section per file, in git's order (the same order --name-status lists them).
function sections(patch: string): { lines: string[]; binary: boolean }[] {
  const out: { lines: string[]; binary: boolean }[] = [];
  let current: { lines: string[]; binary: boolean; inHunk: boolean } | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) { current = { lines: [], binary: false, inHunk: false }; out.push(current); continue; }
    if (!current) continue;
    if (line.startsWith('@@')) current.inHunk = true;
    if (!current.inHunk) { if (line.startsWith('Binary files ') || line === 'GIT binary patch') current.binary = true; continue; }
    if (line && '@ +-\\'.includes(line[0] ?? '')) current.lines.push(line);
  }
  return out;
}
// An untracked file as git would show a new one, without following a symlink or reading past a cap.
async function untracked(root: string, name: string): Promise<Omit<DiffFile, 'path' | 'status'>> {
  if (isAbsolute(name) || name.split('/').includes('..')) return { added: 0, removed: 0, lines: ['+(not shown)'] };
  const path = join(root, name);
  let info;
  try { info = await lstat(path); } catch (error) { if (isFsError(error, 'ENOENT')) return { added: 0, removed: 0, lines: ['+(gone)'] }; throw error; }
  if (info.isSymbolicLink()) return { added: 1, removed: 0, lines: ['+→ symlink (not followed)'] };
  if (info.isDirectory()) return { added: 0, removed: 0, lines: ['+(a folder with its own git repository, not shown)'] };
  if (!info.isFile()) return { added: 0, removed: 0, lines: ['+(not a regular file)'] };
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(Math.min(info.size, UNTRACKED_READ)), { bytesRead } = await file.read(buffer, 0, buffer.length, 0), bytes = buffer.subarray(0, bytesRead);
    if (bytes.subarray(0, 8000).includes(0)) return { added: 0, removed: 0, lines: ['+(binary file, not shown)'], binary: true };
    const text = bytes.toString('utf8'), lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const more = info.size > bytesRead;
    return { added: lines.length, removed: 0, lines: lines.map(line => `+${line}`), ...(more ? { cut: true as const } : {}) };
  } finally { await file.close(); }
}
export async function worktreeDiff(path: string, base: string): Promise<Body> {
  const listed = await diffNameStatus(path, base);
  let patch: string | null;
  try { patch = await diffPatch(path, base); } catch (error) { if (error instanceof GitError && error.message === 'Diff too large') patch = null; else throw error; }
  const parts = patch === null ? [] : sections(patch), files: DiffFile[] = [];
  listed.forEach((entry, i) => {
    const part = parts[i], lines = part?.lines ?? (patch === null ? ['(too large to show)'] : []);
    const added = lines.filter(line => line.startsWith('+')).length, removed = lines.filter(line => line.startsWith('-')).length;
    files.push({ path: diffPath(entry.path), status: STATUS[entry.code] ?? 'modified', ...(entry.from ? { from: diffPath(entry.from) } : {}), added, removed, lines, ...(part?.binary ? { binary: true as const, lines: ['(binary file, not shown)'] } : {}) });
  });
  for (const name of await untrackedFiles(path)) files.push({ path: diffPath(name), status: 'untracked', ...(await untracked(path, name)) });
  return cap(files, patch === null);
}
// The card's `+N −M`: git's counts, plus untracked files' lines (the first 200 files; a folder or binary counts as none).
export async function worktreeStat(path: string, base: string): Promise<DiffStat> {
  const stat = await diffNumstat(path, base), names = await untrackedFiles(path);
  for (const name of names.slice(0, 200)) stat.added += (await untracked(path, name)).added;
  return { ...stat, files: stat.files + names.length };
}
// Totals count every line; what is shown is capped per file, overall and by file count.
function cap(all: DiffFile[], tooLarge: boolean): Body {
  let shown = 0, bytes = 0, capped = tooLarge || all.length > DIFF_MAX_FILES;
  const files = all.slice(0, DIFF_MAX_FILES).map(file => {
    const room = Math.max(0, Math.min(DIFF_FILE_LINES, DIFF_MAX_LINES - shown)), lines: string[] = [];
    for (const raw of file.lines.slice(0, room)) { const line = diffLine(raw); bytes += Buffer.byteLength(line) + 4; if (bytes > SHOWN_BYTES) break; lines.push(line); }
    const cut = file.cut || file.lines.length > lines.length;
    shown += lines.length; if (cut) capped = true;
    const { cut: _cut, ...rest } = file;
    void _cut;
    return { ...rest, lines, ...(cut ? { cut: true as const } : {}) };
  });
  // A line cut by DIFF_LINE_CHARS is also something cut.
  if (files.some(file => file.lines.some(line => line.endsWith('…') && [...line].length > DIFF_LINE_CHARS))) capped = true;
  return { files, added: all.reduce((n, f) => n + f.added, 0), removed: all.reduce((n, f) => n + f.removed, 0), capped };
}
