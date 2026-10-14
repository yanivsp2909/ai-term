import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, realpath, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APICallError } from 'ai';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { Agent, type AgentIO, type AgentPermission } from '../src/agent/agent.js';
import { Transcript } from '../src/agent/transcript.js';
import { redactor } from '../src/agent/display.js';
import { buildBashEnv } from '../src/daemon/env.js';
import type { AgentStatus, Reporter, TokenUsage } from '../src/agent/report.js';

// A whole turn against a stub model (no network): tool calls, Ask approve and deny, Don't ask, the folder jail, Esc,
// failures, and what reaches the daemon (status, usage), the model, the screen and the transcript.
const roots: string[] = [], transcripts: Transcript[] = [];
afterEach(async () => { for (const t of transcripts.splice(0)) await t.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const KEY = 'AITERMCANARY-turn-0123456789abcdef';
const usage = (input: number, output: number, cached = 0) => ({ inputTokens: { total: input, noCache: input - cached, cacheRead: cached, cacheWrite: undefined }, outputTokens: { total: output, text: output, reasoning: undefined } });
const toolStep = (toolName: string, input: unknown, id = 'call-1') => ({ stream: convertArrayToReadableStream([{ type: 'stream-start' as const, warnings: [] }, { type: 'tool-call' as const, toolCallId: id, toolName, input: JSON.stringify(input) }, { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage: usage(100, 10, 40) }]) });
const textStep = (text: string) => ({ stream: convertArrayToReadableStream([{ type: 'stream-start' as const, warnings: [] }, { type: 'text-start' as const, id: 't' }, { type: 'text-delta' as const, id: 't', delta: text }, { type: 'text-end' as const, id: 't' }, { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage: usage(150, 20) }]) });

class Recorder implements Reporter, AgentIO {
  statuses: AgentStatus[] = []; usages: { model: string; tokens: TokenUsage }[] = []; screen = ''; approvals: { title: string; body: string }[] = []; notes: string[] = [];
  constructor(private readonly answer: boolean | 'wait' = true) {}
  async status(update: AgentStatus) { this.statuses.push(update); }
  async usage(model: string, tokens: TokenUsage) { this.usages.push({ model, tokens }); }
  text(delta: string) { this.screen += delta; }
  toolStart(tool: string, summary: string) { this.screen += `\n· ${tool} ${summary}`; }
  toolEnd(tool: string, outcome: string, summary: string) { this.screen += `\n${outcome} ${summary}\n`; }
  approve(request: { title: string; body: string }, signal: AbortSignal) {
    this.approvals.push(request);
    if (this.answer !== 'wait') return Promise.resolve(this.answer);
    return new Promise<boolean>(resolve => signal.addEventListener('abort', () => resolve(false), { once: true }));
  }
  note(text: string) { this.notes.push(text); }
}
async function setup(steps: NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>['doStream'], permission: AgentPermission = 'ask', answer: boolean | 'wait' = true) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ai-turn-'))); roots.push(temp);
  const root = join(temp, 'work'); await (await import('node:fs/promises')).mkdir(root);
  const recorder = new Recorder(answer), model = new MockLanguageModelV4({ doStream: steps }), redact = redactor(KEY), transcriptPath = join(temp, 'transcript.jsonl');
  const transcript = new Transcript(transcriptPath, redact, () => recorder.note('transcript failed')); transcripts.push(transcript);
  const agent = new Agent({ root, permission, model, modelId: 'gpt-6.1-sol', instructions: { text: '', files: [], notes: [] }, reporter: recorder, transcript, io: recorder, redact, bashEnv: buildBashEnv(process.env), rg: null, contextWindow: 1000 });
  return { temp, root, recorder, model, agent, transcript, transcriptPath };
}
const promptText = (model: MockLanguageModelV4, call: number) => JSON.stringify(model.doStreamCalls[call]?.prompt ?? null);

it('Ask, approved: the write shows its diff first, runs, and the turn reports status and usage in order', async () => {
  const { root, recorder, model, agent } = await setup([toolStep('write', { path: 'hello.txt', content: 'hi there' }), textStep('Wrote hello.txt.')]);
  expect(await agent.turn('make hello.txt', new AbortController().signal)).toBe('done');
  expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('hi there');
  expect(recorder.approvals).toEqual([{ title: 'write hello.txt', body: 'new file\n+ hi there' }]);
  expect(recorder.statuses.filter(s => s.event !== 'context')).toEqual([{ event: 'turn-start' }, { event: 'tool-start', tool: 'write' }, { event: 'permission' }, { event: 'answered' }, { event: 'tool-finish', tool: 'write' }, { event: 'done', reply: 'Wrote hello.txt.' }]);
  expect(recorder.statuses.filter(s => s.event === 'context')).toEqual([{ event: 'context', percent: 10 }, { event: 'context', percent: 15 }]);
  expect(recorder.usages).toEqual([{ model: 'gpt-6.1-sol', tokens: { input: 100, cached: 40, output: 10 } }, { model: 'gpt-6.1-sol', tokens: { input: 150, cached: 0, output: 20 } }]);
  expect(promptText(model, 1)).toContain('wrote hello.txt (1 lines)');
  expect(agent.history.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  expect(recorder.screen).toContain('· write hello.txt');
});

it('Ask, denied: nothing is written and the model is told not to retry', async () => {
  const { root, recorder, model, agent } = await setup([toolStep('bash', { command: 'touch made-by-bash' }), textStep('Okay.')], 'ask', false);
  expect(await agent.turn('touch a file', new AbortController().signal)).toBe('done');
  await expect(readFile(join(root, 'made-by-bash'))).rejects.toThrow();
  expect(recorder.approvals[0]).toEqual({ title: 'bash · 120s limit', body: 'touch made-by-bash' });
  expect(promptText(model, 1)).toContain('The user denied this. Do not retry it');
  expect(recorder.screen).toContain('denied denied');
});

it("Don't ask runs gated tools without asking; reads and searches never ask", async () => {
  const { root, recorder, agent } = await setup([toolStep('write', { path: 'a.txt', content: 'x' }), toolStep('read', { path: 'a.txt' }, 'call-2'), textStep('ok')], 'dontAsk');
  expect(await agent.turn('go', new AbortController().signal)).toBe('done');
  expect(recorder.approvals).toEqual([]); expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('x');
  const asks = await setup([toolStep('read', { path: '.' }), textStep('ok')]);
  await asks.agent.turn('look', new AbortController().signal);
  expect(asks.recorder.approvals).toEqual([]);
});

it('a path outside the folder is refused before any approval is shown', async () => {
  const absolute = join(tmpdir(), `ai-turn-abs-${process.pid}.txt`);
  const { temp, recorder, model, agent } = await setup([toolStep('write', { path: '../escaped.txt', content: 'x' }), toolStep('write', { path: absolute, content: 'x' }, 'call-2'), textStep('ok')]);
  await agent.turn('escape', new AbortController().signal);
  expect(recorder.approvals).toEqual([]);
  await expect(readFile(join(temp, 'escaped.txt'))).rejects.toThrow(); await expect(readFile(absolute)).rejects.toThrow();
  expect(promptText(model, 1)).toContain('Error: Path is outside the folder');
});

it('the key never reaches the model, the screen or the transcript, even when a file holds it', async () => {
  const { root, recorder, model, agent, transcript, transcriptPath } = await setup([toolStep('read', { path: 'leak.txt' }), textStep(`the key is ${KEY}`)]);
  await writeFile(join(root, 'leak.txt'), `KEY=${KEY}\n`);
  await agent.turn('read leak.txt', new AbortController().signal); await transcript.close();
  expect(promptText(model, 1)).not.toContain(KEY); expect(promptText(model, 1)).toContain('[redacted]');
  expect(recorder.screen).not.toContain(KEY); expect(JSON.stringify(recorder.statuses)).not.toContain(KEY);
  const saved = await readFile(transcriptPath, 'utf8');
  expect(saved).not.toContain(KEY); expect(saved.trim().split('\n').map(line => JSON.parse(line).kind)).toEqual(['user', 'tool-call', 'tool-result', 'assistant']);
});

it('Esc interrupts a streaming reply and a pending approval; the turn ends done with the partial reply', async () => {
  const abort = new AbortController();
  const hanging = { stream: new ReadableStream({ start(controller) { controller.enqueue({ type: 'stream-start', warnings: [] }); controller.enqueue({ type: 'text-start', id: 't' }); controller.enqueue({ type: 'text-delta', id: 't', delta: 'partial' }); } }) };
  const streaming = await setup([hanging as never]);
  setTimeout(() => abort.abort(), 100);
  expect(await streaming.agent.turn('talk', abort.signal)).toBe('interrupted');
  expect(streaming.recorder.statuses.at(-1)).toEqual({ event: 'done', reply: 'partial' });
  expect(streaming.agent.history.at(-1)).toEqual({ role: 'assistant', content: 'partial\n(The user interrupted this reply.)' });
  const approving = await setup([toolStep('bash', { command: 'echo hi' }), textStep('never')], 'ask', 'wait'), second = new AbortController();
  setTimeout(() => second.abort(), 100);
  expect(await approving.agent.turn('run', second.signal)).toBe('interrupted');
  expect(approving.recorder.statuses).toContainEqual({ event: 'answered' });
});

it('a provider failure is a failed turn with a fixed reason, never the provider\'s own text', async () => {
  const { recorder, agent } = await setup(async () => { throw new APICallError({ message: `bad key ${KEY}`, url: 'https://x', requestBodyValues: {}, statusCode: 401, isRetryable: false }); });
  expect(await agent.turn('hi', new AbortController().signal)).toBe('failed');
  expect(recorder.notes).toEqual(['turn failed: the key was refused; test it in /settings (HTTP 401)']);
  expect(recorder.statuses.at(-1)).toEqual({ event: 'turn-failed', error: 'authentication_failed' });
});
