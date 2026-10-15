import { posix } from 'node:path';
import { redactSecrets } from './redact.js';
import { cleanNote } from './handoff.js';
import type { ReviewModel } from './review.js';

// v1.0.2 /brain: a map of a repository, built only when you run /brain. The local pass is free (no model): the file tree,
// each TS/JS and Python file's imports and exports, and who imports whom; other languages are listed as files only. An
// optional model pass adds a one-to-three-line summary per module and the main design decisions, by a keyed model you
// pick after seeing the token and price range (D49). It lives under ~/.ai-term/brain/<repo id>, never in the repository.
export const BRAIN_MAX_FILE_BYTES = 256 * 1024, BRAIN_MAX_LINES = 2_000, BRAIN_SUMMARY_FILE_CHARS = 12_000, BRAIN_BATCH_CHARS = 60_000;
export const BRAIN_OUTPUT_PER_FILE = { low: 30, high: 160 }, BRAIN_SUMMARY_CHARS = 300, BRAIN_MAX_DECISIONS = 12, BRAIN_MAX_FILES = 20_000;
export type BrainLang = 'ts' | 'py' | 'other';
export interface BrainFile { hash: string; lang: BrainLang; bytes: number; exports: string[]; local: string[]; imports?: string[]; summary?: string }
export interface BrainSkipped { binary: number; large: number; env: number; secret: number }
export interface BrainIndex { version: 1; repo: string; builtAt: string; files: Record<string, BrainFile>; skipped: BrainSkipped; design: string[]; model?: string }
export interface BrainPlan {
  repo: string; files: number; changed: number; removed: number; skipped: BrainSkipped; builtAt: string | null; summarize: number;
  inputTokens: { low: number; high: number }; outputTokens: { low: number; high: number }; models: ReviewModel[]; selected: number; fingerprint: string; agents: boolean;
}
export interface BrainResult { repo: string; path: string; lines: number; files: number; changed: number; summarized: number; costUsd: number | null; model: string | null }

