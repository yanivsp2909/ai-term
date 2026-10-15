import { extensionManifest, type ExtensionAccess, type ExtensionCatalog, type ExtensionFile } from '../shared/extensions.js';
import { mcpManifest, mcpPreview, type McpAccess, type McpCatalog, type McpView } from '../shared/mcp.js';
import { isMcpName, isMcpTool, validateMcpObject } from '../shared/validate.js';
import { Transcript as ChildTranscript } from './transcript.js';
import { streamText, tool, jsonSchema, isStepCount, APICallError, RetryError, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { readTool, writeTool, editTool, searchTool, ToolError, type GatedTool } from './tools.js';
import { runBash, bashReport, bashPreview, checkCommand, BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS } from './bash.js';
import { JailError } from './jail.js';
import { ProviderError } from './provider.js';
import type { StreamRedactor } from './display.js';
import { systemPrompt, type Instructions } from './instructions.js';
import type { Reporter } from './report.js';
import type { Transcript } from './transcript.js';
import { RunLimits, maxOutputTokens, requestCost, estimateTokens, refusalPause, pricePauseText, NOT_ANSWERING, type Pause } from './limits.js';
import type { ModelPrice } from '../shared/protocol.js';
import { PRICED_BY_YOU } from '../shared/prices.js';
import type { PriceSaved } from './report.js';
import type { AgentFacts } from '../shared/agent-facts.js';
import { COMPACT_OUTPUT_LOW, COMPACT_OUTPUT_TOKENS, compactedHistory, compactPrompt, KEEP_TURNS, splitHistory } from './compact.js';

export type AgentPermission = 'ask' | 'dontAsk';
export type ToolName = 'read' | 'write' | 'edit' | 'bash' | 'search' | 'skill' | 'task' | 'mcp_tools' | 'mcp_call';
// What the agent shows. The terminal UI implements it; tests record it.
export interface AgentIO {
  text(delta: string): void;
  toolStart(tool: ToolName, summary: string): void;
  toolEnd(tool: ToolName, outcome: 'ok' | 'denied' | 'failed', summary: string): void;
  // Resolves false when the user says no, presses Esc, or the turn is interrupted.
  approve(request: { title: string; body: string }, signal: AbortSignal): Promise<boolean>;
  confirmJob?(request: {title:string;body:string}, signal:AbortSignal):Promise<boolean>;
  approveMcp?(request:{title:string;body:string},signal:AbortSignal):Promise<'allow'|'deny'|'session'>;
  note(text: string, tone?: 'info' | 'warn' | 'error'): void;
  // A limit pause: resolves true to go on (a typed ⏎, or a price saved with p or m), false to stop (Esc, a kill, or the
  // turn ending).
  pause(text: string, signal: AbortSignal, actions?: PauseActions): Promise<boolean>;
}
// B28: what a price pause offers besides ⏎ and Esc: p (your price for this model, the catalog's closest model as a guess to
// check) and, for a Foundry deployment, m (which catalog model it is). save resolves false when nothing was saved.
export interface PauseActions {
  price?: { model: string; guess: { model: string; price: ModelPrice } | null; save(price: ModelPrice): Promise<PriceSaved> };
  map?: { model: string; save(catalog: string): Promise<boolean> };
}
export interface AgentOptions {
  root: string; permission: AgentPermission; model: LanguageModel; modelId: string; instructions: Instructions;
  reporter: Reporter; transcript: Transcript; io: AgentIO; redact: (text: string) => string;
  // Streamed model text: a key split across deltas is still caught (display.ts). Without one, each delta is redacted alone.
  redactStream?: () => StreamRedactor;
  bashEnv: Record<string, string>; rg: string | null; maxSteps?: number;
  // AI Term's own folder, kept out of reach of every bash command (bash.ts).
  bashSandbox?: { home: string };
  extensions?: ExtensionAccess; models?: readonly string[]; makeModel?(id: string): Promise<LanguageModel>;
  limits?: RunLimits; child?: boolean;
  mcp?:McpAccess; mcpSession?:{allowed:Set<string>;schemas:Set<string>};
}
export type TurnResult = 'done' | 'interrupted' | 'failed';
// B25: a refused reservation is checked again with fresh facts this many times before the run pauses on it.
const DEFAULT_MAX_STEPS = 50, CONTEXT_WARN = 85, MAX_REFUSALS = 3;
// Reasons a failed turn shows and reports; the same fixed words Claude's StopFailure uses, never the provider's text.
type FailureKind = 'rate_limit' | 'overloaded' | 'authentication_failed' | 'billing_error' | 'invalid_request' | 'server_error' | 'unknown';
const FAILURE_TEXT: Record<FailureKind, string> = { rate_limit: 'rate limited; try again shortly', overloaded: 'the provider is overloaded', authentication_failed: 'the key was refused; test it in /settings', billing_error: 'billing problem on the provider account', invalid_request: 'the provider refused the request', server_error: 'the provider had an error', unknown: "couldn't reach the provider" };

function failureKind(error: unknown): FailureKind {
  const status = APICallError.isInstance(error) ? error.statusCode : undefined;
  if (status === 401 || status === 403) return 'authentication_failed';
  if (status === 402) return 'billing_error';
  if (status === 429) return 'rate_limit';
  if (status === 503 || status === 529) return 'overloaded';
  if (status !== undefined && status >= 500) return 'server_error';
  if (status !== undefined && status >= 400) return 'invalid_request';
  return 'unknown';
}
// What a failed tool call tells the model: AI Term's own fixed reasons, or just the system error code.
function toolFailure(error: unknown): string {
  if (error instanceof ToolError || error instanceof JailError) return error.message;
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return `failed (${error.code})`;
  return 'failed';
}

// Small hand-written schemas: the model sees JSON Schema, and every call is checked here before a tool runs.
type Fields = Record<string, 'string' | 'number' | 'boolean'>;
function schema<T>(required: Fields, optional: Fields, describe: Record<string, string>) {
  const properties = Object.fromEntries(Object.entries({ ...required, ...optional }).map(([name, type]) => [name, { type, description: describe[name] ?? name }]));
  return jsonSchema<T>({ type: 'object', properties, required: Object.keys(required), additionalProperties: false }, {
    validate: value => {
      const ok = !!value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([name, field]) => name in required || name in optional ? typeof field === (required[name] ?? optional[name]) : false) && Object.keys(required).every(name => name in (value as object));
      return ok ? { success: true, value: value as T } : { success: false, error: new Error('Invalid tool input') };
    },
  });
}

