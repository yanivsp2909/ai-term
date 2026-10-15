import { isKeyProvider, isValidModelId, validateExtensionCatalog, validateExtensionFile } from '../shared/validate.js';
import type { KeyProvider, ModelPrice } from '../shared/protocol.js';
import type { ExtensionAccess } from '../shared/extensions.js';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mcpAccess } from '../client/mcp.js';
import type { McpAccess, McpRequest } from '../shared/mcp.js';
import { parseAgentFacts, parseBudgetAnswer, type AgentFacts, type BudgetAnswer } from '../shared/agent-facts.js';

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

// usage resolves false when AI Term didn't take the record (a failed post, no usage credential): the agent then keeps
// counting that cost itself, because the budgets the daemon answers with would otherwise forget it.
export interface Reporter {
  status(update: AgentStatus): Promise<void>; usage(model: string, tokens: TokenUsage): Promise<boolean | void>; facts(model: string): Promise<AgentFacts | null>;
  // B25 (v0.6.1): the daemon's grant for one request's worst case (null: no answer, so nothing may be sent), and its
  // settlement once the request is over. Absent only on test reporters with no daemon behind them.
  reserve?(model: string, amountUsd: number): Promise<BudgetAnswer | null>;
  settle?(id: string, worstCase: boolean | Promise<boolean>): Promise<void>;
  // B28, at a price pause: the key's provider and the catalog's closest model (a guess for you to check); your price for
  // this model (only while it has none); which catalog model a Foundry deployment is. false: not saved.
  priceInfo?(model: string): Promise<PriceInfo | null>;
  setPrice?(model: string, price: ModelPrice): Promise<PriceSaved>;
  mapModel?(model: string, catalog: string): Promise<boolean>;
}
// full: you already have the most prices AI Term keeps; refused: anything else (a price set meanwhile, not its model).
export type PriceSaved = 'saved' | 'full' | 'refused';
export interface PriceInfo { provider: KeyProvider; guess: { model: string; price: ModelPrice } | null }
const PRICE_KEYS = ['input', 'output', 'cacheRead'];
function parsePrice(v: unknown): ModelPrice | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>, n = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1e9;
  return Object.keys(p).every(k => PRICE_KEYS.includes(k)) && n(p.input) && n(p.output) && (p.cacheRead === undefined || n(p.cacheRead)) ? p as unknown as ModelPrice : null;
}
export function parsePriceInfo(v: unknown): PriceInfo | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const info = v as Record<string, unknown>, guess = info.guess as Record<string, unknown> | null | undefined;
  if (Object.keys(info).length !== 2 || typeof info.provider !== 'string' || !isKeyProvider(info.provider)) return null;
  if (guess === null) return { provider: info.provider, guess: null };
  if (!guess || typeof guess !== 'object' || Object.keys(guess).length !== 2 || typeof guess.model !== 'string' || !isValidModelId(guess.model)) return null;
  const price = parsePrice(guess.price);
  return price ? { provider: info.provider, guess: { model: guess.model, price } } : null;
}

