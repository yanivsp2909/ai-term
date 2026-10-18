import { basename } from 'node:path';
import { approvable } from '../../src/daemon/remote/backend.js';
import type { SessionInfo } from '../../src/shared/protocol.js';

// Tier 2's two rules that touch your own accounts, kept apart so they're tested without a login (tests/live-suite.test.ts).

// At most this many yeses per agent; more means it wants things the suite never asked for.
export const MAX_APPROVALS = 2;
// Anything chained to a command, piped, or substituted into it.
const CHAINED = /&&|\|\||;|\||`|\$\(|\$\{/;
// A prompt the suite may answer yes to for you: plain yes/no, exactly as AI Term's phone remote would answer it
// (approvable), and only for the one thing the suite asked for (reviews: a plain yes for anything else the model tried
// was pressed too, and a command that merely named the file passed a substring check). Claude Code: its file prompt for
// exactly that file name, never a Bash command. Codex: a command that names the path, with nothing chained, piped or
// substituted. Only the screen's last lines count: the live prompt, not an earlier one.
export function expectedApproval(engine: SessionInfo['engine'], lines: readonly string[], expected: string): boolean {
  if (!approvable(engine, lines)) return false;
  const shown = lines.filter(line => /\S/.test(line)).slice(-12), text = shown.join('\n');
  if (engine === 'claude-code') {
    if (/\bBash command\b/.test(text)) return false;
    const question = [...shown].reverse().find(line => /Do you want to/.test(line))?.trim(), name = basename(expected);
    return question === `Do you want to create ${name}?` || question === `Do you want to make this edit to ${name}?`;
  }
  if (engine === 'codex') return text.includes(expected) && !CHAINED.test(text);
  return false;
}

// The keys you added in this run, removed from your Keychain. They're listed by the run's own daemon, whose AI Term
// folder is temporary, so every key it lists is this run's. "removed" is said only after a second list comes back empty
// (review: a dead daemon was reported as a removed key).
export interface KeyDaemon { request(body: { kind: 'keys.list' } | { kind: 'keys.remove'; keyId: string }): Promise<{ keys?: readonly { id: string }[] }>; close(): void }
export async function removeRunKeys(open: () => Promise<KeyDaemon | null>, out: (line: string) => void): Promise<boolean> {
  const loud = (why: string) => { out(`  ✗ KEY MAY STILL BE IN YOUR KEYCHAIN (${why}): open Keychain Access, search for "ai-term" and delete the entry this run added`); return false; };
  const daemon = await open().catch(() => null);
  if (!daemon) return loud("the run's daemon didn't answer");
  try {
    const keys = (await daemon.request({ kind: 'keys.list' })).keys ?? [];
    if (!keys.length) return true;
    for (const key of keys) await daemon.request({ kind: 'keys.remove', keyId: key.id });
    const left = (await daemon.request({ kind: 'keys.list' })).keys ?? [];
    if (left.length) return loud(`${left.length} still listed after removing`);
    out(`  removed ${keys.length === 1 ? 'the key' : `${keys.length} keys`} you added from your Keychain`);
    return true;
  } catch (error) { return loud(error instanceof Error ? error.message : 'removing failed'); }
  finally { daemon.close(); }
}
