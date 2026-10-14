import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, realpath, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { KeyReader } from '../src/agent/key-reader.js';
import { AgentApp } from '../src/agent/app.js';
import { Agent } from '../src/agent/agent.js';
import { Screen } from '../src/agent/screen.js';
import { Transcript } from '../src/agent/transcript.js';
import { createTheme } from '../src/client/tui/theme.js';
import { buildBashEnv } from '../src/daemon/env.js';
import type { AgentStatus, Reporter } from '../src/agent/report.js';
import { stubFacts } from './fixtures/agent-facts.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('the key reader keeps pastes whole (even split across reads) and forwards plain popup arrows while dropping modified cursor sequences', () => {
  // Plain arrows navigate the popup; modified movement remains outside the agent prompt editor.
  const reader = new KeyReader();
  expect(reader.push('ab\x1b[200~y\nmore')).toEqual([{ kind: 'text', text: 'ab' }]);
  expect(reader.push(' text\x1b[20')).toEqual([]);
  expect(reader.push('1~\r')).toEqual([{ kind: 'paste', text: 'y\nmore text' }, { kind: 'enter' }]);
  expect(reader.push('\x1b[A\x1b[1;5Cz\x1b')).toEqual([{kind:'up'}, { kind: 'text', text: 'z' }, { kind: 'escape' }]);
  expect(reader.push('\x03\x7f\x1b[13u\n')).toEqual([{ kind: 'ctrl-c' }, { kind: 'backspace' }, { kind: 'enter' }, { kind: 'newline' }]);
  expect(reader.push('\x1b[')).toEqual([]); expect(reader.push('B')).toEqual([{kind:'down'}]);
});

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
const text = (body: string) => ({ stream: convertArrayToReadableStream([{ type: 'stream-start' as const, warnings: [] }, { type: 'text-start' as const, id: 't' }, { type: 'text-delta' as const, id: 't', delta: body }, { type: 'text-end' as const, id: 't' }, { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage }]) });
const call = (toolName: string, input: unknown) => ({ stream: convertArrayToReadableStream([{ type: 'stream-start' as const, warnings: [] }, { type: 'tool-call' as const, toolCallId: 'c', toolName, input: JSON.stringify(input) }, { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage }]) });

async function app(steps: NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>['doStream'], models = ['m1', 'm2']) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-app-'))); roots.push(root);
  let out = ''; const statuses: AgentStatus[] = [], quit = vi.fn();
  const reporter: Reporter = { status: async s => { statuses.push(s); }, usage: async () => {}, facts: async () => stubFacts() };
  const screen = new Screen({ write: t => { out += t; }, columns: 100 }, createTheme('graphite'));
  const model = new MockLanguageModelV4({ doStream: steps }), made: string[] = [];
  const instance = new AgentApp({
    screen, permission: 'ask', models, quit, makeModel: async id => { made.push(id); return model; },
    agent: io => new Agent({ root, permission: 'ask', model, modelId: 'm1', instructions: { text: '', files: [], notes: [] }, reporter, transcript: new Transcript(null, t => t, () => {}), io, redact: t => t, bashEnv: buildBashEnv(process.env), rg: null }),
  });
  return { root, instance, quit, statuses, made, output: () => out, settle: () => vi.waitFor(() => expect(instance.running).toBe(false)) };
}

it('a typed message runs a turn; model text never carries escape sequences to the terminal', async () => {
  const a = await app([text('hi \x1b]52;c;cHdu\x07there\x1b[2J')]);
  a.instance.start(); a.instance.input('hello\r');
  await a.settle();
  expect(a.output()).toContain('hello'); expect(a.output()).toContain('hi there');
  expect(a.output()).not.toContain('\x1b]52'); expect(a.output()).not.toContain('\x1b[2J');
  expect(a.statuses.map(s => s.event)).toEqual(['turn-start', 'done']);
});

it('a paste never answers an approval; a typed y does', async () => {
  const a = await app([call('write', { path: 'f.txt', content: 'x' }), text('ok')]);
  a.instance.start(); a.instance.input('write it\r');
  await vi.waitFor(() => expect(a.statuses.map(s => s.event)).toContain('permission'));
  a.instance.input('\x1b[200~y\x1b[201~'); a.instance.input('\x1b[200~y\r\x1b[201~');
  await new Promise(resolve => setTimeout(resolve, 50));
  await expect(readFile(join(a.root, 'f.txt'))).rejects.toThrow();
  a.instance.input('y');
  await a.settle();
  expect(await readFile(join(a.root, 'f.txt'), 'utf8')).toBe('x');
  expect(a.output()).toContain('● allow write f.txt?'); expect(a.output()).toContain('✓ allowed');
});

it('Esc at an approval denies it and stops the turn', async () => {
  const a = await app([call('bash', { command: 'touch nope' }), text('never')]);
  a.instance.start(); a.instance.input('go\r');
  await vi.waitFor(() => expect(a.statuses.map(s => s.event)).toContain('permission'));
  a.instance.input('\x1b');
  await a.settle();
  await expect(readFile(join(a.root, 'nope'))).rejects.toThrow();
  expect(a.output()).toContain('✗ denied'); expect(a.output()).toContain('■ interrupted');
});

it('Ctrl+C once only warns; twice quits', async () => {
  const a = await app([]);
  a.instance.start(); a.instance.input('\x03');
  expect(a.quit).not.toHaveBeenCalled(); expect(a.output()).toContain('press Ctrl+C again to quit');
  a.instance.input('\x03');
  expect(a.quit).toHaveBeenCalledOnce();
});

it('a message sent during a turn waits for it; /model and /cd work inside the agent', async () => {
  const a = await app([text('one'), text('two')]);
  a.instance.start(); a.instance.input('first\r'); a.instance.input('second\r');
  await vi.waitFor(() => expect(a.statuses.filter(s => s.event === 'done')).toHaveLength(2));
  expect(a.output()).toContain('queued until this turn ends: second');
  a.instance.input('/model nope\r'); await vi.waitFor(() => expect(a.output()).toContain("nope isn't a tested deployment of this key"));
  a.instance.input('/model m2\r'); await vi.waitFor(() => expect(a.output()).toContain('model: m2'));
  expect(a.made).toEqual(['m2']); expect(a.statuses.at(-1)).toEqual({ event: 'model', model: 'm2' });
  await mkdir(join(a.root, 'sub')); await writeFile(join(a.root, 'sub', 'AGENTS.md'), 'be brief');
  a.instance.input('/cd sub\r'); await vi.waitFor(() => expect(a.output()).toContain(`folder: ${join(a.root, 'sub')} · read AGENTS.md`));
  a.instance.input('/cd /definitely/not/here\r'); await vi.waitFor(() => expect(a.output()).toContain("isn't a folder you can open"));
});

it('the banner never prints escape sequences from a folder or model name', () => {
  let out = '';
  new Screen({ write: t => { out += t; }, columns: 100 }, createTheme('graphite')).banner('m1', '/tmp/evil\x1b]52;c;cHdu\x07\x1b[2Jname', 'ask', ['AGENTS.md']);
  expect(out).not.toContain('\x1b]52'); expect(out).not.toContain('\x1b[2J'); expect(out).toContain('/tmp/evilname');
});
