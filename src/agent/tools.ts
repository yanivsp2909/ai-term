import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { resolveInside, inside } from './jail.js';
import { findExecutable } from '../shared/executable.js';
import { isFsError } from '../shared/paths.js';
import { buildBashEnv } from '../daemon/env.js';
import { visible } from './display.js';

// Bounds that keep one tool call to one reasonable model message and one screen of approval.
export const READ_MAX_BYTES = 256 * 1024, WRITE_MAX_BYTES = 1024 * 1024, OUTPUT_MAX_CHARS = 64 * 1024;
const READ_DEFAULT_LINES = 2000, LINE_MAX_CHARS = 2000, PREVIEW_MAX_LINES = 200, SEARCH_MAX_LINES = 200, SEARCH_TIMEOUT_MS = 15_000;
const WALK_MAX_FILES = 20_000, WALK_SKIP = new Set(['.git', 'node_modules']);

export class ToolError extends Error {}
function cap(text: string, limit = OUTPUT_MAX_CHARS): string { return text.length > limit ? `${text.slice(0, limit)}\n… output cut at ${limit} characters` : text; }
function show(root: string, path: string): string { return relative(root, path) || '.'; }

// Reads at most `limit` bytes; O_NOFOLLOW so a last component swapped for a symlink after the jail check fails.
async function readCapped(path: string, limit: number): Promise<{ text: string; cut: boolean; binary: boolean }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new ToolError('Not a regular file');
    const size = Math.min(info.size, limit), buffer = Buffer.alloc(size);
    const { bytesRead } = await file.read(buffer, 0, size, 0);
    const bytes = buffer.subarray(0, bytesRead);
    return { text: bytes.toString('utf8'), cut: info.size > limit, binary: bytes.includes(0) };
  } finally { await file.close(); }
}
async function writeWhole(path: string, content: string): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  try { await file.writeFile(content, 'utf8'); } finally { await file.close(); }
}
function textInput(value: unknown, name: string, max = WRITE_MAX_BYTES): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max) throw new ToolError(`${name} must be text up to ${max} bytes`);
  return value;
}
async function existingFile(root: string, path: unknown): Promise<string> {
  const real = await resolveInside(root, textInput(path, 'path', 4096));
  try { if (!(await stat(real)).isFile()) throw new ToolError('Not a regular file'); }
  catch (error) { if (error instanceof ToolError) throw error; throw new ToolError('File not found'); }
  return real;
}

export interface ReadInput { path: string; offset?: number; limit?: number }
export async function readTool(root: string, input: ReadInput): Promise<string> {
  const path = await existingFile(root, input.path), { text, cut, binary } = await readCapped(path, READ_MAX_BYTES);
  if (binary) return `${show(root, path)} looks like a binary file`;
  const lines = text.split('\n'), first = Math.max(1, Math.floor(input.offset ?? 1)), count = Math.max(1, Math.min(READ_DEFAULT_LINES, Math.floor(input.limit ?? READ_DEFAULT_LINES)));
  const shown = lines.slice(first - 1, first - 1 + count).map((line, i) => `${String(first + i).padStart(5)}  ${line.length > LINE_MAX_CHARS ? line.slice(0, LINE_MAX_CHARS) + '…' : line}`);
  const more = first - 1 + count < lines.length ? `\n… ${lines.length - (first - 1 + count)} more lines (read again with offset ${first + count})` : '';
  return cap(shown.join('\n') + more + (cut ? `\n… file is larger than ${READ_MAX_BYTES} bytes; only the start was read` : ''));
}

// Common leading and trailing lines are left out; what's left is shown as -/+ lines, exactly as it will be written.
export function diffPreview(before: string | null, after: string): string {
  const old = before === null ? [] : before.split('\n'), next = after.split('\n');
  let start = 0; while (start < old.length && start < next.length && old[start] === next[start]) start++;
  let end = 0; while (end < old.length - start && end < next.length - start && old[old.length - 1 - end] === next[next.length - 1 - end]) end++;
  const lines = [...old.slice(start, old.length - end).map(line => `- ${line}`), ...next.slice(start, next.length - end).map(line => `+ ${line}`)];
  const head = before === null ? 'new file' : lines.length ? `from line ${start + 1}` : 'no change';
  const body = lines.length > PREVIEW_MAX_LINES ? [...lines.slice(0, PREVIEW_MAX_LINES), `… ${lines.length - PREVIEW_MAX_LINES} more changed lines not shown`] : lines;
  return visible([head, ...body].join('\n'));
}

export interface WriteInput { path: string; content: string }
export interface EditInput { path: string; old: string; new: string; replaceAll?: boolean }
export interface GatedTool<T> { preview(root: string, input: T): Promise<{ title: string; body: string }>; run(root: string, input: T): Promise<string> }

export const writeTool: GatedTool<WriteInput> = {
  async preview(root, input) {
    const path = await resolveInside(root, textInput(input.path, 'path', 4096)), content = textInput(input.content, 'content');
    let before: string | null = null;
    try { before = (await readCapped(path, WRITE_MAX_BYTES)).text; }
    catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
    return { title: `write ${visible(show(root, path))}`, body: diffPreview(before, content) };
  },
  async run(root, input) {
    const path = await resolveInside(root, textInput(input.path, 'path', 4096)), content = textInput(input.content, 'content');
    // Folders are created only below the folder itself, then checked again in case one was a symlink all along.
    await mkdir(dirname(path), { recursive: true, mode: 0o755 });
    if (!inside(root, await resolveInside(root, dirname(path)))) throw new ToolError('Path is outside the folder');
    await writeWhole(path, content);
    return `wrote ${show(root, path)} (${content.split('\n').length} lines)`;
  },
};

