import { request } from 'node:http';

// What the agent tells the daemon, through the same local receiver the CLIs use (S12): status on /v1/status/ai-term with
// the session's status credential, token usage on /v1/metrics with its usage credential. The daemon maps status onto the
// same reducer events as Claude's hooks, so cards, notifications, `c` and Usage need no special case.
export type AgentStatus =
  | { event: 'turn-start' } | { event: 'tool-start'; tool: string } | { event: 'tool-finish'; tool: string }
  | { event: 'permission' } | { event: 'answered' } | { event: 'done'; reply: string }
  | { event: 'turn-failed'; error: string } | { event: 'context'; percent: number } | { event: 'model'; model: string };
export interface TokenUsage { input: number; cached: number; output: number }
export interface ReporterEnv { port: number; status: string; usage?: string }
const REQUEST_TIMEOUT_MS = 1000;

export function reporterEnv(env: NodeJS.ProcessEnv): ReporterEnv | null {
  const port = Number(env.AITERM_STATUS_PORT), status = env.AITERM_STATUS_TOKEN, usage = env.AITERM_USAGE_TOKEN;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !status || !/^[a-f0-9]{64}$/.test(status)) return null;
  return { port, status, ...(usage && /^[a-f0-9]{64}$/.test(usage) ? { usage } : {}) };
}

export interface Reporter { status(update: AgentStatus): Promise<void>; usage(model: string, tokens: TokenUsage): Promise<void> }

// Requests go one at a time: the receiver numbers them in arrival order, so overlapping requests could reorder a turn.
// Awaiting status() therefore means the daemon has applied this update and everything before it.
export class HttpReporter implements Reporter {
  private queue: Promise<void> = Promise.resolve();
  private sequence = 0;
  failures = 0;
  constructor(private readonly env: ReporterEnv | null, private readonly onFirstFailure: () => void) {}
  status(update: AgentStatus): Promise<void> { return this.post('/v1/status/ai-term', this.env?.status, JSON.stringify(update)); }
  usage(model: string, tokens: TokenUsage): Promise<void> {
    const now = BigInt(Date.now()) * 1_000_000n + BigInt(this.sequence++ % 1_000_000), time = now.toString();
    const point = (type: string, value: number) => ({ asInt: String(value), startTimeUnixNano: time, timeUnixNano: time, attributes: [{ key: 'type', value: { stringValue: type } }, { key: 'model', value: { stringValue: model } }] });
    const points = [point('input', Math.max(0, tokens.input - tokens.cached)), point('cacheRead', tokens.cached), point('output', tokens.output)];
    const body = { resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'ai_term.token.usage', sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: points } }] }] }] };
    return this.post('/v1/metrics', this.env?.usage, JSON.stringify(body));
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
