// Secrets that may show up in an agent's screen or files: provider keys, cloud and chat tokens, bearer headers, private
// keys, and NAME=value lines whose name says key, token, secret or password. Used wherever AI Term passes such text on:
// the handoff note (v0.6 gate), /export (v0.7.1) and the secret scan before a merge or PR (v0.7.3). Each pattern names
// what it found; redactSecrets replaces only the secret part, so the surrounding text still reads.
export interface SecretPattern { name: string; pattern: RegExp; keep?: number }
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'private key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  // keep: the capture groups that stay (the name and its = or :), only the value goes.
  { name: 'secret assignment', pattern: /\b([A-Za-z][A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"\n]+"|'[^'\n]+'|[^\s"'\n]+)/gi, keep: 2 },
  { name: 'authorization header', pattern: /\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{16,}/g, keep: 2 },
  { name: 'API key (sk-)', pattern: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { name: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'xAI key', pattern: /\bxai-[A-Za-z0-9]{20,}/g },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { name: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];
export const REDACTED = '[redacted]';
export function redactSecrets(text: string): string {
  let out = text;
  for (const { pattern, keep } of SECRET_PATTERNS)
    out = out.replace(pattern, (...match: unknown[]) => keep ? `${match.slice(1, keep + 1).map(part => typeof part === 'string' ? part : '').join('')}${REDACTED}` : REDACTED);
  return out;
}
