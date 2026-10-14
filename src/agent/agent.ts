import { extensionManifest, type ExtensionAccess, type ExtensionCatalog, type ExtensionFile } from '../shared/extensions.js';
import { Transcript as ChildTranscript } from './transcript.js';
import { streamText, tool, jsonSchema, isStepCount, APICallError, RetryError, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { readTool, writeTool, editTool, searchTool, ToolError, type GatedTool } from './tools.js';
import { runBash, bashReport, bashPreview, checkCommand, BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS } from './bash.js';
import { JailError } from './jail.js';
import { ProviderError } from './provider.js';
import { systemPrompt, type Instructions } from './instructions.js';
import type { Reporter } from './report.js';
import type { Transcript } from './transcript.js';
import { RunLimits, maxOutputTokens, requestCost, estimateTokens } from './limits.js';
import type { AgentFacts } from '../shared/agent-facts.js';

export type AgentPermission = 'ask' | 'dontAsk';
export type ToolName = 'read' | 'write' | 'edit' | 'bash' | 'search' | 'skill' | 'task';
// What the agent shows. The terminal UI implements it; tests record it.
export interface AgentIO {
  text(delta: string): void;
  toolStart(tool: ToolName, summary: string): void;
  toolEnd(tool: ToolName, outcome: 'ok' | 'denied' | 'failed', summary: string): void;
  // Resolves false when the user says no, presses Esc, or the turn is interrupted.
  approve(request: { title: string; body: string }, signal: AbortSignal): Promise<boolean>;
  confirmJob?(request: {title:string;body:string}, signal:AbortSignal):Promise<boolean>;
  note(text: string, tone?: 'info' | 'warn' | 'error'): void;
  // A limit pause: resolves true to go on (a typed ⏎), false to stop (Esc, a kill, or the turn ending).
  pause(text: string, signal: AbortSignal): Promise<boolean>;
}
export interface AgentOptions {
  root: string; permission: AgentPermission; model: LanguageModel; modelId: string; instructions: Instructions;
  reporter: Reporter; transcript: Transcript; io: AgentIO; redact: (text: string) => string;
  bashEnv: Record<string, string>; rg: string | null; maxSteps?: number;
  extensions?: ExtensionAccess; models?: readonly string[]; makeModel?(id: string): Promise<LanguageModel>;
  limits?: RunLimits; child?: boolean;
}
export type TurnResult = 'done' | 'interrupted' | 'failed';
const DEFAULT_MAX_STEPS = 50, CONTEXT_WARN = 85;
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
  private loadedSignature: string | null = null;
  private currentWorst = 0;
  private confirmedTask: {file:ExtensionFile;modelId:string;name:string;prompt:string} | null = null;
  private warned = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private options: AgentOptions) { this.limits = options.limits ?? new RunLimits(); }
  get extensionAccess(): ExtensionAccess | undefined { return this.options.extensions; }
  get root(): string { return this.options.root; }
  get modelId(): string { return this.options.modelId; }
  // The new model's context window applies from its first request; until then the card shows no stale percentage.
  setModel(model: LanguageModel, modelId: string): void { this.options = { ...this.options, model, modelId }; void this.options.reporter.status({ event: 'context', percent: null }); void this.options.transcript.append({ kind: 'model', model: modelId }); void this.options.reporter.status({ event: 'model', model: modelId }); }
  setRoot(root: string, instructions: Instructions): void { this.options = { ...this.options, root, instructions }; }

  // Tool calls run one at a time, so approvals never overlap even when the model asks for several at once.
  private serial<T>(work: () => Promise<T>): Promise<T> { const next = this.queue.then(work, work); this.queue = next.then(() => undefined, () => undefined); return next; }

  private run<T>(name: ToolName, summary: (input: T) => string, work: (input: T, signal: AbortSignal) => Promise<string>, gate?: (input: T) => Promise<{ title: string; body: string }>, alwaysAsk = false) {
    return async (input: T, signal: AbortSignal): Promise<string> => this.serial(async () => {
      const { io, reporter, transcript, redact, permission } = this.options, shown = redact(summary(input));
      if (signal.aborted) return 'Interrupted by the user.';
      await reporter.status({ event: 'tool-start', tool: name });
      io.toolStart(name, shown); void transcript.append({ kind: 'tool-call', tool: name, input: JSON.stringify(input) });
      let outcome: 'ok' | 'denied' | 'failed' = 'failed', output = '';
      try {
        if (gate && (permission === 'ask' || alwaysAsk)) {
          const request = await gate(input);
          // The daemon has the waiting status before the question is drawn, so /send can never answer it (D50).
          await reporter.status({ event: 'permission' });
          const approve = alwaysAsk && io.confirmJob ? io.confirmJob.bind(io) : io.approve.bind(io);
          const allowed = await approve({ title: redact(request.title), body: redact(request.body) }, signal);
          await reporter.status({ event: 'answered' });
          if (!allowed) { outcome = 'denied'; output = signal.aborted ? 'Interrupted by the user.' : 'The user denied this. Do not retry it; ask what to do instead.'; return output; }
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

  private tools(): ToolSet {
    const read = this.run<{ path: string; offset?: number; limit?: number }>('read', i => i.path, i => readTool(this.options.root, i));
    const write = this.gated<{ path: string; content: string }>('write', i => i.path, writeTool);
    const edit = this.gated<{ path: string; old: string; new: string; replaceAll?: boolean }>('edit', i => i.path, editTool);
    const search = this.run<{ pattern: string; path?: string }>('search', i => i.pattern + (i.path ? ` in ${i.path}` : ''), i => searchTool(this.options.root, i, this.options.rg));
    const timeout = (seconds?: number) => Math.min(BASH_MAX_TIMEOUT_MS, Math.max(1000, (seconds ?? BASH_DEFAULT_TIMEOUT_MS / 1000) * 1000));
    const bash = this.run<{ command: string; timeoutSeconds?: number }>('bash', i => i.command.split('\n')[0] ?? '', async (i, signal) => {
      const ms = timeout(i.timeoutSeconds);
      return bashReport(await runBash(checkCommand(i.command), { cwd: this.options.root, env: this.options.bashEnv, timeoutMs: ms, signal }), ms);
    }, async i => bashPreview(checkCommand(i.command), timeout(i.timeoutSeconds)));
    const skill = this.run<{name:string}>('skill', i=>i.name, async i=>(await this.extension(i.name,'skill')).body);
    const task = this.run<{name:string;prompt:string}>('task', i=>i.name, async (i,signal)=>this.subagent(i.name,i.prompt,signal), async i=>this.taskPreview(i.name,i.prompt), true);
    return {
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
    await this.refreshExtensions();
    const { io, reporter, transcript, redact } = this.options, user: ModelMessage = { role: 'user', content: prompt };
    void transcript.append({ kind: 'user', text: prompt });
    await reporter.status({ event: 'turn-start' });
    // The turn's own signal: the user's Esc or kill, or a stop chosen at a limit pause.
    const controller = new AbortController(), stop = () => controller.abort();
    signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
    let stepText = '', lastText = '', streamError: unknown, facts = await reporter.facts(this.options.modelId), open = 0;
    const totals = { input: 0, cached: 0, output: 0, reasoning: 0, cost: 0 as number | null, requests: 0 };
    const manifest = extensionManifest(this.catalog.items);
    const system = systemPrompt(this.options.root, this.options.instructions, { search: this.options.rg ? 'ripgrep regular expressions' : 'plain text' }) + (manifest ? '\n\n# Enabled extensions (load a skill with skill; run an agent with task)\n' + manifest : '');
    const finishInterrupted = async (): Promise<TurnResult> => {
      // A request cut off after it was sent may still be billed; its worst case counts against this run and the budgets.
      if (open) { this.limits.chargeUnfinished(open); open = 0; }
      // The partial reply stays in the conversation, marked, so the next turn knows what was cut off.
      this.history.push(user, { role: 'assistant', content: `${lastText || stepText}\n(The user interrupted this reply.)`.trim() });
      void transcript.append({ kind: 'note', text: 'interrupted' });
      this.turnCost(totals);
      await reporter.status({ event: 'done', reply: lastText || stepText });
      return 'interrupted';
    };
    try {
      const result = streamText({
        model: this.options.model, system, messages: [...this.history, user], tools: this.tools(), stopWhen: isStepCount(this.options.maxSteps ?? DEFAULT_MAX_STEPS),
        // Only a known output limit is sent: a guessed one would make models with smaller limits refuse every request.
        abortSignal: controller.signal, toolCallConcurrency: 1, maxRetries: 2, ...(facts?.output ? { maxOutputTokens: maxOutputTokens(facts) } : {}),
        // Before every request: caps, budgets and a known price, with a pause that asks when one says no (D49, D53).
        prepareStep: async ({ messages }) => {
          facts = await this.clearance(estimateTokens(system + JSON.stringify(messages)), controller);
          open = this.limits.lastWorst; this.currentWorst = open;
          return undefined;
        },
        // The SDK's default handler prints the error, whose text can carry anything the provider sent, to stderr, which
        // here is the agent's terminal. The same error arrives as the stream's error part below and is handled there.
        onError: ({ error }) => { streamError ??= error; },
      });
      for await (const part of result.stream) {
        if (part.type === 'start-step') stepText = '';
        else if (part.type === 'text-delta') { const text = redact(part.text); stepText += text; io.text(text); }
        else if (part.type === 'finish-step') {
          if (stepText) lastText = stepText;
          open = 0; this.currentWorst = 0;
          const input = part.usage.inputTokens ?? 0, output = part.usage.outputTokens ?? 0, cached = Math.min(input, part.usage.inputTokenDetails.cacheReadTokens ?? 0), reasoning = part.usage.outputTokenDetails?.reasoningTokens ?? 0;
          const cost = requestCost(facts?.price ?? null, input, cached, output);
          this.limits.record(cost);
          Object.assign(totals, { input: totals.input + input, cached: totals.cached + cached, output: totals.output + output, reasoning: totals.reasoning + reasoning, cost: totals.cost === null || cost === null ? null : totals.cost + cost, requests: totals.requests + 1 });
          if (input || output) void reporter.usage(this.options.modelId, { input, cached, output, reasoning });
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
      await reporter.status({ event: 'done', reply: lastText });
      return 'done';
    } catch (thrown) {
      if (controller.signal.aborted) return await finishInterrupted();
      // A retryable failure (429, 5xx) that used up its retries arrives wrapped; its last attempt says what happened.
      const error = RetryError.isInstance(thrown) ? thrown.lastError : thrown;
      const kind = error instanceof ProviderError ? 'unknown' : failureKind(error);
      const status = APICallError.isInstance(error) && error.statusCode ? ` (HTTP ${error.statusCode})` : '';
      io.note(`turn failed: ${FAILURE_TEXT[kind]}${status}`, 'error');
      void transcript.append({ kind: 'note', text: `turn failed: ${kind}${status}` });
      this.turnCost(totals);
      await reporter.status({ event: 'turn-failed', error: kind });
      return 'failed';
    } finally { this.currentWorst = 0; signal.removeEventListener('abort', stop); }
  }
  // Asks the daemon for fresh facts and checks them until the request may go; a pause the user answers with Esc (or a
  // kill) stops the turn before anything is sent.
  async refreshExtensions(): Promise<ExtensionCatalog> {
    if (!this.options.extensions) return this.catalog;
    try {
      const catalog = await this.options.extensions.list(this.root);
      const signature = JSON.stringify(catalog.items.filter(i=>i.enabled).map(i=>[i.id,i.name,i.description]));
      if(this.loadedSignature!==null&&signature!==this.loadedSignature){this.clear();this.options.io.note('extension selection changed; conversation cleared so disabled instructions stop loading');}
      this.loadedSignature=signature; this.catalog=catalog;
    } catch { this.catalog={items:[],notes:["extensions couldn't load; none are in this prompt"],tokens:0}; this.options.io.note(this.catalog.notes[0]??'extensions unavailable','warn'); }
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
    return {title:`task ${name}`,body:`AI Term · ${modelId}\nestimated ${low.toLocaleString()}–${high.toLocaleString()} tokens (up to ${steps} requests) · ${price}\nSame folder, Ask permissions, budget and caps as parent.\n${prompt}`};
  }
  private async subagent(name: string, prompt: string, signal: AbortSignal): Promise<string> {
    const confirmed=this.confirmedTask;this.confirmedTask=null;
    if(!confirmed||confirmed.name!==name||confirmed.prompt!==prompt)throw new ToolError('Task needs confirmation');
    const {file,modelId}=confirmed;
    const catalog=await this.options.extensions?.list(this.root);
    if(!catalog?.items.some(i=>i.id===file.item.id&&i.enabled))throw new ToolError('Extension is disabled or unavailable');
    // The approved instructions/model are immutable, even if the source file changes while the user decides.
    const model=modelId===this.modelId?this.options.model:await this.options.makeModel?.(modelId)??this.options.model;
    const parent=this.options,io:AgentIO={...parent.io,text:()=>undefined,toolStart:(...args)=>parent.io.toolStart(...args),toolEnd:(...args)=>parent.io.toolEnd(...args),approve:(...args)=>parent.io.approve(...args),pause:(...args)=>parent.io.pause(...args),note:(text,tone)=>parent.io.note(`${name}: ${text}`,tone)};
    const reporter:Reporter={facts:id=>parent.reporter.facts(id),usage:(id,tokens)=>parent.reporter.usage(id,tokens),status:async update=>{if(['permission','answered','paused','tool-start','tool-finish'].includes(update.event))await parent.reporter.status(update);}};
    const child=new Agent({...parent,model,modelId,io,reporter,child:true,limits:this.limits,instructions:{...parent.instructions,text:parent.instructions.text+'\n\n# Subagent instructions\n'+file.body},transcript:new ChildTranscript(null,parent.redact,()=>parent.io.note('subagent transcript unavailable','error'))});
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
  private async clearance(inputTokens: number, controller: AbortController): Promise<AgentFacts | null> {
    const { io, reporter } = this.options;
    for (;;) {
      if (controller.signal.aborted) throw new Error('stopped');
      const facts = await reporter.facts(this.options.modelId), pause = this.limits.check(facts, inputTokens);
      if (!pause) { this.limits.turns++; return facts; }
      await reporter.status({ event: 'paused' });
      const go = await io.pause(pause.text, controller.signal);
      await reporter.status({ event: 'answered' });
      if (!go) { controller.abort(); throw new Error('stopped'); }
      pause.onContinue?.();
    }
  }
  // Context % for the card and the bar, and the warning once per crossing of 85% (D55, /settings can turn it off).
  private context(input: number, facts: AgentFacts | null): void {
    if (!facts?.context || !input) return;
    const percent = Math.min(100, Math.round(input / facts.context * 100));
    void this.options.reporter.status({ event: 'context', percent });
    if (percent < CONTEXT_WARN) { this.warned = false; return; }
    if (!this.warned && facts.contextWarning) this.options.io.note(`context ${percent}% · /clear or start fresh`, 'warn');
    this.warned = true;
  }
  // The turn's exact cost from the provider's own counts (input, cached, output, reasoning), priced like Usage.
  private turnCost(t: { input: number; cached: number; output: number; reasoning: number; cost: number | null; requests: number }): void {
    if (!t.requests) return;
    const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    this.options.io.note(`turn · ${k(t.input)} in${t.cached ? ` · ${k(t.cached)} cached` : ''} · ${k(t.output)} out${t.reasoning ? ` · ${k(t.reasoning)} reasoning` : ''} · ${t.cost === null ? 'price ?' : `$${t.cost.toFixed(4)}`} · run ${this.limits.describe().replace(/^caps: /, '')}`);
  }
  clear(): void { this.history = []; this.warned = false; void this.options.reporter.status({ event: 'context', percent: 0 }); }
}
