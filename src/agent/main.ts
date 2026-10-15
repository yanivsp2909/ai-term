import { realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { AGENT_ASK_FLAG, AGENT_DONT_ASK_FLAG, buildBashEnv } from '../daemon/env.js';
import { killAllBash } from './bash.js';
import { isEndpoint, isKeyProvider, isSecret, isThemeName, isValidModelId } from '../shared/validate.js';
import { isLocalEndpoint } from '../shared/providers.js';
import type { KeyProvider, ThemeName } from '../shared/protocol.js';
import { createTheme } from '../client/tui/theme.js';
import { Agent, type AgentPermission } from './agent.js';
import { AgentApp } from './app.js';
import { redactor, streamRedactor } from './display.js';
import { loadInstructions } from './instructions.js';
import { makeModel as makeProviderModel } from './provider.js';
import type { FoundryWire } from './providers/foundry.js';
import type { AgentFacts } from '../shared/agent-facts.js';
import { HttpReporter, readAgentSecrets, reporterEnv } from './report.js';
import { Screen } from './screen.js';
import { findRipgrep } from './tools.js';
import { Transcript } from './transcript.js';

export interface AgentArgs { provider: KeyProvider; model: string; models: string[]; theme: ThemeName; transcript: string | null; permission: AgentPermission; firstMessage?: string }
export class AgentUsageError extends Error {}
// The argv env.ts builds (buildAgentArgs). Anything else is refused: Ask unless the one Don't ask flag is there.
export function parseAgentArgs(args: readonly string[]): AgentArgs {
  let provider: KeyProvider | null = null, model: string | null = null, models: string[] = [], theme: ThemeName = 'graphite', transcript: string | null = null, permission: AgentPermission = 'ask', firstMessage: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--') { if (i !== args.length - 2) throw new AgentUsageError('Expected one message after --'); firstMessage = args[i + 1]; break; }
    const [name, value] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (name === '--provider' && isKeyProvider(value)) provider = value;
    else if (name === '--model' && value && isValidModelId(value)) model = value;
    else if (name === '--models' && value) { models = value.split(','); if (!models.every(isValidModelId)) throw new AgentUsageError('Invalid --models'); }
    else if (name === '--theme' && isThemeName(value)) theme = value;
    else if (name === '--transcript' && value && isAbsolute(value) && !value.includes('\0')) transcript = value;
    else if (arg === AGENT_ASK_FLAG) permission = 'ask';
    else if (arg === AGENT_DONT_ASK_FLAG) permission = 'dontAsk';
    else throw new AgentUsageError(`Unknown argument ${JSON.stringify(arg.slice(0, 40))}`);
  }
  if (!provider) throw new AgentUsageError('Missing --provider');
  if (!model) throw new AgentUsageError('Missing --model');
  if (!models.includes(model)) models = [model, ...models];
  return { provider, model, models, theme, transcript, permission, ...(firstMessage !== undefined ? { firstMessage } : {}) };
}

// The key and credentials are copied out of the environment and deleted from it before anything else runs, so nothing
// this process starts later can inherit them (bash gets buildBashEnv's allowlist on top of that).
// Gate: they come from the daemon's 0600 secrets file, read and deleted here (never from the env a `ps -E` shows).
export function takeSecrets(env: NodeJS.ProcessEnv): { key: string | null; endpoint: string | null; reporter: ReturnType<typeof reporterEnv> } {
  const all = { ...env, ...readAgentSecrets(env, true) }, key = all.AITERM_AGENT_KEY, endpoint = all.AITERM_AGENT_ENDPOINT, reporter = reporterEnv({ ...all, AITERM_AGENT_SECRETS: '' });
  for (const name of ['AITERM_AGENT_KEY', 'AITERM_AGENT_ENDPOINT', 'AITERM_STATUS_TOKEN', 'AITERM_STATUS_PORT', 'AITERM_USAGE_TOKEN', 'AITERM_AGENT_SECRETS']) delete env[name];
  return { key: isSecret(key) ? key : null, endpoint: isEndpoint(endpoint) || isLocalEndpoint(endpoint) ? endpoint : null, reporter };
}

