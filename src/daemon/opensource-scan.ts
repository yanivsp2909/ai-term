import { GitError, runGit } from './git.js';
import { scanLine } from '../shared/secret-scan.js';
import { fitEscaped, quoted } from './addon-text.js';

// v1.1 /opensource: AI Term's own read-only checks before a repository goes public. Every line ever added in the
// history is run through the secret scan (a secret removed later is still in the history). The files are checked for a
// license, a README, personal paths and emails. Results name a commit, a file and a line, never the secret or the
// address itself; they reach the model as data.
export const SCAN_HISTORY_MAX = 128 * 1024 * 1024, SCAN_HITS = 40, SCAN_FALLBACK_COMMITS = 2000, SCAN_DATA_BYTES = 9000;
const LOG = ['-c', 'core.quotePath=false', 'log', '-p', '--all', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--format=commit %H'];
// Paths and emails that identify a person; example and noreply addresses are placeholders, not leaks.
const PERSONAL = '(/Users/|/home/)[A-Za-z0-9._-]+', EMAIL = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}';
const PLACEHOLDER = /noreply|no-reply|@example\.(?:com|org|net)\b|\.invalid\b|@users\.noreply\.github\.com/i;
async function grep(repo: string, pattern: string): Promise<string[]> {
  // git grep exits 1 when nothing matches: that is an answer, not a failure.
  try { return (await runGit(repo, ['grep', '-n', '-I', '-E', '--no-color', '-e', pattern, '--', '.'], 'Git check failed', { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 })).split('\n').filter(Boolean); }
  catch (error) { if (error instanceof GitError) return []; throw error; }
}
// A history too large for one read is scanned for its last commits instead, and the facts say so (review).
async function history(repo: string, maxBuffer: number, fallback: number): Promise<{ text: string; note: string }> {
  try { return { text: await runGit(repo, [...LOG, '--'], 'Git check failed', { maxBuffer, timeout: 120_000 }), note: '' }; }
  catch (error) { if (!(error instanceof GitError)) throw error; }
  return { text: await runGit(repo, [...LOG, `--max-count=${fallback}`, '--'], 'Git check failed', { maxBuffer, timeout: 120_000 }), note: ` · only the last ${fallback} commit${fallback === 1 ? '' : 's'}: the full history was too large` };
}
export async function opensourceScan(repo: string, options: { maxBuffer?: number; fallbackCommits?: number } = {}): Promise<{ data: string; facts: string[] }> {
  const { text, note } = await history(repo, options.maxBuffer ?? SCAN_HISTORY_MAX, options.fallbackCommits ?? SCAN_FALLBACK_COMMITS);
  const hits: string[] = [], commits = new Set<string>(); let commit = '', file = '', count = 0, inHunk = false;
  for (const line of text.split('\n')) {
    // Headers outside a hunk name the file; inside a hunk every + line is content, even one that starts with ++ (review).
    if (line.startsWith('commit ')) { commit = line.slice(7, 19); inHunk = false; continue; }
    if (line.startsWith('diff --git ')) { inHunk = false; file = line.match(/ b\/(.+)$/)?.[1] ?? file; continue; }
    if (!inHunk) { if (line.startsWith('+++ b/')) file = line.slice(6); if (line.startsWith('@@')) inHunk = true; continue; }
    if (line.startsWith('@@')) continue;
    if (!line.startsWith('+')) continue;
    const hit = scanLine(line.slice(1)); if (!hit) continue;
    count++; commits.add(commit);
    if (hits.length < SCAN_HITS) hits.push(`commit ${commit} · ${file} · ${hit.kind} (${hit.length} characters, masked)`);
  }
  const files = (await runGit(repo, ['ls-files', '-z', '--'], 'Git check failed', { maxBuffer: 16 * 1024 * 1024 })).split('\0').filter(Boolean);
  const license = files.find(f => /^(?:LICEN[CS]E|COPYING)(?:\.[A-Za-z]+)?$/i.test(f)), readme = files.find(f => /^README(?:\.[A-Za-z]+)?$/i.test(f));
  // Only file:line, so a personal path or an address isn't repeated to the model.
  const where = (line: string) => line.split(':').slice(0, 2).join(':');
  const paths = (await grep(repo, PERSONAL)).map(where), emails = (await grep(repo, EMAIL)).filter(line => !PLACEHOLDER.test(line)).map(where);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const facts = [`history: ${plural(count, 'secret-bearing line')} in ${plural(commits.size, 'commit')} (masked)${note}`, `LICENSE: ${license ?? 'missing'}`, `README: ${readme ?? 'missing'}`, `personal paths: ${plural(paths.length, 'line')}`, `emails: ${plural(emails.length, 'line')}`];
  const data = ['Secrets in history (values masked):', ...hits.length ? hits : ['none found'], ...count > hits.length ? [`… ${count - hits.length} more`] : [],
    `License file: ${license ?? 'none'}`, `README: ${readme ?? 'none'}`,
    'Personal paths (file:line):', ...paths.slice(0, SCAN_HITS), 'Emails (file:line):', ...emails.slice(0, SCAN_HITS)].join('\n');
  return { data: fitEscaped(quoted(data), SCAN_DATA_BYTES), facts };
}
