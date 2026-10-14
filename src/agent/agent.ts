import { streamText, tool, jsonSchema, isStepCount, APICallError, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { readTool, writeTool, editTool, searchTool, ToolError, type GatedTool } from './tools.js';
import { runBash, bashReport, bashPreview, BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS } from './bash.js';
import { JailError } from './jail.js';
import { ProviderError } from './provider.js';
import { systemPrompt, type Instructions } from './instructions.js';
import type { Reporter } from './report.js';
import type { Transcript } from './transcript.js';

export type AgentPermission = 'ask' | 'dontAsk';
export type ToolName = 'read' | 'write' | 'edit' | 'bash' | 'search';
// What the agent shows. The terminal UI implements it; tests record it.
export interface AgentIO {
  text(delta: string): void;
  toolStart(tool: ToolName, summary: string): void;
  toolEnd(tool: ToolName, outcome: 'ok' | 'denied' | 'failed', summary: string): void;
  // Resolves false when the user says no, presses Esc, or the turn is interrupted.
  approve(request: { title: string; body: string }, signal: AbortSignal): Promise<boolean>;
  note(text: string, tone?: 'info' | 'error'): void;
}
export interface AgentOptions {
  root: string; permission: AgentPermission; model: LanguageModel; modelId: string; instructions: Instructions;
  reporter: Reporter; transcript: Transcript; io: AgentIO; redact: (text: string) => string;
  bashEnv: Record<string, string>; rg: string | null; contextWindow?: number; maxSteps?: number;
}
export type TurnResult = 'done' | 'interrupted' | 'failed';
const DEFAULT_MAX_STEPS = 50;
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
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private options: AgentOptions) {}
  get root(): string { return this.options.root; }
  get modelId(): string { return this.options.modelId; }
  setModel(model: LanguageModel, modelId: string): void { this.options = { ...this.options, model, modelId }; void this.options.transcript.append({ kind: 'model', model: modelId }); void this.options.reporter.status({ event: 'model', model: modelId }); }
  setRoot(root: string, instructions: Instructions): void { this.options = { ...this.options, root, instructions }; }

  // Tool calls run one at a time, so approvals never overlap even when the model asks for several at once.
  private serial<T>(work: () => Promise<T>): Promise<T> { const next = this.queue.then(work, work); this.queue = next.then(() => undefined, () => undefined); return next; }

  private run<T>(name: ToolName, summary: (input: T) => string, work: (input: T, signal: AbortSignal) => Promise<string>, gate?: (input: T) => Promise<{ title: string; body: string }>) {
    return async (input: T, signal: AbortSignal): Promise<string> => this.serial(async () => {
      const { io, reporter, transcript, redact, permission } = this.options, shown = redact(summary(input));
      if (signal.aborted) return 'Interrupted by the user.';
      await reporter.status({ event: 'tool-start', tool: name });
      io.toolStart(name, shown); void transcript.append({ kind: 'tool-call', tool: name, input: JSON.stringify(input) });
      let outcome: 'ok' | 'denied' | 'failed' = 'failed', output = '';
      try {
        if (gate && permission === 'ask') {
          const request = await gate(input);
          // The daemon has the waiting status before the question is drawn, so /send can never answer it (D50).
          await reporter.status({ event: 'permission' });
          const allowed = await io.approve({ title: redact(request.title), body: redact(request.body) }, signal);
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
      return bashReport(await runBash(i.command, { cwd: this.options.root, env: this.options.bashEnv, timeoutMs: ms, signal }), ms);
    }, async i => bashPreview(i.command, timeout(i.timeoutSeconds)));
    return {
      read: tool({ description: 'Read a text file in the folder, with line numbers. Use offset and limit for long files.', inputSchema: schema<{ path: string; offset?: number; limit?: number }>({ path: 'string' }, { offset: 'number', limit: 'number' }, { path: 'File path, relative to the folder', offset: 'First line (1-based)', limit: 'Number of lines' }), execute: (input, { abortSignal }) => read(input, abortSignal ?? new AbortController().signal) }),
      write: tool({ description: 'Create or overwrite a whole file in the folder.', inputSchema: schema<{ path: string; content: string }>({ path: 'string', content: 'string' }, {}, { path: 'File path, relative to the folder', content: 'The complete new file content' }), execute: (input, { abortSignal }) => write(input, abortSignal ?? new AbortController().signal) }),
      edit: tool({ description: 'Replace exact text in a file. old must match exactly once unless replaceAll is true.', inputSchema: schema<{ path: string; old: string; new: string; replaceAll?: boolean }>({ path: 'string', old: 'string', new: 'string' }, { replaceAll: 'boolean' }, { path: 'File path, relative to the folder', old: 'Exact existing text', new: 'Replacement text', replaceAll: 'Replace every match' }), execute: (input, { abortSignal }) => edit(input, abortSignal ?? new AbortController().signal) }),
      bash: tool({ description: 'Run a shell command in the folder with /bin/sh -c. No stdin; output is capped.', inputSchema: schema<{ command: string; timeoutSeconds?: number }>({ command: 'string' }, { timeoutSeconds: 'number' }, { command: 'The command line', timeoutSeconds: 'Time limit in seconds (default 120, at most 600)' }), execute: (input, { abortSignal }) => bash(input, abortSignal ?? new AbortController().signal) }),
      search: tool({ description: this.options.rg ? 'Search file contents in the folder for a regular expression (ripgrep; respects .gitignore).' : 'Search file contents in the folder for plain text.', inputSchema: schema<{ pattern: string; path?: string }>({ pattern: 'string' }, { path: 'string' }, { pattern: this.options.rg ? 'Regular expression' : 'Plain text', path: 'Folder or file to search, relative to the folder' }), execute: (input, { abortSignal }) => search(input, abortSignal ?? new AbortController().signal) }),
    };
  }

  async turn(prompt: string, signal: AbortSignal): Promise<TurnResult> {
    const { io, reporter, transcript, redact } = this.options, user: ModelMessage = { role: 'user', content: prompt };
    void transcript.append({ kind: 'user', text: prompt });
    await reporter.status({ event: 'turn-start' });
    let stepText = '', lastText = '', streamError: unknown;
    const finishInterrupted = async (): Promise<TurnResult> => {
      // The partial reply stays in the conversation, marked, so the next turn knows what was cut off.
      this.history.push(user, { role: 'assistant', content: `${lastText || stepText}\n(The user interrupted this reply.)`.trim() });
      void transcript.append({ kind: 'note', text: 'interrupted' });
      await reporter.status({ event: 'done', reply: lastText || stepText });
      return 'interrupted';
    };
    try {
      const result = streamText({
        model: this.options.model, system: systemPrompt(this.options.root, this.options.instructions, { search: this.options.rg ? 'ripgrep regular expressions' : 'plain text' }),
        messages: [...this.history, user], tools: this.tools(), stopWhen: isStepCount(this.options.maxSteps ?? DEFAULT_MAX_STEPS), abortSignal: signal, toolCallConcurrency: 1, maxRetries: 2,
        // The SDK's default handler prints the error, whose text can carry anything the provider sent, to stderr, which
        // here is the agent's terminal. The same error arrives as the stream's error part below and is handled there.
        onError: ({ error }) => { streamError ??= error; },
      });
      for await (const part of result.stream) {
        if (part.type === 'start-step') stepText = '';
        else if (part.type === 'text-delta') { const text = redact(part.text); stepText += text; io.text(text); }
        else if (part.type === 'finish-step') {
          if (stepText) lastText = stepText;
          const input = part.usage.inputTokens ?? 0, output = part.usage.outputTokens ?? 0, cached = Math.min(input, part.usage.inputTokenDetails.cacheReadTokens ?? 0);
          if (input || output) void reporter.usage(this.options.modelId, { input, cached, output });
          if (this.options.contextWindow && input) void reporter.status({ event: 'context', percent: Math.min(100, Math.round(input / this.options.contextWindow * 100)) });
        }
        else if (part.type === 'error') throw part.error;
        else if (part.type === 'abort') break;
      }
      if (signal.aborted) return await finishInterrupted();
      if (streamError !== undefined) throw streamError;
      this.history.push(user, ...(await result.responseMessages));
      void transcript.append({ kind: 'assistant', text: lastText });
      await reporter.status({ event: 'done', reply: lastText });
      return 'done';
    } catch (error) {
      if (signal.aborted) return await finishInterrupted();
      const kind = error instanceof ProviderError ? 'unknown' : failureKind(error);
      const status = APICallError.isInstance(error) && error.statusCode ? ` (HTTP ${error.statusCode})` : '';
      io.note(`turn failed: ${FAILURE_TEXT[kind]}${status}`, 'error');
      void transcript.append({ kind: 'note', text: `turn failed: ${kind}${status}` });
      await reporter.status({ event: 'turn-failed', error: kind });
      return 'failed';
    }
  }
}