// Requests go one at a time: the receiver numbers them in arrival order, so overlapping requests could reorder a turn.
// Awaiting status() therefore means the daemon has applied this update and everything before it.
export class HttpReporter implements Reporter, ExtensionAccess {
  private queue: Promise<void> = Promise.resolve();
  private sequence = 0;
  failures = 0;
  constructor(private readonly env: ReporterEnv | null, private readonly onFirstFailure: () => void) {}
  get mcp():McpAccess{return mcpAccess((body,signal)=>this.mcpQuery(body,signal));}
  private mcpQuery(payload:McpRequest,signal?:AbortSignal):Promise<{mcp?:unknown;mcpSchema?:unknown;mcpResult?:unknown}>{
    const env=this.env;if(!env)return Promise.reject(new Error('MCP unavailable'));
    return new Promise((resolve,reject)=>{
      const body=JSON.stringify(payload);
      // MCP calls have their own connection; a slow server must never block status, usage or the kill request.
      const req=request({hostname:'127.0.0.1',port:env.port,path:'/v1/mcp/ai-term',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),'x-ai-term-session':env.status}},res=>{
        const chunks:Buffer[]=[];let bytes=0;
        res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes<=FACTS_MAX_BYTES)chunks.push(chunk);else req.destroy();});
        res.on('end',()=>{try{if(res.statusCode!==200||bytes>FACTS_MAX_BYTES)throw new Error('MCP unavailable');const answer:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!answer||typeof answer!=='object'||Array.isArray(answer))throw new Error('MCP unavailable');resolve(answer);}catch{reject(new Error('MCP operation failed'));}});res.on('error',()=>reject(new Error('MCP operation failed')));
      });
      const abort=()=>{req.destroy();void this.mcpQuery({kind:'mcp.cancel'}).catch(()=>this.onFirstFailure());};
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      const timer=setTimeout(()=>req.destroy(),payload.kind==='mcp.call'?125_000:10_000);
      req.on('close',()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(new Error('MCP operation stopped'));});req.on('error',()=>reject(new Error('MCP operation failed')));req.end(body);
    });
  }
  status(update: AgentStatus): Promise<void> { return this.post('/v1/status/ai-term', this.env?.status, JSON.stringify(update)).then(() => undefined); }
  usage(model: string, tokens: TokenUsage): Promise<boolean> {
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
  // The id is ours (v0.6 gate): when no answer comes (the daemon was slow past our timeout), the grant it may still give
  // is cancelled right behind, in the same queue, so it is never held for a request that wasn't sent.
  async reserve(model: string, amountUsd: number): Promise<BudgetAnswer | null> {
    if (!this.env) return null;
    const id = randomUUID(), answer = parseBudgetAnswer(await this.query({ kind: 'budget.reserve', id, model, amountUsd }));
    if (!answer) void this.settle(id, false);
    return answer;
  }
  // In the queue right after the request's usage post: worstCase may wait for whether the daemon took that usage.
  async settle(id: string, worstCase: boolean | Promise<boolean>): Promise<void> {
    await this.query(Promise.resolve(worstCase).then(worst => ({ kind: 'budget.settle', id, worstCase: worst })));
  }
  async priceInfo(model: string): Promise<PriceInfo | null> { return parsePriceInfo(await this.query({ kind: 'price.info', model })); }
  async setPrice(model: string, price: ModelPrice): Promise<PriceSaved> { const answer = await this.query({ kind: 'price.set', model, price }); return !answer || typeof answer !== 'object' ? 'refused' : 'saved' in answer && answer.saved === true ? 'saved' : 'full' in answer && answer.full === true ? 'full' : 'refused'; }
  async mapModel(model: string, catalog: string): Promise<boolean> { const answer = await this.query({ kind: 'price.map', model, catalog }); return !!answer && typeof answer === 'object' && 'saved' in answer && answer.saved === true; }
  async list(cwd: string) { const v=await this.query({kind:'extensions.list',cwd}); return validateExtensionCatalog(v && typeof v==='object' && 'extensions' in v ? v.extensions : null); }
  async read(cwd: string, extensionId: string) { const v=await this.query({kind:'extensions.read',cwd,extensionId}); return validateExtensionFile(v && typeof v==='object' && 'extension' in v ? v.extension : null); }
  async toggle(cwd: string, extensionId: string, enabled: boolean) { const v=await this.query({kind:'extensions.toggle',cwd,extensionId,enabled}); return validateExtensionCatalog(v && typeof v==='object' && 'extensions' in v ? v.extensions : null); }
  private query(payload: unknown): Promise<unknown> {
    const env=this.env; if(!env)return Promise.resolve(null);
    let answer: unknown = null;
    this.queue = this.queue.then(async () => { const body = JSON.stringify(await payload); return new Promise<void>(resolve => {
      const req = request({ hostname: '127.0.0.1', port: env.port, path: '/v1/agent/ai-term', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-ai-term-session': env.status } }, res => {
        const chunks: Buffer[] = []; let bytes = 0;
        res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes <= FACTS_MAX_BYTES) chunks.push(chunk); });
        res.on('end', () => { if (res.statusCode === 200 && bytes <= FACTS_MAX_BYTES) { try { answer = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { answer = null; } } resolve(); });
        res.on('error', () => resolve());
      });
      const timer = setTimeout(() => { req.destroy(); }, REQUEST_TIMEOUT_MS);
      req.on('close', () => { clearTimeout(timer); resolve(); }); req.on('error', () => resolve()); req.end(body);
    }); });
    return this.queue.then(() => answer);
  }
  private post(path: string, token: string | undefined, body: string): Promise<boolean> {
    const env = this.env;
    if (!env || !token) return this.queue.then(() => false);
    let ok = false;
    this.queue = this.queue.then(() => new Promise<void>(resolve => {
      const fail = () => { if (this.failures++ === 0) this.onFirstFailure(); resolve(); };
      const req = request({ hostname: '127.0.0.1', port: env.port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-ai-term-session': token } }, res => {
        res.resume(); res.on('end', () => { if ((res.statusCode ?? 0) >= 300) fail(); else { ok = true; resolve(); } }); res.on('error', fail);
      });
      const timer = setTimeout(() => { req.destroy(); }, REQUEST_TIMEOUT_MS);
      req.on('close', () => clearTimeout(timer)); req.on('error', fail); req.end(body);
    }));
    return this.queue.then(() => ok);
  }
}