function applyEdit(text: string, input: EditInput): { text: string; count: number } {
  const old = textInput(input.old, 'old'), replacement = textInput(input.new, 'new');
  if (!old) throw new ToolError('old must not be empty');
  if (old === replacement) throw new ToolError('old and new are the same');
  const count = text.split(old).length - 1;
  if (count === 0) throw new ToolError('old text not found in the file');
  if (count > 1 && !input.replaceAll) throw new ToolError(`old text appears ${count} times; give more context or set replaceAll`);
  return { text: input.replaceAll ? text.split(old).join(replacement) : text.replace(old, () => replacement), count: input.replaceAll ? count : 1 };
}
export const editTool: GatedTool<EditInput> = {
  async preview(root, input) {
    const path = await existingFile(root, input.path), { text, cut } = await readCapped(path, WRITE_MAX_BYTES);
    if (cut) throw new ToolError(`File is larger than ${WRITE_MAX_BYTES} bytes`);
    return { title: `edit ${visible(show(root, path))}`, body: diffPreview(text, applyEdit(text, input).text) };
  },
  async run(root, input) {
    const path = await existingFile(root, input.path), { text, cut } = await readCapped(path, WRITE_MAX_BYTES);
    if (cut) throw new ToolError(`File is larger than ${WRITE_MAX_BYTES} bytes`);
    const result = applyEdit(text, input);
    await writeWhole(path, result.text);
    return `edited ${show(root, path)} (${result.count} replacement${result.count > 1 ? 's' : ''})`;
  },
};

export interface SearchInput { pattern: string; path?: string }
// ripgrep when it is on PATH (a regular expression, .gitignore respected, symlinks not followed, no config file), else a
// plain-text walk that skips .git, node_modules and every symlink.
export async function searchTool(root: string, input: SearchInput, rg?: string | null): Promise<string> {
  const pattern = textInput(input.pattern, 'pattern', 1000);
  if (!pattern) throw new ToolError('pattern must not be empty');
  const target = await resolveInside(root, input.path ?? '.');
  const { lines, unreadable } = rg ? { lines: await ripgrep(rg, root, pattern, target), unreadable: 0 } : await walk(root, pattern, target);
  const skipped = unreadable ? `\n(${unreadable} files or folders couldn't be read)` : '';
  if (!lines.length) return 'no matches' + skipped;
  const shown = lines.slice(0, SEARCH_MAX_LINES).map(line => line.length > 300 ? line.slice(0, 300) + '…' : line);
  return cap(shown.join('\n') + (lines.length > SEARCH_MAX_LINES ? `\n… more matches not shown; narrow the pattern or path` : '') + skipped);
}
export async function findRipgrep(path = process.env.PATH ?? ''): Promise<string | null> { return findExecutable('rg', path); }
function ripgrep(rg: string, root: string, pattern: string, target: string): Promise<string[]> {
  const args = ['--no-config', '--line-number', '--no-heading', '--color=never', '--max-count=50', '--max-filesize=1M', '--regexp', pattern, '--', show(root, target)];
  return new Promise((resolve, reject) => {
    execFile(rg, args, { cwd: root, env: buildBashEnv(process.env), timeout: SEARCH_TIMEOUT_MS, maxBuffer: 4 * OUTPUT_MAX_CHARS }, (error, stdout) => {
      // rg exits 1 for "no matches"; a cut-off buffer still has useful lines.
      if (error && !(typeof error.code === 'number' && error.code === 1) && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') { reject(new ToolError(error.killed ? 'search timed out' : 'search failed (check the pattern)')); return; }
      // rg versions differ on whether an explicit '.' search prefixes filenames with './'. Keep the tool's paths
      // stable across versions; strip only the filename prefix, never text inside a matching line.
      resolve(String(stdout).split('\n').filter(Boolean).map(line => line.startsWith('./') ? line.slice(2) : line));
    });
  });
}
async function walk(root: string, pattern: string, target: string): Promise<{ lines: string[]; unreadable: number }> {
  const found: string[] = [], queue = [target];
  let files = 0, unreadable = 0;
  const visit = async (path: string): Promise<void> => {
    if (++files > WALK_MAX_FILES || found.length > SEARCH_MAX_LINES) return;
    let text: string;
    try { const read = await readCapped(path, WRITE_MAX_BYTES); if (read.binary) return; text = read.text; } catch { unreadable++; return; }
    text.split('\n').forEach((line, i) => { if (line.includes(pattern)) found.push(`${show(root, path)}:${i + 1}:${line}`); });
  };
  const top = await stat(target);
  if (top.isFile()) { await visit(target); return { lines: found, unreadable }; }
  while (queue.length && found.length <= SEARCH_MAX_LINES && files <= WALK_MAX_FILES) {
    const folder = queue.shift() ?? root;
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); } catch { unreadable++; continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || WALK_SKIP.has(entry.name)) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) queue.push(path); else if (entry.isFile()) await visit(path);
    }
  }
  return { lines: found, unreadable };
}