const NAME = /^[A-Za-z_$][\w$]*$/;
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const unique = (items: string[]) => [...new Set(items)];
// Imports and exports by pattern (no parser): enough for a map, and nothing in a file is run.
export function parseTs(source: string): { imports: string[]; exports: string[] } {
  const text = strip(source), imports: string[] = [], exports: string[] = [];
  for (const m of text.matchAll(/\bimport\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+from\s+)?['"]([^'"\n]+)['"]/g)) imports.push(m[1] ?? '');
  for (const m of text.matchAll(/\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+['"]([^'"\n]+)['"]/g)) imports.push(m[1] ?? '');
  for (const m of text.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g)) imports.push(m[1] ?? '');
  for (const m of text.matchAll(/\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/g)) exports.push(m[1] ?? '');
  for (const m of text.matchAll(/\bexport\s+(?:declare\s+)?(?:const|let|var)\s+([^;=]+=?[^;\n]*)/g)) {
    // `export const a = 1, b = 2`: each declared name, not the values.
    for (const part of (m[1] ?? '').split(',')) { const name = part.trim().split(/[\s=:]/)[0] ?? ''; if (NAME.test(name)) exports.push(name); }
  }
  if (/\bexport\s+default\b/.test(text)) exports.push('default');
  for (const m of text.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}(?!\s*from)/g)) {
    for (const part of (m[1] ?? '').split(',')) { const name = part.trim().split(/\s+as\s+/).pop()?.trim() ?? ''; if (NAME.test(name)) exports.push(name); }
  }
  const order = (name: string) => { const i = text.search(new RegExp(`\\bexport\\b[^\\n;]*\\b${name.replace(/\$/g, '\\$')}\\b`)); return i < 0 ? Infinity : i; };
  return { imports: unique(imports.filter(Boolean)), exports: unique(exports).sort((a, b) => order(a) - order(b)) };
}
export function parsePy(source: string): { imports: string[]; exports: string[] } {
  const text = source.replace(/^\s*#.*$/gm, ''), imports: string[] = [], exports: string[] = [];
  for (const line of text.split('\n')) {
    const plain = line.match(/^import\s+(.+)$/), from = line.match(/^from\s+(\.*[\w.]*)\s+import\s+/);
    if (plain) for (const part of (plain[1] ?? '').split(',')) { const name = part.trim().split(/\s+as\s+/)[0]?.trim() ?? ''; if (/^[\w.]+$/.test(name)) imports.push(name); }
    else if (from?.[1]) imports.push(from[1]);
    const def = line.match(/^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/), assign = line.match(/^([A-Z_][A-Z0-9_]*)\s*(?::[^=]+)?=/);
    const name = def?.[1] ?? assign?.[1];
    if (name && !name.startsWith('_')) exports.push(name);
  }
  const all = text.match(/^__all__\s*=\s*[[(]([^\])]*)[\])]/m);
  const listed = all ? [...(all[1] ?? '').matchAll(/['"]([A-Za-z_]\w*)['"]/g)].map(m => m[1] ?? '') : null;
  return { imports: unique(imports), exports: listed ?? unique(exports) };
}
const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
export function langOf(path: string): BrainLang { const ext = posix.extname(path).toLowerCase(); return TS_EXTS.includes(ext) ? 'ts' : ext === '.py' || ext === '.pyi' ? 'py' : 'other'; }
// A relative import to the repository file it names: the file as written, with an extension added, a .js written for a
// .ts source, or the folder's index. Packages (no leading dot) aren't local.
export function resolveTs(from: string, spec: string, files: ReadonlySet<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  if (base.startsWith('..')) return null;
  const stem = base.replace(/\.(?:js|jsx|mjs|cjs)$/, '');
  const candidates = [base, ...TS_EXTS.map(ext => stem + ext), ...TS_EXTS.map(ext => `${base}/index${ext}`)];
  return candidates.find(candidate => files.has(candidate)) ?? null;
}
// A Python import to a repository file: relative (`.n`, `..up`) from the importing package, absolute from the repository
// root or from the file's own top folder (a `py/` or `src/` layout).
export function resolvePy(from: string, module: string, files: ReadonlySet<string>): string | null {
  const dots = module.match(/^\.*/)?.[0].length ?? 0, rest = module.slice(dots).split('.').filter(Boolean);
  const bases = dots ? [posix.join(posix.dirname(from), ...Array<string>(Math.max(0, dots - 1)).fill('..'))] : ['', ...from.includes('/') ? [from.split('/')[0] ?? ''] : []];
  for (const base of bases) {
    const path = posix.normalize(posix.join(base || '.', ...rest));
    if (path.startsWith('..')) continue;
    for (const candidate of [`${path}.py`, `${path}/__init__.py`]) if (files.has(candidate) && candidate !== from) return candidate;
  }
  return null;
}
export function localImports(path: string, imports: readonly string[], files: ReadonlySet<string>): string[] {
  const lang = langOf(path);
  return unique(imports.map(spec => lang === 'ts' ? resolveTs(path, spec, files) : lang === 'py' ? resolvePy(path, spec, files) : null).filter((p): p is string => p !== null && p !== path));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
function skippedLine(skipped: BrainSkipped): string {
  const parts = [skipped.binary ? `${skipped.binary} binary` : '', skipped.large ? `${skipped.large} over 256 KB` : '', skipped.env ? `${skipped.env} .env` : '', skipped.secret ? `${skipped.secret} flagged by the secret scan` : ''].filter(Boolean);
  return parts.length ? `skipped: ${parts.join(', ')}` : 'skipped: none';
}
// The tree as folders with their file counts (files only for small folders), so a big repository still fits.
function tree(paths: readonly string[], room: number): string[] {
  const folders = new Map<string, string[]>();
  for (const path of paths) { const dir = posix.dirname(path); folders.set(dir, [...folders.get(dir) ?? [], posix.basename(path)]); }
  const lines = [...folders.keys()].sort().map(dir => { const names = folders.get(dir) ?? []; return `- ${dir === '.' ? '(root)' : dir + '/'}: ${names.length <= 8 ? names.sort().join(', ') : plural(names.length, 'file')}`; });
  return lines.length <= room ? lines : [...lines.slice(0, Math.max(0, room - 1)), `- … ${lines.length - room + 1} more folders (see brain.json)`];
}
// brain.md: what the agent reads. At most BRAIN_MAX_LINES lines: the module list goes first to TS/JS and Python files with
// the most importers; past the room the rest are counted, and brain.json keeps every file.
export function renderBrain(index: BrainIndex, now: Date): string {
  const paths = Object.keys(index.files).sort(), importers = new Map<string, string[]>();
  for (const path of paths) for (const target of index.files[path]?.local ?? []) importers.set(target, [...importers.get(target) ?? [], path]);
  const head = [
    `# Brain: ${posix.basename(index.repo)}`, '',
    `A map of ${index.repo}, made by AI Term's /brain on ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC${index.model ? ` (summaries by ${index.model})` : ''}. It can be out of date: the code is the truth.`,
    `${plural(paths.length, 'file')} · ${skippedLine(index.skipped)}; ignored files aren't listed.`, '',
  ];
  const design = index.design.length ? ['## Design', ...index.design.map(line => `- ${line}`), ''] : [];
  const modules = paths.filter(path => index.files[path]?.lang !== 'other').sort((a, b) => (importers.get(b)?.length ?? 0) - (importers.get(a)?.length ?? 0) || a.localeCompare(b));
  const block = (path: string): string[] => {
    const file = index.files[path]; if (!file) return [];
    const by = importers.get(path) ?? [], cap = (items: string[]) => items.length > 12 ? [...items.slice(0, 12), `… ${items.length - 12} more`] : items;
    return [`### ${path}`, ...file.summary ? [file.summary] : [], ...file.exports.length ? [`exports: ${cap(file.exports).join(', ')}`] : [],
      ...file.local.length ? [`imports: ${cap(file.local).join(', ')}`] : [], ...by.length ? [`imported by: ${cap(by.sort()).join(', ')}`] : [], ''];
  };
  const treeLines = ['## Files', ...tree(paths, 200), ''];
  const lines = [...head, ...design, ...treeLines, '## Modules'];
  let shown = 0;
  for (const path of modules) {
    const next = block(path);
    if (lines.length + next.length > BRAIN_MAX_LINES - 2) break;
    lines.push(...next); shown++;
  }
  if (shown < modules.length) lines.push(`… ${modules.length - shown} more modules not shown here; brain.json next to this file lists every one.`);
  return lines.slice(0, BRAIN_MAX_LINES).join('\n');
}

// The model pass: each file's text (cut at BRAIN_SUMMARY_FILE_CHARS), secrets removed as /review removes them, inside tags
// it can't close; one line back per path, and design decisions on their own lines.
export function brainPrompt(files: readonly { path: string; text: string }[]): string {
  const body = files.map(file => `<file path="${file.path.replace(/["<>]/g, '_')}">\n${redactSecrets(file.text.slice(0, BRAIN_SUMMARY_FILE_CHARS)).replace(/<\/?file\b[^>]*>/gi, tag => tag.replace('<', '‹'))}\n</file>`).join('\n');
  return [
    'You are writing a map of a code repository for AI coding agents. For each file below write one line:',
    'PATH :: a one-to-three-sentence summary of what the module does and how it is used. No code, no secrets.',
    'Then, if the files show them, up to 5 lines of the main design decisions: DECISION :: one sentence.',
    'Answer with those lines only.', '', body,
  ].join('\n');
}
export function parseSummaries(text: string, paths: readonly string[]): { summaries: Record<string, string>; decisions: string[] } {
  const asked = new Set(paths), summaries: Record<string, string> = {}, decisions: string[] = [];
  for (const raw of cleanNote(text).split('\n')) {
    const at = raw.indexOf(' :: '); if (at < 0) continue;
    const key = raw.slice(0, at).trim().replace(/^[-*•]\s*/, '').replace(/^`|`$/g, ''), value = raw.slice(at + 4).trim().slice(0, BRAIN_SUMMARY_CHARS);
    if (!value) continue;
    if (key === 'DECISION') { if (decisions.length < BRAIN_MAX_DECISIONS && !decisions.includes(value)) decisions.push(value); }
    else if (asked.has(key)) summaries[key] = value;
  }
  return { summaries, decisions };
}
// Codex has no flag for an instructions file, so the start box can put this before your first message instead.
export function brainMention(file: string, message: string): string {
  const line = `Before you start, read the repository map AI Term made at ${file}.`;
  return message ? `${line}\n\n${message}` : line;
}
export function brainAge(builtAt: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(builtAt)) / 60_000));
  return minutes < 60 ? `${minutes}m old` : minutes < 48 * 60 ? `${Math.round(minutes / 60)}h old` : `${Math.round(minutes / 1440)}d old`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const range = (v: unknown) => isRecord(v) && count(v.low) && count(v.high);
// eslint-disable-next-line no-control-regex -- the client shows these as text; controls are refused, not drawn.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;
const text = (v: unknown, max = 4096) => typeof v === 'string' && v.length <= max && !CONTROLS.test(v);
function validSkipped(v: unknown): v is BrainSkipped { return isRecord(v) && count(v.binary) && count(v.large) && count(v.env) && count(v.secret); }
export function validateBrainPlan(v: unknown): BrainPlan {
  if (!isRecord(v) || !text(v.repo) || !count(v.files) || !count(v.changed) || !count(v.removed) || !count(v.summarize) || !validSkipped(v.skipped) || !(v.builtAt === null || text(v.builtAt, 64))
    || !range(v.inputTokens) || !range(v.outputTokens) || !Array.isArray(v.models) || v.models.length > 40 || !count(v.selected) || typeof v.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(v.fingerprint) || typeof v.agents !== 'boolean') throw new Error('Invalid brain plan');
  return v as unknown as BrainPlan;
}
export function validateBrainResult(v: unknown): BrainResult {
  if (!isRecord(v) || !text(v.repo) || !text(v.path) || !count(v.lines) || !count(v.files) || !count(v.changed) || !count(v.summarized) || !(v.costUsd === null || typeof v.costUsd === 'number' && Number.isFinite(v.costUsd) && v.costUsd >= 0) || !(v.model === null || text(v.model, 200))) throw new Error('Invalid brain result');
  return v as unknown as BrainResult;
}
export function validateBrainIndex(v: unknown): BrainIndex {
  if (!isRecord(v) || v.version !== 1 || !text(v.repo) || !text(v.builtAt, 64) || !isRecord(v.files) || !validSkipped(v.skipped) || !Array.isArray(v.design) || !v.design.every(d => text(d, BRAIN_SUMMARY_CHARS))) throw new Error('Invalid brain.json');
  const files = Object.entries(v.files);
  if (files.length > BRAIN_MAX_FILES) throw new Error('Invalid brain.json');
  for (const [path, file] of files) {
    if (!text(path) || path.startsWith('/') || path.split('/').includes('..') || !isRecord(file) || typeof file.hash !== 'string' || !/^[0-9a-f]{64}$/.test(file.hash) || !['ts', 'py', 'other'].includes(String(file.lang)) || !count(file.bytes)
      || !Array.isArray(file.exports) || !file.exports.every(e => text(e, 200)) || !Array.isArray(file.local) || !file.local.every(l => text(l)) || file.summary !== undefined && !text(file.summary, BRAIN_SUMMARY_CHARS)
      || file.imports !== undefined && !(Array.isArray(file.imports) && file.imports.every(i => text(i, 400)))) throw new Error('Invalid brain.json');
  }
  if (v.model !== undefined && !text(v.model, 200)) throw new Error('Invalid brain.json');
  return v as unknown as BrainIndex;
}
