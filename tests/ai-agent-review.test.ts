import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, realpath, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APICallError, RetryError } from 'ai';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { AgentApp } from '../src/agent/app.js';
import { Agent } from '../src/agent/agent.js';
import { Screen } from '../src/agent/screen.js';
import { Transcript } from '../src/agent/transcript.js';
import { loadInstructions } from '../src/agent/instructions.js';
import { createTheme } from '../src/client/tui/theme.js';
import { buildBashEnv } from '../src/daemon/env.js';
import type { AgentStatus, Reporter } from '../src/agent/report.js';

// v0.4.1 security review findings: each one reproduced here before its fix.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
const call = (toolName: string, input: unknown) => ({ stream: convertArrayToReadableStream([{ type: 'stream-start' as const, warnings: [] }, { type: 'tool-call' as const, toolCallId: 'c', toolName, input: JSON.stringify(input) }, { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage }]) });
const text = (body: string) => ({ stream: convertArrayToReadableStream([{ type: 'stream-start' as const, warnings: [] }, { type: 'text-start' as const, id: 't' }, { type: 'text-delta' as const, id: 't', delta: body }, { type: 'text-end' as const, id: 't' }, { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage }]) });

async function app(steps: NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>['doStream'], rows = 30) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-review-'))); roots.push(root);
  const writes: string[] = [], statuses: AgentStatus[] = [], notes: string[] = [];
  const reporter: Reporter = { status: async s => { statuses.push(s); }, usage: async () => {} };
  const screen = new Screen({ write: t => { writes.push(t); }, columns: 100, rows }, createTheme('graphite'));
  const note = screen.note.bind(screen); screen.note = (t, tone) => { notes.push(t); note(t, tone); };
  const model = new MockLanguageModelV4({ doStream: steps });
  const instance = new AgentApp({ screen, permission: 'ask', models: ['m1'], quit: vi.fn(), makeModel: () => model,
    agent: io => new Agent({ root, permission: 'ask', model, modelId: 'm1', instructions: { text: '', files: [], notes: [] }, reporter, transcript: new Transcript(null, t => t, () => {}), io, redact: t => t, bashEnv: buildBashEnv(process.env), rg: null }) });
  return { root, instance, statuses, writes, notes, output: () => writes.join('') };
}
const visibleRows = (chunk: string) => chunk.split('\n').length;

it('MEDIUM: an approval taller than the screen pages, and y counts only once the last page was shown', async () => {
  const command = ['touch pwned # the part that runs', ...Array.from({ length: 300 }, () => '# ok')].join('\n');
  const a = await app([call('bash', { command }), text('done')], 30);
  a.instance.start(); a.instance.input('go\r');
  await vi.waitFor(() => expect(a.statuses.map(s => s.event)).toContain('permission'));
  // What is on screen while y is asked for: the first page, starting with the command's first line, fits the terminal.
  const shown = a.output().slice(a.output().indexOf('● allow bash'));
  expect(visibleRows(shown)).toBeLessThanOrEqual(30);
  expect(shown).toContain('touch pwned'); expect(shown).toContain('space shows more');
  a.instance.input('y');
  await new Promise(resolve => setTimeout(resolve, 50));
  await expect(stat(join(a.root, 'pwned'))).rejects.toThrow();
  for (let i = 0; i < 20; i++) a.instance.input(' ');
  a.instance.input('y');
  await vi.waitFor(() => expect(a.statuses.map(s => s.event)).toContain('done'));
  expect((await stat(join(a.root, 'pwned'))).isFile()).toBe(true);
});

it('MEDIUM: a bash command over 16 KB is refused before any approval', async () => {
  const a = await app([call('bash', { command: 'echo ' + 'x'.repeat(17 * 1024) }), text('ok')]);
  a.instance.start(); a.instance.input('go\r');
  await vi.waitFor(() => expect(a.statuses.map(s => s.event)).toContain('done'));
  expect(a.statuses.map(s => s.event)).not.toContain('permission');
});

it('LOW-MEDIUM: an import name the file system rejects is skipped with a note, never a crash', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-review-'))); roots.push(root);
  await writeFile(join(root, 'AGENTS.md'), `rules\n@${'a'.repeat(300)}\n`);
  const loaded = await loadInstructions(root);
  expect(loaded.text).toContain('rules'); expect(loaded.notes.join('\n')).toContain("can't read");
});

it('LOW: a provider error that exhausted its retries still shows its fixed reason and HTTP status', async () => {
  const limited = new APICallError({ message: 'slow down', url: 'https://x', requestBodyValues: {}, statusCode: 429, isRetryable: true });
  const a = await app(async () => { throw new RetryError({ message: 'retries', reason: 'maxRetriesExceeded', errors: [limited, limited] }); });
  a.instance.start(); a.instance.input('hi\r');
  await vi.waitFor(() => expect(a.statuses.at(-1)).toEqual({ event: 'turn-failed', error: 'rate_limit' }));
  expect(a.notes).toContain('turn failed: rate limited; try again shortly (HTTP 429)');
});
