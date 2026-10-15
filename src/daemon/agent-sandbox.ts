import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import type { AgentSandbox } from '../shared/protocol.js';
import { findBwrap } from './bwrap.js';
import { SANDBOX_EXEC } from './test-sandbox.js';

// v0.8.1: Don't ask for AI Term's agent only where its bash runs sandboxed (D57 + B29): macOS sandbox-exec, Linux
// bubblewrap. Anywhere a sandbox can't start (Windows, no bwrap, user namespaces off, sandbox-exec missing) the agent
// offers Ask only, and the note says why in one line. Claude Code and Codex keep their own modes.
const PROBE_TIMEOUT_MS = 10_000;
const NOTE = {
  macMissing: "don't ask needs macOS's sandbox-exec, which is missing", macFailed: "don't ask needs a sandbox, and sandbox-exec couldn't start one here",
  noBwrap: "don't ask needs bubblewrap (bwrap), which isn't installed", bwrapFailed: "don't ask needs a sandbox, and bubblewrap couldn't start one here",
  windows: "don't ask needs a sandbox, and Windows has none AI Term can use", other: "don't ask needs a sandbox, and this system has none AI Term can use",
  unknown: "don't ask needs a sandbox, and AI Term couldn't check for one",
} as const;
// A start in Don't ask that can't have its sandbox is refused with the same line the start box shows.
export const AGENT_SANDBOX_ERRORS: readonly string[] = Object.values(NOTE);
const runs = (file: string, args: readonly string[]): Promise<boolean> => new Promise(done => {
  execFile(file, [...args], { timeout: PROBE_TIMEOUT_MS, env: { PATH: '/usr/bin:/bin' } }, error => done(!error));
});
// The probe uses the flags the bash sandbox needs (its own PID namespace and /proc): a bwrap that can't make one fails here.
export const BWRAP_PROBE = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-user-try', '--bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--', '/bin/true'];
export interface AgentSandboxDeps { bwrap?: string | null; probe?: (file: string, args: readonly string[]) => Promise<boolean>; sandboxExec?: string }
export async function agentSandbox(platform: NodeJS.Platform = process.platform, deps: AgentSandboxDeps = {}): Promise<AgentSandbox> {
  const probe = deps.probe ?? runs;
  if (platform === 'darwin') {
    const exec = deps.sandboxExec ?? SANDBOX_EXEC;
    try { await access(exec, constants.X_OK); } catch { return { dontAsk: false, note: NOTE.macMissing }; }
    return await probe(exec, ['-p', '(version 1)(allow default)', '--', '/usr/bin/true']) ? { dontAsk: true } : { dontAsk: false, note: NOTE.macFailed };
  }
  if (platform === 'linux') {
    const bwrap = deps.bwrap === undefined ? await findBwrap() : deps.bwrap;
    if (!bwrap) return { dontAsk: false, note: NOTE.noBwrap };
    return await probe(bwrap, BWRAP_PROBE) ? { dontAsk: true } : { dontAsk: false, note: NOTE.bwrapFailed };
  }
  if (platform === 'win32') return { dontAsk: false, note: NOTE.windows };
  return { dontAsk: false, note: NOTE.other };
}
export function dontAskNote(state: AgentSandbox): string | null { return state.dontAsk ? null : state.note ?? NOTE.unknown; }
// Looked up at most once a minute: installing bubblewrap shows up without a daemon restart.
const CACHE_MS = 60_000;
let cached: { at: number; value: Promise<AgentSandbox> } | null = null;
export function currentAgentSandbox(now = Date.now()): Promise<AgentSandbox> {
  if (!cached || now - cached.at > CACHE_MS) cached = { at: now, value: agentSandbox().catch((): AgentSandbox => ({ dontAsk: false, note: NOTE.unknown })) };
  return cached.value;
}
