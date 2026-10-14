import { validateExtensionCatalog, validateExtensionFile } from '../shared/validate.js';
import type { ExtensionAccess } from '../shared/extensions.js';
import { request } from 'node:http';
import { parseAgentFacts, type AgentFacts } from '../shared/agent-facts.js';

// What the agent tells the daemon, through the same local receiver the CLIs use (S12): status on /v1/status/ai-term with
// the session's status credential, token usage on /v1/metrics with its usage credential. The daemon maps status onto the
// same reducer events as Claude's hooks, so cards, notifications, `c` and Usage need no special case.
export type AgentStatus =
  | { event: 'turn-start' } | { event: 'tool-start'; tool: string } | { event: 'tool-finish'; tool: string }
  | { event: 'permission' } | { event: 'paused' } | { event: 'answered' } | { event: 'done'; reply: string }
  | { event: 'turn-failed'; error: string } | { event: 'context'; percent: number | null } | { event: 'model'; model: string };
export interface TokenUsage { input: number; cached: number; output: number; reasoning?: number }
export interface ReporterEnv { port: number; status: string; usage?: string }
// A 64 KiB file is returned twice (text and body); JSON escaping can expand each byte sixfold. A 500-item
// catalog also expands multibyte metadata. Keep a bounded response that fits both reader-approved results.
const REQUEST_TIMEOUT_MS = 1000, FACTS_MAX_BYTES = 2 * 1024 * 1024;

export function reporterEnv(env: NodeJS.ProcessEnv): ReporterEnv | null {
  const port = Number(env.AITERM_STATUS_PORT), status = env.AITERM_STATUS_TOKEN, usage = env.AITERM_USAGE_TOKEN;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !status || !/^[a-f0-9]{64}$/.test(status)) return null;
  return { port, status, ...(usage && /^[a-f0-9]{64}$/.test(usage) ? { usage } : {}) };
}

export interface Reporter { status(update: AgentStatus): Promise<void>; usage(model: string, tokens: TokenUsage): Promise<void>; facts(model: string): Promise<AgentFacts | null> }

// Requests go one at a time: the receiver numbers them in arrival order, so overlapping requests could reorder a turn.
// Awaiting status() therefore means the daemon has applied this update and everything before it.
export class HttpReporter implements Reporter, ExtensionAccess {
  private queue: Promise<void> = Promise.resolve();
  private sequence = 0;
  failures = 0;
  constructor(private readonly env: ReporterEnv | null, private readonly onFirstFailure: () => void) {}
  status(update: AgentStatus): Promise<void> { return this.post('/v1/status/ai-term', this.env?.status, JSON.stringify(update)); }
  usage(model: string, tokens: TokenUsage): Promise<void> {
    const now = BigInt(Date.now()) * 1_000_000n + BigInt(this.sequence++ % 1_000_000), time = now.toString();
    const point = (type: string, value: number) => ({ asInt: String(value), startTimeUnixNano: time, timeUnixNano: time, attributes: [{ key: 'type', value: { stringValue: type } }, { key: 'model', value: { stringValue: model } }] });
    // Reasoning is already inside output (it is billed as output); it isn't sent twice.
    const points = [point('input', Math.max(0, tokens.input - tokens.cached)), point('cacheRead', tokens.cached), point('output', tokens.output)];
    const body = { resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'ai_term.token.usage', sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: points } }] }] }] };
    return this.post('/v1/metrics', this.env?.usage, JSON.stringify(body));
  }
  // In the same queue as status and usage: an answer always counts the usage this agent reported before asking.
  async facts(model: string): Promise<AgentFacts | null> {
    const env = this.env;
    if (!env) return Promise.resolve(null);
    const value = await this.query({model});
    return parseAgentFacts(value);
  }
  async list(cwd: string) { const v=await this.query({kind:'extensions.list',cwd}); return validateExtensionCatalog(v && typeof v==='object' && 'extensions' in v ? v.extensions : null); }
  async read(cwd: string, extensionId: string) { const v=await this.query({kind:'extensions.read',cwd,extensionId}); return validateExtensionFile(v && typeof v==='object' && 'extension' in v ? v.extension : null); }
  async toggle(cwd: string, extensionId: string, enabled: boolean) { const v=await this.query({kind:'extensions.toggle',cwd,extensionId,enabled}); return validateExtensionCatalog(v && typeof v==='object' && 'extensions' in v ? v.extensions : null); }
  private query(payload: unknown): Promise<unknown> {
    const env=this.env; if(!env)return Promise.resolve(null);
    const body = JSON.stringify(payload);
    let answer: unknown = null;
    this.queue = this.queue.then(() => new Promise<void>(resolve => {
      const req = request({ hostname: '127.0.0.1', port: env.port, path: '/v1/agent/ai-term', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-ai-term-session': env.status } }, res => {
        const chunks: Buffer[] = []; let bytes = 0;
        res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes <= FACTS_MAX_BYTES) chunks.push(chunk); });
        res.on('end', () => { if (res.statusCode === 200 && bytes <= FACTS_MAX_BYTES) { try { answer = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { answer = null; } } resolve(); });
        res.on('error', () => resolve());
      });
      const timer = setTimeout(() => { req.destroy(); }, REQUEST_TIMEOUT_MS);
      req.on('close', () => { clearTimeout(timer); resolve(); }); req.on('error', () => resolve()); req.end(body);
    }));
    return this.queue.then(() => answer);
  }
  private post(path: string, token: string | undefined, body: string): Promise<void> {
    const env = this.env;
    if (!env || !token) return this.queue;
    this.queue = this.queue.then(() => new Promise<void>(resolve => {
      const fail = () => { if (this.failures++ === 0) this.onFirstFailure(); resolve(); };
      const req = request({ hostname: '127.0.0.1', port: env.port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-ai-term-session': token } }, res => {
        res.resume(); res.on('end', () => { if ((res.statusCode ?? 0) >= 300) fail(); else resolve(); }); res.on('error', fail);
      });
      const timer = setTimeout(() => { req.destroy(); }, REQUEST_TIMEOUT_MS);
      req.on('close', () => clearTimeout(timer)); req.on('error', fail); req.end(body);
    }));
    return this.queue;
  }
}
