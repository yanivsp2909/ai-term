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
// A value in quotes, or right after = or :, 24 to 512 characters of the usual key alphabet, with upper case, lower case
// and digits, at least 4 bits a character, and not a plain hex hash (commits, SHA-256 sums) or an integrity string.
const CANDIDATE = /(?:["'`]|[=:]\s*)([A-Za-z0-9+/=_-]{24,512})/g;
function highEntropy(line: string): number | null {
  for (const match of line.matchAll(CANDIDATE)) {
    const value = match[1] ?? '';
    if (/^[0-9a-f]+$/i.test(value) || /sha(?:1|256|384|512)-$/i.test(line.slice(0, match.index + match[0].length - value.length))) continue;
    if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) continue;
    if (shannonEntropy(value) >= 4) return value.length;
  }
  return null;
}
// The first secret on an added line: a pattern (most specific first), else a high-entropy value; null when none.
export function scanLine(text: string): { kind: string; length: number } | null {
  for (const { name, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (name === 'secret assignment' && !(isSecretName(match[2] ?? '') && isSecretValue(match[4] ?? ''))) continue;
      if (name === 'authorization header' && !(/[0-9]/.test(match[0]) && /[A-Za-z]/.test(match[0].slice(7)))) continue;
      return { kind: name, length: match[0].length };
    }
  }
  const length = highEntropy(text);
  return length === null ? null : { kind: 'high-entropy string', length };
}
// A unified diff (git diff -U0 or more): the new side's file and line number of every added line.
export function scanPatch(patch: string, max = MAX_HITS): SecretHit[] {
  const hits: SecretHit[] = [];
  let file = '', line = 0;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('+++ ')) { file = raw === '+++ /dev/null' ? '' : raw.slice(4).replace(/^b\//, ''); continue; }
    if (raw.startsWith('diff --git ') || raw.startsWith('--- ')) continue;
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (raw.startsWith('+')) {
      if (file && !LOCKFILES.test(file)) { const hit = scanLine(raw.slice(1)); if (hit) { hits.push({ file, line, ...hit }); if (hits.length >= max) return hits; } }
      line++;
    } else if (raw.startsWith(' ')) line++;
  }
  return hits;
}
