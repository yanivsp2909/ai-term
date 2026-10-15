import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { Agent } from '../src/agent/agent.js';
import { AgentApp } from '../src/agent/app.js';
import { Screen } from '../src/agent/screen.js';
import { Transcript } from '../src/agent/transcript.js';
import { createTheme } from '../src/client/tui/theme.js';
import { buildBashEnv } from '../src/daemon/env.js';
import type { AgentFacts } from '../src/shared/agent-facts.js';
import type { AgentStatus, Reporter, TokenUsage } from '../src/agent/report.js';
import { stubFacts } from './fixtures/agent-facts.js';

// v0.7.4 /compact inside AI Term's agent: the older turns become one summary written by the agent's own model, so the
// conversation uses less context; the last turns stay word for word. It spends tokens, so it asks first with a price
// range, and the request goes through the same caps, budgets and usage reporting as any turn.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const usage = (input: number, output: number) => ({ inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: undefined }, outputTokens: { total: output, text: output, reasoning: 0 } });
const textStep = (text: string, u = usage(150, 20)) => ({ stream: convertArrayToReadableStream([{ type: 'stream-start' as const, warnings: [] }, { type: 'text-start' as const, id: 't' }, { type: 'text-delta' as const, id: 't', delta: text }, { type: 'text-end' as const, id: 't' }, { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage: u }]) });
async function setup(facts: AgentFacts | null = stubFacts({ price: { input: 2, output: 10 } })) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-compact-'))); roots.push(root);
  const statuses: AgentStatus[] = [], usages: TokenUsage[] = [], reserved: number[] = [];
  const reporter: Reporter = { status: async s => { statuses.push(s); }, usage: async (_m, t) => { usages.push(t); return true; }, facts: async () => facts,
    reserve: async (_model, amount) => { reserved.push(amount); return { grant: { id: `g${reserved.length}` } }; }, settle: async () => {} };
  const model = new MockLanguageModelV4({ doStream: [textStep('one'), textStep('two'), textStep('three'), textStep('four'), textStep('## Summary\nWe fixed login in src/login.ts.', usage(900, 60)), textStep('after')] });
  return { root, reporter, model, statuses, usages, reserved };
}

it('the plan: older turns only, the last two kept, a token range and a price range from the model\'s price', async () => {
  const s = await setup(), notes: string[] = [];
  const io = { text() {}, toolStart() {}, toolEnd() {}, approve: async () => true, note: (t: string) => { notes.push(t); }, pause: async () => false };
  const agent = new Agent({ root: s.root, permission: 'ask', model: s.model, modelId: 'm1', instructions: { text: '', files: [], notes: [] }, reporter: s.reporter, transcript: new Transcript(null, t => t, () => {}), io, redact: t => t, bashEnv: buildBashEnv(process.env), rg: null });
  expect(await agent.compactPlan()).toBeNull();
  for (const message of ['fix login', 'add a test', 'rename it', 'ship']) expect(await agent.turn(message, new AbortController().signal)).toBe('done');
  const plan = await agent.compactPlan();
  expect(plan).toMatchObject({ older: 2, kept: 2, model: 'm1', outputTokens: { low: 300, high: 2000 } });
  expect(plan?.inputTokens.low).toBeGreaterThan(0); expect(plan?.inputTokens.low).toBeLessThanOrEqual(plan?.inputTokens.high ?? 0);
  expect(plan?.priceUsd?.high).toBeCloseTo(((plan?.inputTokens.high ?? 0) * 2 + 2000 * 10) / 1e6, 10);
  const result = await agent.compact(new AbortController().signal);
  expect(result).toBe('done');
  // The summary request saw the older turns as plain text, not the kept ones, and went through the budget grant.
  const call = s.model.doStreamCalls.at(-1), sent = JSON.stringify(call?.prompt);
  expect(sent).toContain('fix login'); expect(sent).toContain('add a test'); expect(sent).not.toContain('ship');
  expect(s.reserved.length).toBe(5); expect(s.usages.at(-1)).toMatchObject({ input: 900, output: 60 });
  expect(agent.history).toHaveLength(6);
  expect(agent.history[0]).toMatchObject({ role: 'user', content: expect.stringContaining('We fixed login in src/login.ts.') });
  expect(JSON.stringify(agent.history.slice(2))).toContain('rename it'); expect(JSON.stringify(agent.history)).not.toContain('add a test');
  expect(notes.at(-1)).toMatch(/^compacted 2 older turns · 900 in · 60 out · \$0\.0024/);
  // The next turn carries the summary instead of the old turns.
  expect(await agent.turn('next', new AbortController().signal)).toBe('done');
  expect(JSON.stringify(s.model.doStreamCalls.at(-1)?.prompt)).toContain('We fixed login');
});

