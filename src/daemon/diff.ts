import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { DIFF_FILE_LINES, DIFF_LINE_CHARS, DIFF_MAX_FILES, DIFF_MAX_LINES, diffLine, diffPath, type AgentDiff, type DiffFile, type DiffStat, type DiffStatus } from '../shared/diff.js';
import { isFsError } from '../shared/paths.js';
import { diffNameStatus, diffNumstat, diffPatch, GitError, isolatedGitDir, untrackedFiles, type IsolatedGit, type NameStatus } from './git.js';

// v0.7.1: an agent's worktree against the commit it started from: committed and uncommitted work from git's own diff,
// untracked (not ignored) files read here as all-added. Text only: every line goes through diffLine; the totals keep
// counting past the caps, and `capped` says something was cut.
const UNTRACKED_READ = 256 * 1024;
// What is shown stays well inside one 4 MiB protocol frame (JSON escaping can double a line).
const SHOWN_BYTES = 1024 * 1024;
const STATUS: Record<string, DiffStatus> = { A: 'added', M: 'modified', T: 'modified', D: 'deleted', R: 'renamed', C: 'added' };
type Body = Pick<AgentDiff, 'files' | 'added' | 'removed' | 'capped'>;

// Split git's unified diff into one section per file, in git's order (the same order --name-status lists them).
// header: git's own section line, used to check that each section belongs to the file it is paired with.
interface Section { header: string; lines: string[]; binary: boolean }
function sections(patch: string): Section[] {
  const out: Section[] = [];
  let current: (Section & { inHunk: boolean }) | null = null;
  for (const line of patch.split('\n')) {
    // A merge conflict shows as a combined diff (diff --cc): still one section.
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) { current = { header: line, lines: [], binary: false, inHunk: false }; out.push(current); continue; }
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
  // Unreadable is shown as such: one file (mode 000, a race, too many open files) never breaks the whole diff.
  try { return await readUntracked(root, path); } catch { return { added: 0, removed: 0, lines: ['+(unreadable)'] }; }
}
async function readUntracked(root: string, path: string): Promise<Omit<DiffFile, 'path' | 'status'>> {
  let info;
  try { info = await lstat(path); } catch (error) { if (isFsError(error, 'ENOENT')) return { added: 0, removed: 0, lines: ['+(gone)'] }; throw error; }
  // O_NOFOLLOW guards the last part of the path only: a folder on the way that became a symlink would lead outside.
  const folder = await realpath(dirname(path)), top = await realpath(root);
  if (folder !== top && !folder.startsWith(top + '/')) return { added: 0, removed: 0, lines: ['+(not shown)'] };
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
// git writes an unquoted header as `diff --git a/<old> b/<new>`; a quoted one (unusual names) can't be checked this way.
const owns = (section: Section, entry: NameStatus) => section.header.includes('"') || !section.header.startsWith('diff --git ') || section.header === `diff --git a/${entry.from ?? entry.path} b/${entry.path}`;
export async function worktreeDiff(path: string, base: string): Promise<Body> {
  const git = await isolatedGitDir(path, base);
  try { return await diffWith(path, base, git); } finally { await git.dispose(); }
}
async function diffWith(path: string, base: string, git: IsolatedGit): Promise<Body> {
  const listed = await diffNameStatus(path, base, git);
  let patch: string | null;
  try { patch = await diffPatch(path, base, git); } catch (error) { if (error instanceof GitError && error.message === 'Diff too large') patch = null; else throw error; }
  const parts = patch === null ? [] : sections(patch), files: DiffFile[] = [];
  let next = 0, aligned = true;
  for (const entry of listed) {
    // A type change (a file that became a symlink) is one name-status entry but two sections: removed, then added.
    const own = aligned ? parts.slice(next, next + (entry.code === 'T' ? 2 : 1)) : [];
    if (aligned && own.some(section => !owns(section, entry))) aligned = false;
    if (aligned) next += own.length;
    const shown = aligned ? own : [], lines = shown.length ? shown.flatMap(section => section.lines) : patch === null ? ['(too large to show)'] : aligned ? [] : ['(diff not shown)'];
    const added = lines.filter(line => line.startsWith('+')).length, removed = lines.filter(line => line.startsWith('-')).length;
    files.push({ path: diffPath(entry.path), status: STATUS[entry.code] ?? 'modified', ...(entry.from ? { from: diffPath(entry.from) } : {}), added, removed, lines, ...(shown.some(section => section.binary) ? { binary: true as const, lines: ['(binary file, not shown)'] } : {}) });
  }
  // Untracked files past the file cap are counted as cut, never opened; reading stops once the line cap is reached.
  const names = await untrackedFiles(path, git), room = Math.max(0, DIFF_MAX_FILES - files.length);
  let read = 0;
  for (const name of names.slice(0, room)) {
    if (read >= DIFF_MAX_LINES) { files.push({ path: diffPath(name), status: 'untracked', added: 0, removed: 0, lines: [], cut: true }); continue; }
    const file = await untracked(path, name); read += file.lines.length;
    files.push({ path: diffPath(name), status: 'untracked', ...file });
  }
  return cap(files, patch === null || names.length > room || !aligned);
}
// The card's `+N −M`: git's counts, plus untracked files' lines (the first 200 files; a folder or binary counts as none).
export async function worktreeStat(path: string, base: string): Promise<DiffStat> {
  const git = await isolatedGitDir(path, base);
  try {
    const stat = await diffNumstat(path, base, git), names = await untrackedFiles(path, git);
    for (const name of names.slice(0, 200)) stat.added += (await untracked(path, name)).added;
    return { ...stat, files: stat.files + names.length };
  } finally { await git.dispose(); }
}
// Totals count every line; what is shown is capped per file, overall and by file count.
function cap(all: DiffFile[], tooLarge: boolean): Body {
  let shown = 0, bytes = 0, capped = tooLarge || all.length > DIFF_MAX_FILES;
  const files = all.slice(0, DIFF_MAX_FILES).map(file => {
    const room = Math.max(0, Math.min(DIFF_FILE_LINES, DIFF_MAX_LINES - shown)), lines: string[] = [];
    // Names count too: 500 long paths alone could otherwise fill a frame.
    bytes += Buffer.byteLength(file.path) + Buffer.byteLength(file.from ?? '') + 64;
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
