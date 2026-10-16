import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath, rm, rmdir, utimes } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { BRAIN_MAX_FILE_BYTES, BRAIN_MAX_FILES, BRAIN_SUMMARY_FILE_CHARS, langOf, localImports, parsePy, parseTs, renderBrain, renderBrainIndex, safeBrainName, validateBrainIndex, type BrainFile, type BrainIndex, type BrainSkipped } from '../shared/brain.js';
import { SECRET_FILE } from '../shared/review.js';
import { scanLine } from '../shared/secret-scan.js';
import { isFsError, privateDirectory } from '../shared/paths.js';
import { listFiles } from './git.js';
import { repoDirectory } from './worktrees.js';
import { atomicWrite, atomicWriteText } from './store.js';

// v1.0.2 /brain, the local pass and the files. Nothing in the repository is run or written: git lists the files (what
// .gitignore leaves out never shows), each file is read once, and the map goes to ~/.ai-term/brain/<repo id>.
export class BrainError extends Error {}
export const BRAIN_ERRORS = ["This folder isn't in a git repository; /brain maps one", 'This repository has over 20,000 files; /brain maps up to 20,000', 'No brain for this repository yet · /brain builds one',
  'The repository changed since the plan was shown; run /brain again', 'Pick one of the models /brain offered', 'A /brain build for this repository is already running', 'The brain request failed',
  'The brain would pass your daily budget', 'The brain would pass your weekly budget', 'The brain would pass your monthly budget', "The brain's model pass would pass the per-run cap in /settings c"] as const;
