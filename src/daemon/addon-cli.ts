import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildSpawnEnv } from './env.js';
import type { CliEngine } from '../shared/protocol.js';
const run = promisify(execFile);
// Probe the installed binary, not an assumed version. Help contains no prompt or credential, and is never logged.
export async function checkAddonCli(file: string, readOnly: boolean): Promise<void> {
  const { stdout } = await run(file, ['--help'], { timeout: 5000, maxBuffer: 512 * 1024, env: buildSpawnEnv('claude-code', { kind: 'account' }, process.env) });
  if (!/--plugin-dir\s+<path>/.test(stdout) || readOnly && (!/--tools\s+<tools/.test(stdout) || !stdout.includes('--strict-mcp-config'))) throw new Error('Installed Claude CLI lacks add-on loading flags');
}

// v1.0.7 /reverse: the per-session MCP options, read from the installed binary's own help. Claude Code: --mcp-config (a
// JSON string is one argv element) with --strict-mcp-config. Codex has -c overrides, but they merge into your own
// mcp_servers (security review), so no option keeps your other servers out: it's never offered.
export const REVERSE_CLI_ERRORS = ["The installed Claude Code has no per-session MCP option, so /reverse can't use it · e picks another engine", "Codex has no per-session MCP list that leaves out your own MCP servers, so /reverse can't use it · e picks another engine"] as const;
const CLAUDE_MCP_FLAGS: readonly RegExp[] = [/--mcp-config\s+</, /--strict-mcp-config/];
export async function checkReverseCli(engine: CliEngine, file: string): Promise<void> {
  if (engine === 'codex') throw new Error(REVERSE_CLI_ERRORS[1]);
  const { stdout } = await run(file, ['--help'], { timeout: 5000, maxBuffer: 512 * 1024, env: buildSpawnEnv(engine, { kind: 'account' }, process.env) });
  if (!CLAUDE_MCP_FLAGS.every(flag => flag.test(stdout))) throw new Error(REVERSE_CLI_ERRORS[0]);
}
