import { lstat } from 'node:fs/promises';
import { relative } from 'node:path';
import { GitError, runGit } from './git.js';
import { addonFile } from '../agent/addon-bundle.js';
import { JailError, resolveInside } from '../agent/jail.js';
import { isFsError } from '../shared/paths.js';
import { fitEscaped, quoted } from './addon-text.js';
import { SECRET_FILE } from '../shared/review.js';

// v1.1 batch 2: what AI Term reads itself, read-only, before an add-on's model runs. Each returns the data the model gets
// (cut to fit its first message), the subject the popup names, and AI Term's own facts shown before you start.
export interface Gathered { data: string; subject: string; facts: string[]; cwd?: string; commitAgent?: string; commitState?: string }
export const GATHER_DATA_BYTES = 9000, CHANGELOG_COMMITS = 300;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// /changelog [from..to]: two revision words joined by .., neither one able to read as an option. Default: since the
// latest tag, or the last 50 commits when there is none.
const REV = '[A-Za-z0-9_./~^@{}][A-Za-z0-9_./~^@{}-]*';
export async function changelogRange(repo: string, args: string): Promise<Gathered> {
  const wanted = args.trim();
  if (wanted && !new RegExp(`^${REV}\\.\\.(?:${REV})?$`).test(wanted)) throw new Error('/changelog [from..to] · two refs joined by .., like v1.2.0..HEAD');
  let range = wanted, limit = CHANGELOG_COMMITS;
  if (!range) {
    // describe exits non-zero when there's no tag: then the last 50 commits.
    const tag = await runGit(repo, ['describe', '--tags', '--abbrev=0', '--end-of-options', 'HEAD']).then(out => out.trim(), (error: unknown) => { if (error instanceof GitError) return ''; throw error; });
    range = tag ? `${tag}..HEAD` : 'HEAD'; if (!tag) limit = 50;
  }
  const log = (await runGit(repo, ['log', '--no-merges', `--max-count=${limit}`, '--no-color', '--format=%h%x09%an%x09%s', '--end-of-options', range, '--'], 'Git check failed', { maxBuffer: 4 * 1024 * 1024 })).split('\n').filter(Boolean);
  const label = range === 'HEAD' ? `the last ${log.length} commits` : `range ${range}`;
  return { data: fitEscaped([`Commits (${label}; hash, author, subject):`, ...log].join('\n'), GATHER_DATA_BYTES), subject: label, facts: [`${label} · ${plural(log.length, 'commit')}`] };
}