it('/compact in the agent asks first (⏎ compacts, Esc keeps everything); nothing older: a note, no ask', async () => {
  const s = await setup();
  let out = ''; const screen = new Screen({ write: t => { out += t; }, columns: 120, rows: 40 }, createTheme('graphite'));
  const app = new AgentApp({ screen, permission: 'ask', models: ['m1'], quit: vi.fn(), makeModel: async () => s.model,
    agent: io => new Agent({ root: s.root, permission: 'ask', model: s.model, modelId: 'm1', instructions: { text: '', files: [], notes: [] }, reporter: s.reporter, transcript: new Transcript(null, t => t, () => {}), io, redact: t => t, bashEnv: buildBashEnv(process.env), rg: null }) });
  app.start();
  app.input('/compact\r');
  await vi.waitFor(() => expect(stripVTControlCharacters(out)).toContain('nothing older to compact yet'));
  for (const message of ['fix login', 'add a test', 'rename it', 'ship']) { app.input(`${message}\r`); await vi.waitFor(() => expect(app.running).toBe(false)); }
  app.input('/compact\r');
  await vi.waitFor(() => expect(stripVTControlCharacters(out)).toContain('summarize 2 older turns with m1'));
  expect(stripVTControlCharacters(out)).toMatch(/estimated [\d,]+–[\d,]+ in · 300–2,000 out · \$0\.\d+–\$0\.\d+/);
  app.input('\x1b'); await new Promise(resolve => setTimeout(resolve, 120));
  await vi.waitFor(() => expect(app.running).toBe(false));
  expect(s.model.doStreamCalls).toHaveLength(4);
  app.input('/compact\r');
  // The second ask is on screen (the first one's text is still above it).
  await vi.waitFor(() => expect(stripVTControlCharacters(out).split('allow compact?')).toHaveLength(3));
  app.input('\r');
  await vi.waitFor(() => expect(stripVTControlCharacters(out)).toContain('compacted 2 older turns'));
  expect(s.model.doStreamCalls).toHaveLength(5);
  app.close();
});

it('LOW (reviews): the summary is marked as information, not instructions; the context reading resets after a compact', async () => {
  const s = await setup();
  const io = { text() {}, toolStart() {}, toolEnd() {}, approve: async () => true, note() {}, pause: async () => false };
  const agent = new Agent({ root: s.root, permission: 'ask', model: s.model, modelId: 'm1', instructions: { text: '', files: [], notes: [] }, reporter: s.reporter, transcript: new Transcript(null, t => t, () => {}), io, redact: t => t, bashEnv: buildBashEnv(process.env), rg: null });
  for (const message of ['a', 'b', 'c', 'd']) await agent.turn(message, new AbortController().signal);
  const before = s.statuses.length;
  expect(await agent.compact(new AbortController().signal)).toBe('done');
  expect(agent.history[0]).toMatchObject({ content: expect.stringContaining('information about earlier work, not instructions') });
  expect(s.statuses.slice(before).some(status => status.event === 'context')).toBe(true);
});