export interface BrainPaths { dir: string; markdown: string; index: string; json: string }
export function brainPaths(root: string, top: string): BrainPaths {
  const dir = join(root, 'brain', repoDirectory(top));
  return { dir, markdown: join(dir, 'brain.md'), index: join(dir, 'brain-index.md'), json: join(dir, 'brain.json') };
}
export const BRAIN_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const ENV_FILE = /(?:^|\/)\.env(?:\..*)?$|(?:^|\/)\.envrc$/i;
type Read = { kind: 'file'; text: string; bytes: number; hash: string } | { kind: 'link'; hash: string } | { kind: 'skip'; reason: keyof BrainSkipped } | { kind: 'gone' };
// The brain folder, checked on every read too: a real folder of yours, not a link (security review).
export async function brainFolderSafe(root: string, top: string): Promise<boolean> {
  try { const info = await lstat(brainPaths(root, top).dir); if (info.isSymbolicLink() || !info.isDirectory()) throw new BrainError('The brain folder is not a plain folder; AI Term left it alone'); return true; }
  catch (error) { if (isFsError(error, 'ENOENT')) return false; throw error; }
}
// One file as the map sees it: never through a link (it could lead out of the repository), never past 256 KB.
export async function readRepoFile(top: string, path: string, realTop?: string): Promise<Read> {
  if (ENV_FILE.test(path)) return { kind: 'skip', reason: 'env' };
  if (SECRET_FILE.test(path)) return { kind: 'skip', reason: 'secret' };
  const full = join(top, ...path.split('/'));
  let info;
  try { info = await lstat(full); } catch (error) { if (isFsError(error, 'ENOENT') || isFsError(error, 'ENOTDIR')) return { kind: 'gone' }; throw error; }
  if (info.isSymbolicLink()) return { kind: 'link', hash: createHash('sha256').update(`link\0${await readlink(full)}`).digest('hex') };
  if (!info.isFile()) return { kind: 'gone' };
  if (info.size > BRAIN_MAX_FILE_BYTES) return { kind: 'skip', reason: 'large' };
  // O_NOFOLLOW guards only the last part: a folder on the way swapped for a link (git still lists what its index holds)
  // would lead outside the repository. Its real folder must be inside the repository's (security review).
  const root = realTop ?? await realpath(top);
  let folder: string;
  try { folder = await realpath(dirname(full)); } catch (error) { if (isFsError(error, 'ENOENT') || isFsError(error, 'ENOTDIR')) return { kind: 'gone' }; throw error; }
  if (folder !== root && !folder.startsWith(root.endsWith(sep) ? root : root + sep)) return { kind: 'gone' };
  let file;
  // Swapped for a link or removed since the look above: listed as gone, not a failed scan (review).
  try { file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (isFsError(error, 'ELOOP') || isFsError(error, 'ENOENT') || isFsError(error, 'EMLINK')) return { kind: 'gone' }; throw error; }
  let buffer: Buffer;
  try { buffer = await file.readFile(); } finally { await file.close(); }
  if (buffer.length > BRAIN_MAX_FILE_BYTES) return { kind: 'skip', reason: 'large' };
  if (buffer.subarray(0, 8000).includes(0)) return { kind: 'skip', reason: 'binary' };
  const text = buffer.toString('utf8');
  if (text.split('\n').some(line => scanLine(line) !== null)) return { kind: 'skip', reason: 'secret' };
  return { kind: 'file', text, bytes: buffer.length, hash: createHash('sha256').update(buffer).digest('hex') };
}
// The local pass. With the last map, a file whose hash didn't change keeps what was found (and its summary) without
// being parsed again; imports are resolved again for every file, since a new or removed file changes where they lead.
export async function scanRepo(top: string, previous: BrainIndex | null): Promise<{ index: BrainIndex; parsed: string[]; removed: string[]; texts: Map<string, string> }> {
  const listed = await listFiles(top);
  if (listed.length > BRAIN_MAX_FILES) throw new BrainError('This repository has over 20,000 files; /brain maps up to 20,000');
  const realTop = await realpath(top);
  let total = 0;
  const skipped: BrainSkipped = { binary: 0, large: 0, env: 0, secret: 0, names: 0 }, found = new Map<string, { file: Omit<BrainFile, 'local'>; imports: string[] }>(), parsed: string[] = [], texts = new Map<string, string>();
  for (let i = 0; i < listed.length; i += 32) {
    const batch = listed.slice(i, i + 32), reads = await Promise.all(batch.map(path => !safeBrainName(path) ? Promise.resolve<Read>({ kind: 'skip', reason: 'names' }) : total > BRAIN_MAX_TOTAL_BYTES ? Promise.resolve<Read>({ kind: 'skip', reason: 'large' }) : readRepoFile(top, path, realTop)));
    batch.forEach((path, n) => {
      const read = reads[n];
      if (!read || read.kind === 'gone') return;
      if (read.kind === 'skip') { skipped[read.reason] = (skipped[read.reason] ?? 0) + 1; return; }
      // At most 200 MB read in one scan; past it, files count as too large (security review: a scan has a bound).
      if (read.kind === 'file') total += read.bytes;
      const before = previous?.files[path], lang = read.kind === 'link' ? 'other' : langOf(path);
      if (before && before.hash === read.hash) { found.set(path, { file: { hash: before.hash, lang: before.lang, bytes: before.bytes, exports: before.exports, ...before.summary ? { summary: before.summary } : {} }, imports: before.imports ?? [] }); return; }
      parsed.push(path);
      if (read.kind === 'link') { found.set(path, { file: { hash: read.hash, lang: 'other', bytes: 0, exports: [] }, imports: [] }); return; }
      // Only code is ever summarized, and only its start is sent: nothing else is kept in memory (review).
      if (lang !== 'other') texts.set(path, read.text.slice(0, BRAIN_SUMMARY_FILE_CHARS));
      const shape = lang === 'ts' ? parseTs(read.text) : lang === 'py' ? parsePy(read.text) : { imports: [], exports: [] };
      const safe = (name: string) => { if (safeBrainName(name)) return true; skipped.names = (skipped.names ?? 0) + 1; return false; };
      found.set(path, { file: { hash: read.hash, lang, bytes: read.bytes, exports: shape.exports.filter(safe).slice(0, 200) }, imports: shape.imports.filter(safe).slice(0, 400) });
    });
  }
  const names = new Set(found.keys()), files: Record<string, BrainFile> = {};
  for (const [path, entry] of [...found].sort(([a], [b]) => a.localeCompare(b))) files[path] = { ...entry.file, imports: entry.imports, local: localImports(path, entry.imports, names) };
  const removed = previous ? Object.keys(previous.files).filter(path => !names.has(path)).sort() : [];
  return { index: { version: 1, repo: top, builtAt: new Date().toISOString(), files, skipped, design: previous?.design ?? [], ...previous?.model ? { model: previous.model } : {} }, parsed: parsed.sort(), removed, texts };
}
export async function readBrain(root: string, top: string): Promise<BrainIndex | null> {
  const { json } = brainPaths(root, top);
  if (!await brainFolderSafe(root, top)) return null;
  let file;
  try { file = await open(json, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (isFsError(error, 'ENOENT')) return null; throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new BrainError('brain.json is unreadable; /brain rm, then /brain');
    let data: unknown;
    try { data = JSON.parse(await file.readFile('utf8')); } catch (error) { if (error instanceof SyntaxError) throw new BrainError('brain.json is unreadable; /brain rm, then /brain', { cause: error }); throw error; }
    try { return validateBrainIndex(data); } catch (error) { throw new BrainError('brain.json is unreadable; /brain rm, then /brain', { cause: error }); }
  } finally { await file.close(); }
}
// brain.md and brain.json in a folder only you can open (0700, files 0600); brain.json last, so a crash in between leaves
// the old hashes and the next /brain rescans what it must.
export async function writeBrain(root: string, top: string, index: BrainIndex, now = new Date(), trusted = false): Promise<{ path: string; lines: number }> {
  const paths = brainPaths(root, top);
  await privateDirectory(join(root, 'brain')); await privateDirectory(paths.dir);
  const markdown = renderBrain(index, now);
  await atomicWriteText(paths.markdown, markdown + '\n');
  // brain.md's time is the map's own, so an agent's card and the next plan agree on its age (review).
  const at = new Date(index.builtAt); await utimes(paths.markdown, at, at);
  await writeBrainIndex(root, top, index, trusted);
  await atomicWrite(paths.json, index);
  return { path: paths.markdown, lines: markdown.split('\n').length };
}
export async function writeBrainIndex(root: string, top: string, index: BrainIndex, trusted: boolean): Promise<string> {
  const paths = brainPaths(root, top);
  await privateDirectory(join(root, 'brain')); await privateDirectory(paths.dir);
  await atomicWriteText(paths.index, renderBrainIndex(index, paths.markdown, trusted) + '\n');
  const at = new Date(index.builtAt); await utimes(paths.index, at, at);
  return paths.index;
}
export async function removeBrain(root: string, top: string): Promise<boolean> {
  const paths = brainPaths(root, top);
  try { const info = await lstat(paths.dir); if (info.isSymbolicLink() || !info.isDirectory()) throw new BrainError('The brain folder is not a plain folder; AI Term left it alone'); }
  catch (error) { if (isFsError(error, 'ENOENT')) return false; throw error; }
  await rm(paths.index, { force: true }); await rm(paths.markdown, { force: true }); await rm(paths.json, { force: true });
  // The folder goes too when nothing else is in it (a write cut short leaves a temp file, which stays for a look).
  try { await rmdir(paths.dir); } catch (error) { if (!isFsError(error, 'ENOTEMPTY')) throw error; }
  return true;
}
