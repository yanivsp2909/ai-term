// Secrets that may show up in an agent's screen or files: provider keys, cloud and chat tokens, bearer headers, private
// keys, and NAME=value lines whose name says key, token, secret or password. Used wherever AI Term passes such text on:
// the handoff note (v0.6 gate), /export (v0.7.1) and the secret scan before a merge or PR (v0.7.3). redactSecrets
// replaces only the secret part, so the surrounding text still reads. Every pattern is bounded (no nested or unbounded
// quantifier before a fixed suffix), so a long unbroken run of text is scanned in linear time.
// replace gets the match and its capture groups by position ('' for a group that took no part).
export interface SecretPattern { name: string; pattern: RegExp; replace: (match: string, ...groups: string[]) => string }
export const REDACTED = '[redacted]';
const whole = () => REDACTED;

// A name is a secret's when it is, or ends in, one of these words as a whole part of the name: API_KEY, db-password,
// "password", apiKey, refreshToken. sortKey, primaryKey, maxTokens, max_tokens, monkey and keyboard are not.
const SECRET_WORD = /(?:^|[_.-])(?:api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|key|token|secret|password|passwd|pwd|credentials?)$/i;
const CAMEL_SECRET = /(?:api|access|secret|private|client|auth|session|refresh|bearer)(?:Key|Token|Secret)$|[a-z0-9](?:Password|Passwd|Secret|Credentials?)$/;
export function isSecretName(name: string): boolean { return SECRET_WORD.test(name) || CAMEL_SECRET.test(name); }
// A value is a secret's when it looks like one: quoted text of 4+ characters, or a bare value with a digit or symbol (or
// 12+ letters). Types, calls and references (string, getToken(), ${TOKEN}, process.env.X) are code, not secrets.
const NOT_SECRET = new Set(['string', 'number', 'boolean', 'null', 'undefined', 'true', 'false', 'none', 'nil', 'str', 'int', 'bool', 'any', 'unknown', 'required', 'optional']);
export function isSecretValue(raw: string): boolean {
  const quoted = /^(["'`]).*\1$/s.test(raw), value = quoted ? raw.slice(1, -1) : raw;
  if (!value || /[\s(){}]|^\$|^process\.env\./.test(value) || NOT_SECRET.has(value.toLowerCase())) return false;
  return quoted ? value.length >= 4 : value.length >= 12 || value.length >= 4 && /[0-9]|[^A-Za-z]/.test(value);
}
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  // A private key block, or its start when the text is cut before the end marker.
  { name: 'private key', pattern: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g, replace: whole },
  // NAME=value, NAME: value, "name": "value". The name is at most 64 characters, the separator on one line.
  { name: 'secret assignment', pattern: /(["']?)\b([A-Za-z][A-Za-z0-9_.-]{0,63})\1([ \t]*[=:][ \t]*)("[^"\n]{0,512}"|'[^'\n]{0,512}'|[^\s"',;\n]{1,512})/g,
    replace: (match, quote = '', name = '', separator = '', value = '') => isSecretName(name) && isSecretValue(value) ? `${quote}${name}${quote}${separator}${REDACTED}` : match },
  { name: 'authorization header', pattern: /\bBearer([ \t]+)([A-Za-z0-9._~+/=-]{16,4096})(?![A-Za-z0-9._~+/=-])/g, replace: (match, space = '', token = '') => /[0-9]/.test(token) && /[A-Za-z]/.test(token) ? `Bearer${space}${REDACTED}` : match },
  { name: 'basic credentials', pattern: /\bBasic([ \t]+)([A-Za-z0-9+/]{16,4096}={0,2})(?![A-Za-z0-9+/=._-])/g, replace: (_match, space = '') => `Basic${space}${REDACTED}` },
  { name: 'API key (sk-)', pattern: /\bsk-[A-Za-z0-9_-]{16,512}/g, replace: whole },
  { name: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})/g, replace: whole },
  { name: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: whole },
  { name: 'xAI key', pattern: /\bxai-[A-Za-z0-9]{20,255}/g, replace: whole },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}/g, replace: whole },
  { name: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,255}/g, replace: whole },
  { name: 'JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{10,4096}/g, replace: whole },
];
export function redactSecrets(text: string): string {
  let out = text;
  for (const { pattern, replace } of SECRET_PATTERNS) out = out.replace(pattern, (match: string, ...rest: unknown[]) => {
    // After the groups come the offset (a number) and the whole input: only the groups before the offset are passed on.
    const groups = rest.slice(0, rest.findIndex(part => typeof part === 'number')).map(part => typeof part === 'string' ? part : '');
    return replace(match, ...groups);
  });
  return out;
}
