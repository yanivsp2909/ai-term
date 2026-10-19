import { spawn } from 'node:child_process';
import type { AgentSandbox, EngineStatus } from '../shared/protocol.js';
import type { SetupKey, SetupStatus, SetupTool, SetupToolId } from '../shared/setup.js';
import { EXTRA_ENGINE_FACTS } from '../shared/cli-engines.js';
import { checkEngine, checkExtraEngine, resolveExecutable, type EngineRunner } from './engines.js';
import { buildGhEnv } from './env.js';
import { findTailscale, TAILSCALE_PATHS } from './remote/tailscale.js';

// v1.2 first-run setup: what is installed and ready, checked the way AI Term checks engines anyway. A tool is found on
// PATH and run only with --version or its own documented status command (claude auth status, codex login status, gh auth
// status), as an argument list, with a short timeout. AI Term never reads a tool's config or credential files; a tool
// that hangs or fails says "couldn't check", and nothing it prints reaches the screen except a version number.
export const SETUP_TIMEOUT_MS = 3000;
const OUTPUT_MAX = 64 * 1024;
export interface SetupDeps { env: NodeJS.ProcessEnv; keys: SetupKey[]; sandbox: AgentSandbox; timeoutMs?: number; platform?: NodeJS.Platform; tailscaleCandidates?: readonly string[] }

// Its own runner rather than execFile's timeout: a CLI whose child keeps the pipes open would hold execFile's callback
// past its timeout. This one answers when the time is up and kills the process. Terminal escapes are stripped first.
// eslint-disable-next-line no-control-regex -- removing terminal escapes is the point.
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
function runner(limit: number): EngineRunner {
  return (file, args, options) => new Promise(resolve => {
    let stdout = '', stderr = '', settled = false;
    const done = (code: number | null) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, stdout: stdout.replace(ESCAPES, ''), stderr: stderr.replace(ESCAPES, '') }); };
    const child = spawn(file, args, { env: options.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(null); }, Math.min(options.timeout, limit));
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < OUTPUT_MAX) stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < OUTPUT_MAX) stderr += chunk.toString('utf8'); });
    child.on('error', () => done(null));
    child.on('close', code => done(code));
  });
}
const versionOf = (text: string) => text.match(/\b(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)\b/)?.[1] ?? null;

const NAMES: Readonly<Record<SetupToolId, string>> = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini CLI', copilot: 'Copilot CLI', gh: 'GitHub CLI (gh)', tailscale: 'Tailscale', ollama: 'Ollama', lmstudio: 'LM Studio' };
function install(id: SetupToolId, platform: NodeJS.Platform): string {
  switch (id) {
    case 'claude-code': return 'npm install -g @anthropic-ai/claude-code';
    case 'codex': return 'npm install -g @openai/codex';
    case 'cursor': case 'gemini': case 'copilot': return EXTRA_ENGINE_FACTS[id].install;
    case 'gh': return platform === 'darwin' ? 'brew install gh' : 'see cli.github.com for your system';
    case 'tailscale': return 'install it from tailscale.com';
    case 'ollama': return 'install it from ollama.com';
    case 'lmstudio': return 'install LM Studio from lmstudio.ai; its lms command comes with it';
  }
}
function fromEngine(id: SetupToolId, status: EngineStatus, platform: NodeJS.Platform, extra: boolean): SetupTool {
  const base = { id, name: NAMES[id], install: install(id, platform) };
  if (!status.installed) return { ...base, found: status.error ? "couldn't check" : 'not found', version: null, login: null };
  if (status.error === 'Engine version check failed' || status.error === 'Engine executable check failed') return { ...base, found: "couldn't check", version: null, login: null };
  return { ...base, found: 'found', version: status.version, login: extra ? 'logs in when it starts' : status.loggedIn === true ? 'logged in' : status.loggedIn === false ? 'not logged in' : "couldn't check" };
}
// gh, Tailscale, Ollama and LM Studio: the version, and for gh its own auth status (0 logged in, 1 not).
async function probe(id: SetupToolId, path: string | null, run: EngineRunner, env: Record<string, string>, limit: number, platform: NodeJS.Platform): Promise<SetupTool> {
  const base = { id, name: NAMES[id], install: install(id, platform) };
  if (!path) return { ...base, found: 'not found', version: null, login: null };
  const options = { env, timeout: limit, maxBuffer: OUTPUT_MAX };
  const version = await run(path, id === 'tailscale' ? ['version'] : id === 'lmstudio' ? ['version'] : ['--version'], options);
  const number = version.code === 0 ? versionOf(version.stdout + version.stderr) : null;
  if (version.code !== 0 || !number) return { ...base, found: "couldn't check", version: null, login: null };
  if (id !== 'gh') return { ...base, found: 'found', version: number, login: null };
  const auth = await run(path, ['auth', 'status'], options);
  return { ...base, found: 'found', version: number, login: auth.code === 0 ? 'logged in' : auth.code === 1 ? 'not logged in' : "couldn't check" };
}

export async function setupStatus(deps: SetupDeps): Promise<SetupStatus> {
  const limit = deps.timeoutMs ?? SETUP_TIMEOUT_MS, platform = deps.platform ?? process.platform, run = runner(limit), path = deps.env.PATH ?? '';
  const find = (name: string) => resolveExecutable(name, path, platform);
  const ghEnv = buildGhEnv(deps.env), plainEnv = Object.fromEntries(['PATH', 'HOME', 'LANG'].flatMap(k => deps.env[k] ? [[k, deps.env[k] ?? '']] : []));
  const [claude, codex, cursor, gemini, copilot, gh, tailscale, ollama, lmstudio] = await Promise.all([
    checkEngine('claude-code', deps.env, run), checkEngine('codex', deps.env, run),
    checkExtraEngine('cursor', deps.env, run), checkExtraEngine('gemini', deps.env, run), checkExtraEngine('copilot', deps.env, run),
    find('gh').then(p => probe('gh', p, run, ghEnv, limit, platform)),
    find('tailscale').then(async p => p ?? await findTailscale(deps.tailscaleCandidates ?? TAILSCALE_PATHS)).then(p => probe('tailscale', p, run, plainEnv, limit, platform)),
    find('ollama').then(p => probe('ollama', p, run, plainEnv, limit, platform)),
    find('lms').then(p => probe('lmstudio', p, run, plainEnv, limit, platform)),
  ]);
  return {
    tools: [fromEngine('claude-code', claude, platform, false), fromEngine('codex', codex, platform, false), fromEngine('cursor', cursor, platform, true), fromEngine('gemini', gemini, platform, true), fromEngine('copilot', copilot, platform, true), gh, tailscale, ollama, lmstudio],
    keys: deps.keys.map(k => ({ label: k.label, provider: k.provider, last4: k.last4 })),
    sandbox: deps.sandbox.dontAsk ? platform === 'darwin' ? 'sandbox-exec' : platform === 'linux' ? 'bwrap' : 'none' : 'none',
    sandboxNote: deps.sandbox.dontAsk && (platform === 'darwin' || platform === 'linux') ? null : deps.sandbox.note ?? "AI Term couldn't check for one",
  };
}
