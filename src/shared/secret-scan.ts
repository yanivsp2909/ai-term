import { SECRET_PATTERNS, isSecretName, isSecretValue } from './redact.js';

// v0.7.3 secret scan (D55, on): before a merge or a PR, the lines an agent's branch adds are checked against the
// redaction patterns (src/shared/redact.ts) plus an entropy check for long random-looking values in code. A hit says
// where (file, line), what kind and how long; the value itself never leaves this function.
export interface SecretHit { file: string; line: number; kind: string; length: number }
export const MAX_HITS = 100;
// Lockfiles are full of hashes and integrity strings: random by design, never a secret.
const LOCKFILES = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|flake\.lock|uv\.lock)$/;
export function shannonEntropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) { const p = count / text.length; bits -= p * Math.log2(p); }
  return bits;
}
// A value in quotes, or right after = or :, 24 to 512 characters of the usual key alphabet ending at a quote or a
// delimiter, with upper and lower case and at least 4 digits mixed in (6+ letter/digit changes), at least 4 bits a
// character. Not a hex hash, an integrity string, or a path (a slash and no + or =). Random by design: real keys.
const CANDIDATE = /(?:["'`]|[=:]\s*)([A-Za-z0-9+/=_-]{24,512})(?=["'`\s,;)}\]]|$)/g;
function looksRandom(value: string): boolean {
  if (/^[0-9a-f]+$/i.test(value) || value.includes('/') && !/[+=]/.test(value)) return false;
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || (value.match(/[0-9]/g) ?? []).length < 4) return false;
  let changes = 0; for (let i = 1; i < value.length; i++) if (/[0-9]/.test(value[i] ?? '') !== /[0-9]/.test(value[i - 1] ?? '')) changes++;
  return changes >= 6 && shannonEntropy(value) >= 4;
}
function highEntropy(line: string): number | null {
  for (const match of line.matchAll(CANDIDATE)) {
    const value = match[1] ?? '';
    if (/sha(?:1|256|384|512)-$/i.test(line.slice(0, match.index + match[0].length - value.length))) continue;
    if (looksRandom(value)) return value.length;
  }
  return null;
}
// The first secret on an added line: a pattern (most specific first), else a high-entropy value (not in test fixtures,
// where random-looking data is the point); null when none.
export function scanLine(text: string, fixture = false): { kind: string; length: number } | null {
  for (const { name, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (name === 'secret assignment' && !(isSecretName(match[2] ?? '') && isSecretValue(match[4] ?? ''))) continue;
      if (name === 'authorization header' && !(/[0-9]/.test(match[0]) && /[A-Za-z]/.test(match[0].slice(7)))) continue;
      return { kind: name, length: match[0].length };
    }
  }
  if (fixture) return null;
  const length = highEntropy(text);
  return length === null ? null : { kind: 'high-entropy string', length };
}
const FIXTURES = /(?:^|\/)(?:fixtures?|__fixtures__|testdata|__snapshots__)\/|\.snap$|\.min\.(?:js|css)$/;
// git's C-style quoting of unusual path names: "b/\303\251 \"q\".txt" → é "q".txt (octal bytes are UTF-8).
function unquote(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const bytes: number[] = [], body = raw.slice(1, -1), esc: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const char = body[i] ?? '';
    if (char !== '\\') { bytes.push(...Buffer.from(char)); continue; }
    const next = body[i + 1] ?? '', octal = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) { bytes.push(parseInt(octal, 8)); i += 3; } else { bytes.push(esc[next] ?? next.charCodeAt(0)); i += 1; }
  }
  return Buffer.from(bytes).toString('utf8');
}
// The new side's name from a `+++ ` header: a trailing tab (names with spaces) goes, quotes are undone, b/ is dropped.
function headerName(raw: string): string {
  const name = unquote(raw.replace(/\t$/, ''));
  return name === '/dev/null' ? '' : name.replace(/^b\//, '');
}
// A unified diff: the new side's file and line number of every added line. Inside a hunk its @@ counts decide what is
// content (an added line may itself start with "++ "); headers are read only between hunks.
export function scanPatch(patch: string, max = MAX_HITS): SecretHit[] {
  const hits: SecretHit[] = [];
  let file = '', line = 0, oldLeft = 0, newLeft = 0;
  for (const raw of patch.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (raw.startsWith('+')) {
        newLeft--;
        if (file && !LOCKFILES.test(file)) { const hit = scanLine(raw.slice(1), FIXTURES.test(file)); if (hit) { hits.push({ file, line, ...hit }); if (hits.length >= max) return hits; } }
        line++;
      } else if (raw.startsWith('-')) oldLeft--;
      else if (raw.startsWith(' ')) { oldLeft--; newLeft--; line++; }
      else if (!raw.startsWith('\\')) { oldLeft = 0; newLeft = 0; }
      continue;
    }
    if (raw.startsWith('+++ ')) { file = headerName(raw.slice(4)); continue; }
    const hunk = raw.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) { oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]); line = Number(hunk[2]); newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]); }
  }
  return hits;
}
