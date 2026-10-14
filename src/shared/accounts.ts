import type { CliEngine } from './protocol.js';

// v0.6.4 several accounts per engine (D53): a named profile is the CLI's own config folder under ~/.ai-term/profiles/<name>,
// logged in through the CLI's own login. AI Term keeps only the name and engine: never a token or anything from the folder.
export interface AccountProfile { name: string; engine: CliEngine }
// `own` is your normal login (the CLI's usual folder); it can't be a profile name.
export const OWN_ACCOUNT = 'own', MAX_ACCOUNTS = 10;
export const ACCOUNT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
export function isAccountName(value: unknown): value is string { return typeof value === 'string' && ACCOUNT_NAME.test(value) && value !== OWN_ACCOUNT; }
// What an account reference may name: a profile, or `own` for your normal login.
export function isAccountChoice(value: unknown): value is string { return value === OWN_ACCOUNT || isAccountName(value); }
export function validateAccounts(value: unknown): AccountProfile[] {
  if (!Array.isArray(value) || value.length > MAX_ACCOUNTS) throw new Error('Invalid accounts');
  const names = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 2) throw new Error('Invalid accounts');
    const a = entry as Record<string, unknown>;
    if (!isAccountName(a.name) || (a.engine !== 'claude-code' && a.engine !== 'codex') || names.has(a.name)) throw new Error('Invalid accounts');
    names.add(a.name);
  }
  return value as AccountProfile[];
}
export function validateDefaultAccounts(value: unknown): Partial<Record<CliEngine, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([engine, name]) => !['claude-code', 'codex'].includes(engine) || !isAccountName(name))) throw new Error('Invalid default accounts');
  return value as Partial<Record<CliEngine, string>>;
}
