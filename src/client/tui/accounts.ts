import type { AgentEngine, AuthRef, CliEngine } from '../../shared/protocol.js';
import { OWN_ACCOUNT, isAccountChoice, isAccountName } from '../../shared/accounts.js';

// v0.6.4 /account (D53): add <claude|codex> <name> · default <name> · use <name|own> · rm <name> · (nothing) lists.
export type AccountCommand = { kind: 'list' } | { kind: 'add'; engine: CliEngine; name: string } | { kind: 'default' | 'rm'; name: string } | { kind: 'use'; name: string } | { kind: 'error'; text: string };
const USAGE = '/account · /account add claude|codex <name> · /account default <name> · /account use <name|own> · /account rm <name>';
export function parseAccountCommand(text: string): AccountCommand {
  const [action, first, second, ...rest] = text.trim().split(/\s+/).slice(1);
  if (!action) return { kind: 'list' };
  if (action === 'add') {
    const engine = first === 'claude' || first === 'claude-code' ? 'claude-code' : first === 'codex' ? 'codex' : null;
    return engine && isAccountName(second) && !rest.length ? { kind: 'add', engine, name: second } : { kind: 'error', text: `${USAGE} · names: a-z, 0-9 and -, up to 32 (own is your normal login)` };
  }
  if ((action === 'default' || action === 'rm') && isAccountName(first) && second === undefined) return { kind: action, name: first };
  if (action === 'use' && isAccountChoice(first) && second === undefined) return { kind: 'use', name: first };
  return { kind: 'error', text: USAGE };
}
// The account an account start bills, as the daemon resolves it: the one picked, else the engine's default, else your own
// login (v0.6 gate: the start box, bar and presets said "own login" while a default account would be used).
export function accountAuthLabel(auth: Extract<AuthRef, { kind: 'account' }>, engine: AgentEngine, defaults: Partial<Record<CliEngine, string>>, ownLabel: string): string {
  const choice = auth.profile ?? (engine === 'ai-term' ? undefined : defaults[engine]);
  return choice && choice !== OWN_ACCOUNT ? `account ${choice}` : ownLabel;
}
// "claude:work" or "codex" → the engine, and the account to continue on (none: the engine's default).
export function parseHandoffTarget(token: string): { engine: CliEngine; account?: string } | null {
  const [engineWord, account, extra] = token.split(':');
  const engine = engineWord === 'claude' || engineWord === 'claude-code' ? 'claude-code' : engineWord === 'codex' ? 'codex' : null;
  if (!engine || extra !== undefined || account !== undefined && !isAccountChoice(account)) return null;
  return account ? { engine, account } : { engine };
}
