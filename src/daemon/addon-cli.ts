import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildSpawnEnv } from './env.js';
const run = promisify(execFile);
// Probe the installed binary, not an assumed version. Help contains no prompt or credential, and is never logged.
export async function checkAddonCli(file: string, readOnly: boolean): Promise<void> {
  const { stdout } = await run(file, ['--help'], { timeout: 5000, maxBuffer: 512 * 1024, env: buildSpawnEnv('claude-code', { kind: 'account' }, process.env) });
  if (!/--plugin-dir\s+<path>/.test(stdout) || readOnly && (!/--tools\s+<tools/.test(stdout) || !stdout.includes('--strict-mcp-config'))) throw new Error('Installed Claude CLI lacks add-on loading flags');
}