// /context: AGENTS.md and CLAUDE.md at the repository's top, with their @imports (one level, inside the repository
// only), numbered so findings can name a line. Sizes are AI Term's estimate (bytes / 4). Review: an import never reads
// a credential or env file (/prompt's rule), a file over 64 KB is skipped and said, and a name shown in the facts is
// cut and stripped of control characters (it comes from the repository).
export const CONTEXT_FILES = ['AGENTS.md', 'CLAUDE.md'], CONTEXT_IMPORTS = 8, CONTEXT_FILE_MAX = 64 * 1024;
const tokens = (text: string) => Math.ceil(Buffer.byteLength(text) / 4);
const regular = async (path: string) => { try { return (await lstat(path)).isFile(); } catch (error) { if (isFsError(error, 'ENOENT') || isFsError(error, 'ENOTDIR')) return false; throw error; } };
export async function contextFiles(repo: string, extra: { facts: string[]; data: string[] } = { facts: [], data: [] }): Promise<Gathered> {
  const facts: string[] = [], parts: string[] = [], seen = new Set<string>(), queue = [...CONTEXT_FILES];
  for (let n = 0; n < queue.length && seen.size < CONTEXT_FILES.length + CONTEXT_IMPORTS; n++) {
    const name = queue[n] ?? '', label = name.replace(/[\p{C}]/gu, '?').slice(0, 120);
    if (SECRET_FILE.test(name.replaceAll('\\', '/'))) { facts.push(`skipped: ${label} (a file that usually holds secrets)`); continue; }
    let full: string, isFile: boolean;
    try { full = await resolveInside(repo, name); isFile = await regular(full); }
    catch (error) {
      if (error instanceof JailError) { facts.push(`skipped: ${label} (outside the repository)`); continue; }
      // A name the file system refuses (too long, a loop, no access) is said, not a failure of the whole audit.
      if (['ENAMETOOLONG', 'ELOOP', 'EACCES', 'EINVAL'].some(code => isFsError(error, code))) { facts.push(`skipped: ${label} (not a readable file name)`); continue; }
      throw error;
    }
    const shown = relative(repo, full);
    if (SECRET_FILE.test(shown)) { facts.push(`skipped: ${label} (a file that usually holds secrets)`); continue; }
    if (seen.has(shown) || !isFile) continue;
    seen.add(shown);
    if ((await lstat(full)).size > CONTEXT_FILE_MAX) { facts.push(`skipped: ${shown.slice(0, 120)} (over 64 KB)`); continue; }
    const text = await addonFile(repo, shown, CONTEXT_FILE_MAX);
    facts.push(`${shown} ≈${tokens(text).toLocaleString('en-US')} tokens`);
    parts.push(`File ${shown}:`, ...text.split('\n').map((line, i) => `${shown}:${i + 1}: ${line}`));
    for (const line of text.split('\n')) { const m = line.match(/^@(\S+)$/); if (m?.[1] && CONTEXT_FILES.includes(name)) queue.push(m[1]); }
  }
  if (!seen.size) facts.push('no AGENTS.md or CLAUDE.md at the repository top');
  return { data: fitEscaped(quoted([...parts, ...extra.data].join('\n')), GATHER_DATA_BYTES), subject: 'instruction files and loaded skills', facts: [...facts.slice(0, 20), ...extra.facts] };
}

// /commit in your checkout: only what is staged, read-only. Nothing staged is said, not guessed. A file that usually
// holds secrets (.env, keys) is left out of what the model sees, and the popup says so (review).
export async function stagedChanges(repo: string): Promise<Gathered> {
  const flags = ['--no-color', '--no-ext-diff', '--no-textconv'];
  const stat = (await runGit(repo, ['diff', '--cached', '--numstat', '-z', ...flags, '--'], 'Git check failed', { maxBuffer: 4 * 1024 * 1024 })).split('\0').filter(Boolean);
  if (!stat.length) throw new Error('Nothing is staged in this folder · git add what belongs in the commit, or /commit <agent>');
  // -z numstat: "added<TAB>removed<TAB>path"; a rename is "added<TAB>removed<TAB>" followed by two path entries.
  const rows: { added: number; removed: number; path: string }[] = [];
  for (let n = 0; n < stat.length; n++) { const [added = '', removed = '', path = ''] = (stat[n] ?? '').split('\t'); const name = path || (n += 2, stat[n] ?? ''); rows.push({ added: Number(added) || 0, removed: Number(removed) || 0, path: name }); }
  const secret = rows.filter(r => SECRET_FILE.test(r.path)), shown = rows.filter(r => !SECRET_FILE.test(r.path));
  const patch = shown.length ? await runGit(repo, ['diff', '--cached', '--unified=3', ...flags, '--', ...shown.map(r => r.path)], 'Git check failed', { maxBuffer: 32 * 1024 * 1024 }) : '(only files that usually hold secrets are staged; their contents are left out)';
  return { data: fitEscaped(patch, GATHER_DATA_BYTES), subject: 'staged in your checkout (c copies; AI Term never commits here)',
    facts: [`staged: ${plural(rows.length, 'file')}, +${rows.reduce((n, r) => n + r.added, 0)} −${rows.reduce((n, r) => n + r.removed, 0)}`, ...secret.length ? [`left out: ${secret.map(r => r.path.replace(/[\p{C}]/gu, '?')).join(', ').slice(0, 200)} (${secret.length === 1 ? 'a file that usually holds' : 'files that usually hold'} secrets)`] : []] };
}
