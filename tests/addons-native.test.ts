import { expect, it } from 'vitest';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { Agent } from '../src/agent/agent.js';
import { Transcript } from '../src/agent/transcript.js';
import { stubFacts } from './fixtures/agent-facts.js';

it('native read-only pilots expose only read and search, even when a global subagent catalog exists', async () => {
  const model = new MockLanguageModelV4({ doStream: async options => {
    expect(options.tools?.map(t => t.type === 'function' ? t.name : t.id).sort()).toEqual(['read', 'search']);
    return { stream: convertArrayToReadableStream([{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Read-only answer.' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 10, text: 10, reasoning: undefined } } }]) };
  } });
  const agent = new Agent({ root: '/tmp', model, modelId: 'm1', permission: 'ask', readOnly: true, instructions: { text: 'Bundled planner instructions', files: [], notes: [] }, reporter: { facts: async () => stubFacts({ model: 'm1' }), status: async () => {}, usage: async () => {} }, transcript: new Transcript(null, s => s, () => {}), io: { text: () => {}, toolStart: () => {}, toolEnd: () => {}, note: () => {}, pause: async () => false, approve: async () => { throw new Error('No permission-skipping or mutating tools should run'); } }, redact: s => s, bashEnv: {}, rg: null,
    extensions: { list: async () => ({ items: [], notes: [], tokens: 0 }), read: async () => { throw new Error('No subagent should load'); }, toggle: async () => ({ items: [], notes: [], tokens: 0 }) },
  });
  expect(await agent.turn('Explain the code', new AbortController().signal)).toBe('done');
});
