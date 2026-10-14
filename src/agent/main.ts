import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { AGENT_ASK_FLAG, AGENT_DONT_ASK_FLAG, buildBashEnv } from '../daemon/env.js';
import { isEndpoint, isSecret, isThemeName, isValidModelId } from '../shared/validate.js';
import type { ThemeName } from '../shared/protocol.js';
import { createTheme } from '../client/tui/theme.js';
import { Agent, type AgentPermission } from './agent.js';
import { AgentApp } from './app.js';
import { redactor } from './display.js';
import { loadInstructions } from './instructions.js';
import { foundryModel } from './provider.js';
import { HttpReporter, reporterEnv } from './report.js';
import { Screen } from './screen.js';
import { findRipgrep } from './tools.js';
import { Transcript } from './transcript.js';

export interface AgentArgs { model: string; models: string[]; theme: ThemeName; transcript: string | null; permission: AgentPermission; firstMessage?: string }
export class AgentUsageError extends Error {}
// The argv env.ts builds (buildAgentArgs). Anything else is refused: Ask unless the one Don't ask flag is there.
export function parseAgentArgs(args: readonly string[]): AgentArgs {
  let model: string | null = null, models: string[] = [], theme: ThemeName = 'graphite', transcript: string | null = null, permission: AgentPermission = 'ask', firstMessage: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--') { if (i !== args.length - 2) throw new AgentUsageError('Expected one message after --'); firstMessage = args[i + 1]; break; }
    const [name, value] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (name === '--model' && value && isValidModelId(value)) model = value;
    else if (name === '--models' && value) { models = value.split(','); if (!models.every(isValidModelId)) throw new AgentUsageError('Invalid --models'); }
    else if (name === '--theme' && isThemeName(value)) theme = value;
    else if (name === '--transcript' && value && isAbsolute(value) && !value.includes('\0')) transcript = value;
    else if (arg === AGENT_ASK_FLAG) permission = 'ask';
    else if (arg === AGENT_DONT_ASK_FLAG) permission = 'dontAsk';
    else throw new AgentUsageError(`Unknown argument ${JSON.stringify(arg.slice(0, 40))}`);
  }
  if (!model) throw new AgentUsageError('Missing --model');
  if (!models.includes(model)) models = [model, ...models];
  return { model, models, theme, transcript, permission, ...(firstMessage !== undefined ? { firstMessage } : {}) };
}

// The key and credentials are copied out of the environment and deleted from it before anything else runs, so nothing
// this process starts later can inherit them (bash gets buildBashEnv's allowlist on top of that).
export function takeSecrets(env: NodeJS.ProcessEnv): { key: string | null; endpoint: string | null; reporter: ReturnType<typeof reporterEnv> } {
  const key = env.AITERM_AGENT_KEY, endpoint = env.AITERM_AGENT_ENDPOINT, reporter = reporterEnv(env);
  for (const name of ['AITERM_AGENT_KEY', 'AITERM_AGENT_ENDPOINT', 'AITERM_STATUS_TOKEN', 'AITERM_STATUS_PORT', 'AITERM_USAGE_TOKEN']) delete env[name];
  return { key: isSecret(key) ? key : null, endpoint: isEndpoint(endpoint) ? endpoint : null, reporter };
}

export interface AgentTerminal {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(raw: boolean): unknown };
  stdout: NodeJS.WritableStream & { columns?: number; on(event: 'resize', listener: () => void): unknown };
  stderr: NodeJS.WritableStream;
}
export async function runAgent(args: readonly string[], terminal: AgentTerminal = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const secrets = takeSecrets(env);
  let parsed: AgentArgs;
  try { parsed = parseAgentArgs(args); } catch (error) { terminal.stderr.write(`ai agent: ${error instanceof AgentUsageError ? error.message : 'invalid arguments'}\n`); return 2; }
  if (!secrets.key || !secrets.endpoint) { terminal.stderr.write("ai agent runs inside AI Term: start it from the homepage with an API key (a Foundry key in this version).\n"); return 2; }
  // The SDK prints its warnings to the console, which here is the agent's own screen.
  (globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;
  const { key, endpoint } = secrets, redact = redactor(key);
  const root = await realpath(process.cwd()), bashEnv = buildBashEnv(env), rg = await findRipgrep(bashEnv.PATH);
  const screen = new Screen({ write: text => terminal.stdout.write(text), get columns() { return terminal.stdout.columns; } }, createTheme(parsed.theme === 'auto' ? 'graphite' : parsed.theme));
  const reporter = new HttpReporter(secrets.reporter, () => screen.note("status updates aren't reaching AI Term; its card may lag", 'error'));
  const transcript = new Transcript(parsed.transcript, redact, () => screen.note("the transcript couldn't be saved; the conversation goes on", 'error'));
  const instructions = await loadInstructions(root);
  const makeModel = (id: string) => foundryModel(endpoint, id, key);
  return new Promise<number>(resolveExit => {
    const restore = () => { terminal.stdout.write('\x1b[?2004l'); terminal.stdin.setRawMode?.(false); terminal.stdin.pause(); };
    const app = new AgentApp({
      screen, permission: parsed.permission, models: parsed.models, makeModel,
      agent: io => new Agent({ root, permission: parsed.permission, model: makeModel(parsed.model), modelId: parsed.model, instructions, reporter, transcript, io, redact, bashEnv, rg }),
      quit: () => { restore(); void transcript.close().then(() => resolveExit(0)); },
    });
    if (terminal.stdin.isTTY) terminal.stdin.setRawMode?.(true);
    // Bracketed paste: a paste (or a /send from the homepage) arrives as one piece, never as typed keys.
    terminal.stdout.write('\x1b[?2004h');
    terminal.stdin.setEncoding?.('utf8');
    terminal.stdin.on('data', (data: string | Buffer) => app.input(String(data)));
    terminal.stdin.on('end', () => app.close());
    screen.banner(parsed.model, root, parsed.permission, instructions.files);
    for (const note of instructions.notes) screen.note(note);
    app.start(parsed.firstMessage);
  });
}