export class Agent {
  history: ModelMessage[] = [];
  readonly limits: RunLimits;
  private catalog: ExtensionCatalog = {items:[],notes:[],tokens:0};
  private mcpCatalog:McpCatalog={servers:[],notes:[],tokens:0};
  private readonly mcpSession:{allowed:Set<string>;schemas:Set<string>};
  private loadedSignature: string | null = null;
  private currentWorst = 0;
  private confirmedMcp:{server:McpView;input:string}|null=null;
  private confirmedTask: {file:ExtensionFile;modelId:string;name:string;prompt:string} | null = null;
  private warned = false;
  private usageWarned = false;
  private lastReply = '';
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private options: AgentOptions) { this.limits = options.limits ?? new RunLimits(); this.limits.ledger = !!options.reporter.reserve;this.mcpSession=options.mcpSession??{allowed:new Set(),schemas:new Set()}; }
  get extensionAccess(): ExtensionAccess | undefined { return this.options.extensions; }
  get mcpAccess():McpAccess|undefined{return this.options.mcp;}
  stopMcp():Promise<void>{return this.options.mcp?.stop()??Promise.resolve();}
  get root(): string { return this.options.root; }
  get modelId(): string { return this.options.modelId; }
  // The new model's context window applies from its first request; until then the card shows no stale percentage.
  setModel(model: LanguageModel, modelId: string): void { this.options = { ...this.options, model, modelId }; void this.options.reporter.status({ event: 'context', percent: null }); void this.options.transcript.append({ kind: 'model', model: modelId }); void this.options.reporter.status({ event: 'model', model: modelId }); }
  setRoot(root: string, instructions: Instructions): void { this.options = { ...this.options, root, instructions }; }

  // Tool calls run one at a time, so approvals never overlap even when the model asks for several at once.
  private serial<T>(work: () => Promise<T>): Promise<T> { const next = this.queue.then(work, work); this.queue = next.then(() => undefined, () => undefined); return next; }

  private run<T>(name: ToolName, summary: (input: T) => string, work: (input: T, signal: AbortSignal) => Promise<string>, gate?: (input: T, signal:AbortSignal) => Promise<{ title: string; body: string; sessionKey?:string }>, alwaysAsk = false) {
    return async (input: T, signal: AbortSignal): Promise<string> => this.serial(async () => {
      const { io, reporter, transcript, redact, permission } = this.options, shown = redact(summary(input));
      if (signal.aborted) return 'Interrupted by the user.';
      await reporter.status({ event: 'tool-start', tool: name });
      io.toolStart(name, shown); void transcript.append({ kind: 'tool-call', tool: name, input: JSON.stringify(input) });
      let outcome: 'ok' | 'denied' | 'failed' = 'failed', output = '';
      try {
        if (gate && (permission === 'ask' || alwaysAsk)) {
          const request = await gate(input,signal);
          if(name==='mcp_call'&&request.sessionKey&&this.mcpSession.allowed.has(request.sessionKey)){
            if(signal.aborted)return 'Interrupted by the user.';
            output=redact(await work(input,signal));outcome='ok';return output;
          }
          // The daemon has the waiting status before the question is drawn, so /send can never answer it (D50).
          await reporter.status({ event: 'permission' });
          const shownRequest={title:redact(request.title),body:redact(request.body)};
          let allowed:boolean;
          if(name==='mcp_call'&&io.approveMcp){const choice=await io.approveMcp(shownRequest,signal);allowed=choice!=='deny';if(choice==='session'&&request.sessionKey&&!signal.aborted)this.mcpSession.allowed.add(request.sessionKey);}
          else{const approve=alwaysAsk&&name==='task'&&io.confirmJob?io.confirmJob.bind(io):io.approve.bind(io);allowed=await approve(shownRequest,signal);}
          await reporter.status({ event: 'answered' });
          if (!allowed||signal.aborted) { outcome = 'denied'; output = signal.aborted ? 'Interrupted by the user.' : 'The user denied this. Do not retry it; ask what to do instead.'; return output; }
        }
        output = redact(await work(input, signal)); outcome = 'ok'; return output;
      } catch (error) { output = `Error: ${toolFailure(error)}`; return output; }
      finally {
        io.toolEnd(name, outcome, outcome === 'ok' ? output.split('\n')[0]?.slice(0, 120) ?? '' : outcome === 'denied' ? 'denied' : output.slice(0, 120));
        void transcript.append({ kind: 'tool-result', tool: name, ok: outcome === 'ok', output });
        await reporter.status({ event: 'tool-finish', tool: name });
      }
    });
  }
  private gated<T>(name: ToolName, summary: (input: T) => string, gatedTool: GatedTool<T>) {
    return this.run<T>(name, summary, input => gatedTool.run(this.options.root, input), input => gatedTool.preview(this.options.root, input));
  }

  private mcpKey(server:McpView,tool:string):string{return JSON.stringify([server.id,server.hash,tool]);}
  private async mcpServer(name:string,signal:AbortSignal):Promise<McpView>{
    const access=this.options.mcp;if(!access||!isMcpName(name))throw new ToolError('MCP unavailable');
    const server=(await access.list(this.root)).servers.find(s=>s.config.name===name&&s.enabled&&!s.note);if(!server)throw new ToolError('MCP server is disabled or unavailable');
    if(!server.approved){
      await this.options.reporter.status({event:'permission'});
      const allowed=await this.options.io.approve({title:`MCP server ${name}`,body:mcpPreview(server)},signal);
      await this.options.reporter.status({event:'answered'});
      if(!allowed||signal.aborted)throw new ToolError('The user denied the MCP server. Do not retry it.');
      await access.approve(this.root,server.id,server.hash);
    }
    if(signal.aborted)throw new ToolError('MCP call interrupted');return server;
  }
  private mcpTools():ToolSet{
    if(!this.options.mcp)return {};
    const select=this.run<{server:string;tool?:string}>('mcp_tools',i=>i.server+(i.tool?'/'+i.tool:''),async(i,signal)=>{
      const server=await this.mcpServer(i.server,signal),access=this.options.mcp;if(!access)throw new ToolError('MCP unavailable');
      if(i.tool){if(!isMcpTool(i.tool))throw new ToolError('Invalid MCP tool');const schema=await access.schema(this.root,server.id,server.hash,i.tool,signal);this.mcpSession.schemas.add(this.mcpKey(server,i.tool));return JSON.stringify(schema);}
      return mcpManifest(await access.discover(this.root,server.id,server.hash,signal));
    });
    const call=this.run<{server:string;tool:string;arguments:Record<string,unknown>}>('mcp_call',i=>i.server+'/'+i.tool,async(i,signal)=>{
      const confirmed=this.confirmedMcp;this.confirmedMcp=null;const access=this.options.mcp;if(!confirmed||!access||confirmed.input!==JSON.stringify(i))throw new ToolError('MCP call was not approved');
      const server=(await access.list(this.root)).servers.find(s=>s.id===confirmed.server.id&&s.hash===confirmed.server.hash&&s.enabled&&!s.note&&s.tools[i.tool]!==false);if(!server||signal.aborted)throw new ToolError('MCP configuration changed or call interrupted');return access.call(this.root,server.id,server.hash,i.tool,validateMcpObject(i.arguments),signal);
    },async(i,signal)=>{this.confirmedMcp=null;const server=await this.mcpServer(i.server,signal);if(!isMcpTool(i.tool)||!this.mcpSession.schemas.has(this.mcpKey(server,i.tool)))throw new ToolError('Load this MCP tool schema with mcp_tools first');validateMcpObject(i.arguments);this.confirmedMcp={server,input:JSON.stringify(i)};return {title:`MCP ${i.server}/${i.tool}`,body:`folder: ${this.root}\nserver: ${i.server}\ntool: ${i.tool}\narguments: ${JSON.stringify(i.arguments,null,2)}`,sessionKey:this.mcpKey(server,i.tool)};},true);
    return {
      mcp_tools:tool({description:'Select an enabled MCP server to list tool names/descriptions, or select one tool to load its full input schema. Project servers require user approval before starting.',inputSchema:schema<{server:string;tool?:string}>({server:'string'},{tool:'string'},{}),execute:(input,{abortSignal})=>select(input,abortSignal??new AbortController().signal)}),
      mcp_call:tool({description:'Call a selected MCP tool after loading its schema with mcp_tools. Every call asks unless the user explicitly allows this exact tool for this session.',inputSchema:jsonSchema<{server:string;tool:string;arguments:Record<string,unknown>}>({type:'object',properties:{server:{type:'string'},tool:{type:'string'},arguments:{type:'object'}},required:['server','tool','arguments'],additionalProperties:false},{validate:value=>{try{if(!value||typeof value!=='object'||Array.isArray(value)||!('server'in value)||!isMcpName(value.server)||!('tool'in value)||!isMcpTool(value.tool)||!('arguments'in value)||Object.keys(value).some(k=>!['server','tool','arguments'].includes(k)))throw new Error('invalid');validateMcpObject(value.arguments);return {success:true,value:value as {server:string;tool:string;arguments:Record<string,unknown>}};}catch{return {success:false,error:new Error('Invalid MCP input')};}}}),execute:(input,{abortSignal})=>call(input,abortSignal??new AbortController().signal)}),
    };
  }
  private tools(): ToolSet {
    const read = this.run<{ path: string; offset?: number; limit?: number }>('read', i => i.path, i => readTool(this.options.root, i));
    const write = this.gated<{ path: string; content: string }>('write', i => i.path, writeTool);
    const edit = this.gated<{ path: string; old: string; new: string; replaceAll?: boolean }>('edit', i => i.path, editTool);
    const search = this.run<{ pattern: string; path?: string }>('search', i => i.pattern + (i.path ? ` in ${i.path}` : ''), i => searchTool(this.options.root, i, this.options.rg));
    const timeout = (seconds?: number) => Math.min(BASH_MAX_TIMEOUT_MS, Math.max(1000, (seconds ?? BASH_DEFAULT_TIMEOUT_MS / 1000) * 1000));
    const bash = this.run<{ command: string; timeoutSeconds?: number }>('bash', i => i.command.split('\n')[0] ?? '', async (i, signal) => {
      const ms = timeout(i.timeoutSeconds);
      return bashReport(await runBash(checkCommand(i.command), { cwd: this.options.root, env: this.options.bashEnv, timeoutMs: ms, signal, ...(this.options.bashSandbox ? { sandbox: this.options.bashSandbox } : {}) }), ms);
    }, async i => bashPreview(checkCommand(i.command), timeout(i.timeoutSeconds)));
    const skill = this.run<{name:string}>('skill', i=>i.name, async i=>(await this.extension(i.name,'skill')).body);
    const task = this.run<{name:string;prompt:string}>('task', i=>i.name, async (i,signal)=>this.subagent(i.name,i.prompt,signal), async i=>this.taskPreview(i.name,i.prompt), true);
    return {
      ...this.mcpTools(),
      ...(this.options.extensions ? {
        skill: tool({description:'Load an enabled skill by name. Only the listed name and description are initially loaded; use this to read its full instructions.',inputSchema:schema<{name:string}>({name:'string'}, {}, {}),execute:(input,{abortSignal})=>skill(input,abortSignal??new AbortController().signal)}),
        ...(!this.options.child ? {task:tool({description:'Run an enabled subagent by name in a separate conversation. Its instructions, folder and permissions are fixed; only its final answer returns. The user confirms the job before it spends tokens.',inputSchema:schema<{name:string;prompt:string}>({name:'string',prompt:'string'}, {}, {}),execute:(input,{abortSignal})=>task(input,abortSignal??new AbortController().signal)})} : {}),
      } : {}),
      read: tool({ description: 'Read a text file in the folder, with line numbers. Use offset and limit for long files.', inputSchema: schema<{ path: string; offset?: number; limit?: number }>({ path: 'string' }, { offset: 'number', limit: 'number' }, { path: 'File path, relative to the folder', offset: 'First line (1-based)', limit: 'Number of lines' }), execute: (input, { abortSignal }) => read(input, abortSignal ?? new AbortController().signal) }),
      write: tool({ description: 'Create or overwrite a whole file in the folder.', inputSchema: schema<{ path: string; content: string }>({ path: 'string', content: 'string' }, {}, { path: 'File path, relative to the folder', content: 'The complete new file content' }), execute: (input, { abortSignal }) => write(input, abortSignal ?? new AbortController().signal) }),
      edit: tool({ description: 'Replace exact text in a file. old must match exactly once unless replaceAll is true.', inputSchema: schema<{ path: string; old: string; new: string; replaceAll?: boolean }>({ path: 'string', old: 'string', new: 'string' }, { replaceAll: 'boolean' }, { path: 'File path, relative to the folder', old: 'Exact existing text', new: 'Replacement text', replaceAll: 'Replace every match' }), execute: (input, { abortSignal }) => edit(input, abortSignal ?? new AbortController().signal) }),
      bash: tool({ description: 'Run a shell command in the folder with /bin/sh -c. No stdin; output is capped.', inputSchema: schema<{ command: string; timeoutSeconds?: number }>({ command: 'string' }, { timeoutSeconds: 'number' }, { command: 'The command line', timeoutSeconds: 'Time limit in seconds (default 120, at most 600)' }), execute: (input, { abortSignal }) => bash(input, abortSignal ?? new AbortController().signal) }),
      search: tool({ description: this.options.rg ? 'Search file contents in the folder for a regular expression (ripgrep; respects .gitignore).' : 'Search file contents in the folder for plain text.', inputSchema: schema<{ pattern: string; path?: string }>({ pattern: 'string' }, { path: 'string' }, { pattern: this.options.rg ? 'Regular expression' : 'Plain text', path: 'Folder or file to search, relative to the folder' }), execute: (input, { abortSignal }) => search(input, abortSignal ?? new AbortController().signal) }),
    };
  }

  // One message from the user: model requests and tool rounds until the model answers, the user interrupts, or a limit
  // pause ends in a stop. Every request is checked first (limits.ts); every request's own usage is priced and counted.
  async turn(prompt: string, signal: AbortSignal): Promise<TurnResult> {
    try { await this.refreshExtensions(); }
    catch {
      if (signal.aborted) return 'interrupted';
      void this.options.transcript.append({ kind: 'note', text: 'extension refresh failed; turn stopped before a model request' });
      await this.options.reporter.status({ event: 'turn-failed', error: 'unknown' });
      return 'failed';
    }
    const { io, reporter, transcript, redact } = this.options, user: ModelMessage = { role: 'user', content: prompt };
    void transcript.append({ kind: 'user', text: prompt });
    await reporter.status({ event: 'turn-start' });
    // The turn's own signal: the user's Esc or kill, or a stop chosen at a limit pause.
    const controller = new AbortController(), stop = () => controller.abort();
    signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
    let stepText = '', lastText = '', streamError: unknown, facts = await reporter.facts(this.options.modelId), open = 0, started = false, grant: string | null = null;
    // B25: every grant is settled exactly once: released when its usage was reported, booked at its worst case otherwise.
    const settle = (worstCase: boolean | Promise<boolean>): void => { const id = grant; grant = null; if (id) void reporter.settle?.(id, worstCase); };
    const totals = { input: 0, cached: 0, output: 0, reasoning: 0, cost: 0 as number | null, requests: 0 };
    const manifest = [extensionManifest(this.catalog.items),mcpManifest(this.mcpCatalog)].filter(Boolean).join('\n');
    const system = systemPrompt(this.options.root, this.options.instructions, { search: this.options.rg ? 'ripgrep regular expressions' : 'plain text' }) + (manifest ? '\n\n# Enabled extensions (skill loads skills; task runs agents; mcp_tools loads MCP metadata/schema then mcp_call calls one tool)\n' + manifest : '');
    const stream = this.options.redactStream?.() ?? { push: redact, flush: () => '' };
    // What the stream held back (a possible start of the key) is shown once the step or the turn ends.
    const release = () => { const rest = stream.flush(); if (rest) { stepText += rest; io.text(rest); } };
    const finishInterrupted = async (): Promise<TurnResult> => {
      release();
      // A request cut off after it was sent may still be billed; its worst case counts against this run and the budgets.
      if (open) { this.limits.chargeUnfinished(open); open = 0; }
      settle(true);
      // The partial reply stays in the conversation, marked, so the next turn knows what was cut off.
      this.history.push(user, { role: 'assistant', content: `${lastText || stepText}\n(The user interrupted this reply.)`.trim() });
      void transcript.append({ kind: 'note', text: 'interrupted' });
      this.turnCost(totals);
      this.lastReply = lastText || stepText; await reporter.status({ event: 'done', reply: this.lastReply });
      return 'interrupted';
    };
    try {
      const result = streamText({
        model: this.options.model, system, messages: [...this.history, user], tools: this.tools(), stopWhen: isStepCount(this.options.maxSteps ?? DEFAULT_MAX_STEPS),
        abortSignal: controller.signal, toolCallConcurrency: 1, maxRetries: 2,
        // Before every request: caps, budgets and a known price, with a pause that asks when one says no (D49, D53).
        prepareStep: async ({ messages }) => {
          const cleared = await this.clearance(estimateTokens(system + JSON.stringify(messages)), controller);
          facts = cleared.facts; grant = cleared.grant;
          open = this.limits.lastWorst; this.currentWorst = open; started = false;
          // The request carries exactly the output allowance its check priced: sized to what is left of the run cap and the
          // budgets, never above the model's limit (capped at 32k, else 16k). With none, a provider may write up to its own
          // maximum and one request could pass every cap (v0.4 gate). A model whose real limit is below 16k refuses;
          // marking its catalog model in /settings gives the agent that limit.
          return { maxOutputTokens: this.limits.lastMaxOutput };
        },
        // The SDK's default handler prints the error, whose text can carry anything the provider sent, to stderr, which
        // here is the agent's terminal. The same error arrives as the stream's error part below and is handled there.
        onError: ({ error }) => { streamError ??= error; },
      });
      for await (const part of result.stream) {
        // The first part of a step arrives once the provider has answered: from here on it may bill the request.
        if (part.type === 'start-step') { stepText = ''; started = true; }
        else if (part.type === 'text-delta') { const text = stream.push(part.text); stepText += text; if (text) io.text(text); }
        else if (part.type === 'finish-step') {
          release();
          if (stepText) lastText = stepText;
          const worst = open; open = 0; started = false; this.currentWorst = 0;
          if (part.usage.inputTokens === undefined && part.usage.outputTokens === undefined) {
            // A billed request the provider sent no counts for: unknown is not free, so its worst case counts (D53).
            this.limits.chargeUnfinished(worst); settle(true);
            Object.assign(totals, { cost: null, requests: totals.requests + 1 });
            io.note(`the provider sent no usage for a request; this run and your budgets count it at its worst case ($${worst.toFixed(3)})`, 'warn');
            continue;
          }
          const input = part.usage.inputTokens ?? 0, output = part.usage.outputTokens ?? 0, cached = Math.min(input, part.usage.inputTokenDetails.cacheReadTokens ?? 0), reasoning = part.usage.outputTokenDetails?.reasoningTokens ?? 0;
          const cost = requestCost(facts?.price ?? null, input, cached, output);
          this.limits.record(cost);
          Object.assign(totals, { input: totals.input + input, cached: totals.cached + cached, output: totals.output + output, reasoning: totals.reasoning + reasoning, cost: totals.cost === null || cost === null ? null : totals.cost + cost, requests: totals.requests + 1 });
          if (input || output) {
            const taken = reporter.usage(this.options.modelId, { input, cached, output, reasoning });
            void taken.then(result => { if (result === false) this.usageLost(cost); });
            settle(taken.then(result => result === false));
          } else settle(false);
          this.context(input, facts);
        }
        else if (part.type === 'error') throw part.error;
        else if (part.type === 'abort') break;
      }
      if (controller.signal.aborted) return await finishInterrupted();
      if (streamError !== undefined) throw streamError;
      this.history.push(user, ...(await result.responseMessages));
      void transcript.append({ kind: 'assistant', text: lastText });
      this.turnCost(totals);
      this.lastReply = lastText; await reporter.status({ event: 'done', reply: lastText });
      return 'done';
    } catch (thrown) {
      if (controller.signal.aborted) return await finishInterrupted();
      release();
      // A request that failed after the provider started answering may still be billed, like one cut off by Esc.
      if (open && started) this.limits.chargeUnfinished(open);
      settle(open > 0 && started);
      open = 0;
      // A retryable failure (429, 5xx) that used up its retries arrives wrapped; its last attempt says what happened.
      const error = RetryError.isInstance(thrown) ? thrown.lastError : thrown;
      const kind = error instanceof ProviderError ? 'unknown' : failureKind(error);
      const status = APICallError.isInstance(error) && error.statusCode ? ` (HTTP ${error.statusCode})` : '';
      io.note(`turn failed: ${FAILURE_TEXT[kind]}${status}`, 'error');
      void transcript.append({ kind: 'note', text: `turn failed: ${kind}${status}` });
      this.turnCost(totals);
      await reporter.status({ event: 'turn-failed', error: kind });
      return 'failed';
    } finally { settle(true); this.currentWorst = 0; signal.removeEventListener('abort', stop); }
  }
  // Asks the daemon for fresh facts and checks them until the request may go; a pause the user answers with Esc (or a
  // kill) stops the turn before anything is sent.
  async refreshExtensions(): Promise<ExtensionCatalog> {
    if (!this.options.extensions&&!this.options.mcp) return this.catalog;
    try {
      const catalog = this.options.extensions?await this.options.extensions.list(this.root):this.catalog;
      if(this.options.mcp){this.mcpCatalog=await this.options.mcp.list(this.root);for(const s of this.mcpCatalog.servers)if(s.note)this.options.io.note(`${s.config.name}: ${s.note}`,'warn');}
      const signature = JSON.stringify([catalog.items.filter(i=>i.enabled).map(i=>[i.id,i.name,i.description]),this.mcpCatalog.servers.filter(s=>s.enabled).map(s=>[s.id,s.hash,Object.entries(s.tools).sort(([a],[b])=>a.localeCompare(b))])]);
      if(this.loadedSignature!==null&&signature!==this.loadedSignature){this.clear();this.options.io.note('extension selection changed; conversation cleared so disabled instructions stop loading');}
      this.loadedSignature=signature; this.catalog=catalog;
    } catch {
      this.catalog={items:[],notes:['extension refresh failed; turn stopped before a model request'],tokens:0};
      this.options.io.note(this.catalog.notes[0]??'extensions unavailable','error');
      // A stale tool result may still contain a now-disabled body. Never send history until selection is known.
      throw new ToolError('Extension refresh failed');
    }
    return this.catalog;
  }
  private async extension(name: string, kind: 'skill'|'agent'|'command'): Promise<ExtensionFile> {
    const access=this.options.extensions; if(!access)throw new ToolError('Extensions unavailable');
    const catalog=await access.list(this.root),item=catalog.items.find(i=>i.kind===kind&&i.name===name&&i.enabled);
    if(!item)throw new ToolError('Extension is disabled or unavailable');
    const file=await access.read(this.root,item.id);
    if(!file.item.enabled||file.item.id!==item.id||file.item.kind!==kind)throw new ToolError('Extension is disabled or unavailable');
    return file;
  }
  async slash(name: string, argument: string): Promise<string | null> {
    if(!this.options.extensions)return null;
    const catalog=await this.options.extensions.list(this.root);
    if(!catalog.items.some(i=>i.kind==='command'&&i.name===name&&i.enabled))return null;
    const file=await this.extension(name,'command');
    return file.body.replace(/\$ARGUMENTS/g,()=>argument);
  }
  private taskModel(file: ExtensionFile): string {
    const requested=file.item.model,models=this.options.models??[this.modelId];
    if(requested&&models.includes(requested)&&(requested===this.modelId||this.options.makeModel))return requested;
    if(requested&&['sonnet','opus','haiku'].includes(requested.toLowerCase())) {
      const matches=models.filter(m=>m.toLowerCase().includes('claude')&&m.toLowerCase().includes(requested.toLowerCase()));
      if(matches.length===1&&this.options.makeModel)return matches[0]??this.modelId;
    }
    return this.modelId;
  }
  private async taskPreview(name: string, prompt: string): Promise<{title:string;body:string}> {
    if(Buffer.byteLength(prompt)>64*1024)throw new ToolError('Task prompt is too large');
    const file=await this.extension(name,'agent'),modelId=this.taskModel(file),facts=await this.options.reporter.facts(modelId);
    this.confirmedTask={file:{...file,item:{...file.item}},modelId,name,prompt};
    const low=estimateTokens(file.body+this.options.instructions.text+prompt+extensionManifest(this.catalog.items)),steps=this.options.maxSteps??DEFAULT_MAX_STEPS;
    const high=steps*(low+steps*(maxOutputTokens(facts)+64*1024)+maxOutputTokens(facts));
    const price=facts?.price?`$0–$${((high+steps*1400)*Math.max(facts.price.input,facts.price.output)/1e6).toFixed(2)}`:'price unknown; spend limits will pause before a request';
    const permission=this.options.permission==='ask'?'Ask permissions':"Don't ask permissions; commands are unsandboxed";
    return {title:`task ${name}`,body:`AI Term · ${modelId}\nestimated ${low.toLocaleString()}–${high.toLocaleString()} tokens (up to ${steps} requests) · ${price}\nSame folder, ${permission}, budget and caps as parent.\n${prompt}`};
  }
  private async subagent(name: string, prompt: string, signal: AbortSignal): Promise<string> {
    const confirmed=this.confirmedTask;this.confirmedTask=null;
    if(!confirmed||confirmed.name!==name||confirmed.prompt!==prompt)throw new ToolError('Task needs confirmation');
    const {file,modelId}=confirmed;
    const catalog=await this.options.extensions?.list(this.root);
    if(!catalog?.items.some(i=>i.id===file.item.id&&i.enabled))throw new ToolError('Extension is disabled or unavailable');
    // The approved instructions/model are immutable, even if the source file changes while the user decides.
    const model=modelId===this.modelId?this.options.model:await this.options.makeModel?.(modelId)??this.options.model;
    const parent=this.options,io:AgentIO={...parent.io,text:()=>undefined,toolStart:(...args)=>parent.io.toolStart(...args),toolEnd:(...args)=>parent.io.toolEnd(...args),approve:(...args)=>parent.io.approve(...args),...(parent.io.approveMcp?{approveMcp:(request,signal)=>parent.io.approveMcp?.(request,signal)??Promise.resolve('deny' as const)}:{}),pause:(...args)=>parent.io.pause(...args),note:(text,tone)=>parent.io.note(`${name}: ${text}`,tone)};
    const reserve=parent.reporter.reserve?.bind(parent.reporter),settleGrant=parent.reporter.settle?.bind(parent.reporter);
    const reporter:Reporter={facts:id=>parent.reporter.facts(id),usage:(id,tokens)=>parent.reporter.usage(id,tokens),...(reserve?{reserve}:{}),...(settleGrant?{settle:settleGrant}:{}),status:async update=>{if(['permission','answered','paused','tool-start','tool-finish'].includes(update.event))await parent.reporter.status(update);}};
    const child=new Agent({...parent,model,modelId,io,reporter,child:true,limits:this.limits,mcpSession:this.mcpSession,instructions:{...parent.instructions,text:parent.instructions.text+'\n\n# Subagent instructions\n'+file.body},transcript:new ChildTranscript(null,parent.redact,()=>parent.io.note('subagent transcript unavailable','error'))});
    // The parent request has been sent but its usage may arrive only after this tool. Reserve its worst case while
    // the child spends, so neither caps nor budgets temporarily forget that in-flight request.
    const reserved = this.currentWorst;
    this.limits.reserved+=reserved;
    try {
      const result=await child.turn(prompt,signal);
      if(result!=='done')return result==='interrupted'?'Subagent interrupted.':'Subagent failed; no final answer.';
      const answer=child.history.at(-1);
      if(answer?.role!=='assistant')return 'Subagent finished without a text answer.';
      return typeof answer.content==='string'?answer.content:answer.content.filter(p=>p.type==='text').map(p=>p.text).join('')||'Subagent finished without a text answer.';
    } finally { this.limits.reserved-=reserved; }
  }
  private async clearance(inputTokens: number, controller: AbortController): Promise<{ facts: AgentFacts | null; grant: string | null }> {
    const { io, reporter } = this.options;
    let refusals = 0;
    for (;;) {
      if (controller.signal.aborted) throw new Error('stopped');
      const facts = await reporter.facts(this.options.modelId);
      let pause = this.limits.check(facts, inputTokens);
      // B25: nothing is sent without the daemon's grant for this request's worst case, which counts every other agent's.
      if (!pause && reporter.reserve) {
        const answer = await reporter.reserve(this.options.modelId, this.limits.lastWorst);
        if (answer && 'grant' in answer) { this.limits.turns++; return { facts, grant: answer.grant.id }; }
        // Another agent took the room between the facts and the grant: a fresh check sizes the request to what is left.
        if (answer && ++refusals < MAX_REFUSALS) continue;
        pause = answer ? refusalPause(answer.refused) : { text: NOT_ANSWERING };
      }
      if (!pause) { this.limits.turns++; return { facts, grant: null }; }
      refusals = 0;
      await reporter.status({ event: 'paused' });
      const { text, actions } = await this.pauseActions(pause);
      const go = await io.pause(text, controller.signal, actions);
      await reporter.status({ event: 'answered' });
      if (!go) { controller.abort(); throw new Error('stopped'); }
      pause.onContinue?.();
    }
  }
  // B28: a price pause asks the daemon for the key's provider and a guess, so the pause offers p (and m on Foundry).
  private async pauseActions(pause: Pause): Promise<{ text: string; actions?: PauseActions }> {
    const { reporter } = this.options, ask = pause.price;
    if (!ask || !reporter.setPrice) return { text: pause.text };
    const info = await reporter.priceInfo?.(ask.model) ?? null, model = ask.model;
    const text = pricePauseText(model, info?.provider ?? null, ask.budgets, ask.modelMax);
    if (!info || !PRICED_BY_YOU.includes(info.provider)) return { text };
    const actions: PauseActions = { price: { model, guess: info.guess, save: price => reporter.setPrice?.(model, price) ?? Promise.resolve('refused' as const) } };
    if (info.provider === 'foundry' && reporter.mapModel) actions.map = { model, save: catalog => reporter.mapModel?.(model, catalog) ?? Promise.resolve(false) };
    return { text, actions };
  }
  // Context % for the card and the bar, and the warning once per crossing of 85% (D55, /settings can turn it off).
  private context(input: number, facts: AgentFacts | null): void {
    if (!facts?.context || !input) return;
    const percent = Math.min(100, Math.round(input / facts.context * 100));
    void this.options.reporter.status({ event: 'context', percent });
    if (percent < CONTEXT_WARN) { this.warned = false; return; }
    if (!this.warned && facts.contextWarning) this.options.io.note(`context ${percent}% · /compact or /clear`, 'warn');
    this.warned = true;
  }
  // The turn's exact cost from the provider's own counts (input, cached, output, reasoning), priced like Usage.
  private turnCost(t: { input: number; cached: number; output: number; reasoning: number; cost: number | null; requests: number }): void {
    if (!t.requests) return;
    const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    this.options.io.note(`turn · ${k(t.input)} in${t.cached ? ` · ${k(t.cached)} cached` : ''} · ${k(t.output)} out${t.reasoning ? ` · ${k(t.reasoning)} reasoning` : ''} · ${t.cost === null ? 'price ?' : `$${t.cost.toFixed(4)}`} · run ${this.limits.describe().replace(/^caps: /, '')}`);
  }
  // A popup takes typed keys (a form's Enter saves and authorizes an MCP server), so while it is open the daemon must
  // refuse /send (D50): it reports a question, and done with the last reply again once it closes.
  popupOpen(open: boolean): Promise<void> { return this.options.reporter.status(open ? { event: 'paused' } : { event: 'done', reply: this.lastReply }); }
  // AI Term didn't take a request's usage: Usage and the daemon's budget totals miss it, so this run keeps counting it.
  private usageLost(cost: number | null): void {
    if (cost) this.limits.unconfirmed(cost);
    if (!this.usageWarned) this.options.io.note("usage isn't reaching AI Term; this run still counts it against your budgets, but Usage may read low", 'warn');
    this.usageWarned = true;
  }
  clear(): void { this.history = []; this.warned = false; void this.options.reporter.status({ event: 'context', percent: 0 }); }
  // v0.7.4 /compact: what it would summarize and cost (D49 asks with this); null when there is nothing older to compact.
  async compactPlan(): Promise<{ older: number; kept: number; model: string; inputTokens: { low: number; high: number }; outputTokens: { low: number; high: number }; priceUsd: { low: number; high: number } | null } | null> {
    const split = splitHistory(this.history);
    if (!split) return null;
    const tokens = estimateTokens(compactPrompt(split.older)), input = { low: Math.round(tokens * 0.8), high: Math.round(tokens * 1.25) };
    const output = { low: COMPACT_OUTPUT_LOW, high: COMPACT_OUTPUT_TOKENS }, price = (await this.options.reporter.facts(this.options.modelId))?.price ?? null;
    return { older: split.turns, kept: KEEP_TURNS, model: this.options.modelId, inputTokens: input, outputTokens: output,
      priceUsd: price ? { low: requestCost(price, input.low, 0, output.low) ?? 0, high: requestCost(price, input.high, 0, output.high) ?? 0 } : null };
  }
  // One request on the agent's own model, checked like any turn (caps, budgets, a grant for its worst case) and counted
  // from the provider's own usage; the older turns are replaced only once the summary arrived whole.
  async compact(signal: AbortSignal): Promise<TurnResult> {
    const split = splitHistory(this.history);
    if (!split) return 'failed';
    const { io, reporter } = this.options, prompt = compactPrompt(split.older), controller = new AbortController(), stop = () => controller.abort();
    signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
    let grant: string | null = null, open = 0;
    const settle = (worstCase: boolean | Promise<boolean>): void => { const id = grant; grant = null; if (id) void reporter.settle?.(id, worstCase); };
    try {
      const cleared = await this.clearance(estimateTokens(prompt), controller);
      grant = cleared.grant; open = this.limits.lastWorst;
      const result = streamText({ model: this.options.model, prompt, maxOutputTokens: Math.min(COMPACT_OUTPUT_TOKENS, this.limits.lastMaxOutput), abortSignal: controller.signal, maxRetries: 0 });
      let summary = '', error: unknown;
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') summary += part.text;
        else if (part.type === 'error') { error = part.error; break; }
        else if (part.type === 'finish-step') {
          const input = part.usage.inputTokens ?? 0, output = part.usage.outputTokens ?? 0, cost = requestCost(cleared.facts?.price ?? null, input, 0, output);
          if (part.usage.inputTokens === undefined && part.usage.outputTokens === undefined) { this.limits.chargeUnfinished(open); settle(true); }
          else { this.limits.record(cost); const taken = reporter.usage(this.options.modelId, { input, cached: 0, output, reasoning: 0 }); void taken.then(r => { if (r === false) this.usageLost(cost); }); settle(taken.then(r => r === false)); io.note(`compacted ${split.turns} older turn${split.turns === 1 ? '' : 's'} · ${input} in · ${output} out · ${cost === null ? 'price ?' : `$${cost.toFixed(4)}`}`); }
          open = 0;
        }
      }
      if (controller.signal.aborted) { if (open) this.limits.chargeUnfinished(open); io.note('compact stopped; the conversation is unchanged'); return 'interrupted'; }
      if (error !== undefined || !summary.trim()) { if (open) this.limits.chargeUnfinished(open); io.note('compact failed; the conversation is unchanged', 'error'); return 'failed'; }
      // A request the provider sent no usage for: unknown is not free, its worst case counts (D53).
      if (open) { this.limits.chargeUnfinished(open); open = 0; }
      this.history = compactedHistory(this.options.redact(summary.trim()), split.kept);
      // The context reading is the summary's now (an estimate until the next request reports it); the 85% note can come again.
      this.warned = false;
      const context = cleared.facts?.context;
      void reporter.status({ event: 'context', percent: context ? Math.min(100, Math.round(estimateTokens(JSON.stringify(this.history)) / context * 100)) : 0 });
      void this.options.transcript.append({ kind: 'note', text: `compacted ${split.turns} older turns` });
      return 'done';
    } catch {
      if (controller.signal.aborted) { io.note('compact stopped; the conversation is unchanged'); return 'interrupted'; }
      if (open) this.limits.chargeUnfinished(open);
      io.note('compact failed; the conversation is unchanged', 'error');
      return 'failed';
    } finally { settle(true); signal.removeEventListener('abort', stop); }
  }
}