// Never guessed: a Chat Completions deployment sent down the Responses API fails every request, so a wire the daemon can't
// confirm (it didn't answer, three tries) refuses the model instead.
export class WireError extends Error {}
export async function foundryWireFor(facts: (model: string) => Promise<AgentFacts | null>, model: string): Promise<FoundryWire> {
  for (let attempt = 0; attempt < 3; attempt++) { const wire = (await facts(model))?.wire; if (wire) return wire; }
  throw new WireError(`couldn't learn how to reach ${model} from AI Term; try again`);
}
export interface AgentTerminal {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(raw: boolean): unknown };
  stdout: NodeJS.WritableStream & { columns?: number; rows?:number; on(event: 'resize', listener: () => void): unknown };
  stderr: NodeJS.WritableStream;
}
export async function runAgent(args: readonly string[], terminal: AgentTerminal = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  // AI Term's folder (not a secret): every bash command is kept out of it.
  const aiTermHome = env.AITERM_HOME && isAbsolute(env.AITERM_HOME) && !env.AITERM_HOME.includes('\0') ? env.AITERM_HOME : null;
  const gitCommon = env.AITERM_GIT_COMMON && isAbsolute(env.AITERM_GIT_COMMON) && !env.AITERM_GIT_COMMON.includes('\0') ? env.AITERM_GIT_COMMON : null;
  const shellDir = (name: string) => { const value = env[name]; return value && isAbsolute(value) && !value.includes('\0') ? value : undefined; };
  const shell = { zdotdir: shellDir('AITERM_ZDOTDIR'), configHome: shellDir('AITERM_XDG_CONFIG_HOME'), runtime: shellDir('AITERM_XDG_RUNTIME_DIR') };
  delete env.AITERM_HOME; delete env.AITERM_GIT_COMMON; delete env.AITERM_ZDOTDIR; delete env.AITERM_XDG_CONFIG_HOME; delete env.AITERM_XDG_RUNTIME_DIR;
  const secrets = takeSecrets(env);
  let parsed: AgentArgs;
  try { parsed = parseAgentArgs(args); } catch (error) { terminal.stderr.write(`ai agent: ${error instanceof AgentUsageError ? error.message : 'invalid arguments'}\n`); return 2; }
  // Ollama (v0.6.5) has no key, only its local endpoint; Foundry and Bedrock need their bound endpoint.
  const local = parsed.provider === 'ollama';
  if (local ? secrets.key !== null || !isLocalEndpoint(secrets.endpoint) : !secrets.key || (parsed.provider === 'foundry' || parsed.provider === 'bedrock') && !secrets.endpoint) { terminal.stderr.write('ai agent runs inside AI Term: start it from the homepage with an API key.\n'); return 2; }
  // The SDK prints its warnings to the console, which here is the agent's own screen.
  (globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;
  const { key, endpoint } = secrets, redact = redactor(key);
  const root = await realpath(process.cwd()), bashEnv = buildBashEnv(env), rg = await findRipgrep(bashEnv.PATH);
  const screen = new Screen({ write: text => terminal.stdout.write(text), get columns() { return terminal.stdout.columns; }, get rows() { return terminal.stdout.rows; } }, createTheme(parsed.theme === 'auto' ? 'graphite' : parsed.theme));
  const reporter = new HttpReporter(secrets.reporter, () => screen.note("status updates aren't reaching AI Term; its card may lag", 'error'));
  const transcript = new Transcript(parsed.transcript, redact, () => screen.note("the transcript couldn't be saved; the conversation goes on", 'error'));
  const instructions = await loadInstructions(root);
  // A Foundry deployment's wire (Responses or Chat Completions) comes from its test, through the daemon's facts.
  const makeModel = async (id: string) => { const wire = parsed.provider === 'foundry' ? await foundryWireFor(id => reporter.facts(id), id) : undefined; return makeProviderModel({ provider: parsed.provider, model: id, key, endpoint, ...(wire ? { wire } : {}) }); };
  let extensionCount=0,extensionCost=0;
  let mcpCount=0,mcpCost=0;
  try {const catalog=await reporter.list(root);extensionCount=catalog.items.filter(i=>i.enabled).length;extensionCost=catalog.tokens;for(const note of catalog.notes)screen.note(note,'warn');}
  catch {screen.note('extensions unavailable; /skills can retry','warn');}
  try{const catalog=await reporter.mcp.list(root);mcpCount=catalog.servers.filter(s=>s.enabled&&!s.note).length;mcpCost=catalog.tokens;}catch{screen.note('MCP unavailable; /mcp can retry','warn');}
  let firstModel;
  try { firstModel = await makeModel(parsed.model); } catch (error) { terminal.stderr.write(`ai agent: ${error instanceof WireError ? error.message : 'the model could not be set up'}\n`); return 1; }
  return new Promise<number>(resolveExit => {
    const restore = () => { terminal.stdout.write('\x1b[?2004l'); terminal.stdin.setRawMode?.(false); terminal.stdin.pause(); };
    // A crash prints fixed words, never a stack or an error message, which could carry anything a provider sent.
    const crash = () => { killAllBash(); restore(); terminal.stderr.write('\nai agent stopped after an internal error\n');void reporter.mcp.stop().then(()=>resolveExit(1),()=>resolveExit(1)); };
    process.once('uncaughtException', crash); process.once('unhandledRejection', crash);
    // Stopped from the homepage (s), by the daemon or by a closed terminal: every running command's process group goes
    // with it (they run in their own groups, so the PTY's signal alone would leave them behind), then the agent exits.
    for (const signal of ['SIGTERM', 'SIGHUP'] as const) process.once(signal, () => { killAllBash(); app.close(); });
    const app = new AgentApp({
      screen, permission: parsed.permission, models: parsed.models, makeModel,
      agent: io => new Agent({ root, permission: parsed.permission, model: firstModel, modelId: parsed.model, instructions, reporter, transcript, io, redact, redactStream: () => streamRedactor(key), bashEnv, rg, bashSandbox: { home: aiTermHome ?? join(homedir(), '.ai-term'), require: parsed.permission === 'dontAsk', shell: Object.fromEntries(Object.entries(shell).filter(([, value]) => value !== undefined)), ...(gitCommon ? { protect: [gitCommon] } : {}) }, extensions: reporter, mcp:reporter.mcp, models: parsed.models, makeModel }),
      quit: () => { restore(); void transcript.close().then(() => resolveExit(0)); },
    });
    if (terminal.stdin.isTTY) terminal.stdin.setRawMode?.(true);
    // Bracketed paste: a paste (or a /send from the homepage) arrives as one piece, never as typed keys.
    terminal.stdout.write('\x1b[?2004h');
    terminal.stdin.setEncoding?.('utf8');
    terminal.stdin.on('data', (data: string | Buffer) => app.input(String(data)));
    terminal.stdin.on('end', () => app.close());
    screen.banner(parsed.model, root, parsed.permission, instructions.files);
    screen.extensionsBanner(extensionCount,extensionCost);
    screen.note(`MCP: ${mcpCount} servers on · ≈${mcpCost} tokens/request · schemas load on use`);
    for (const note of instructions.notes) screen.note(note);
    app.start(parsed.firstMessage);
  });
}
