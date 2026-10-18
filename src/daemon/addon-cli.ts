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
// JSON string is one argv element) with --strict-mcp-config. Codex: -c overrides (TOML values, one argv element each).
export const REVERSE_CLI_ERRORS = ["The installed Claude Code has no per-session MCP option, so /reverse can't use it · e picks another engine", "The installed Codex has no per-session MCP option, so /reverse can't use it · e picks another engine"] as const;
const REVERSE_FLAGS: Record<CliEngine, readonly RegExp[]> = { 'claude-code': [/--mcp-config\s+</, /--strict-mcp-config/], codex: [/-c, --config\s+<key=value>/] };
export async function checkReverseCli(engine: CliEngine, file: string): Promise<void> {
  const { stdout } = await run(file, ['--help'], { timeout: 5000, maxBuffer: 512 * 1024, env: buildSpawnEnv(engine, { kind: 'account' }, process.env) });
  if (!REVERSE_FLAGS[engine].every(flag => flag.test(stdout))) throw new Error(engine === 'codex' ? REVERSE_CLI_ERRORS[1] : REVERSE_CLI_ERRORS[0]);
}
