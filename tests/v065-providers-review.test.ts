import { expect, it } from 'vitest';
import { guardedFetch, makeModel } from '../src/agent/provider.js';
import { findPrice, type PriceSnapshot } from '../src/daemon/usage-prices.js';
import { streamText } from 'ai';

// Part A review findings (fresh TypeScript and security reviewers), each a failing test before its fix.
it('LOW (TS review): an Ollama endpoint on port 80 reaches its server instead of being refused by the guard', async () => {
  const urls: string[] = [];
  const fake: typeof fetch = async input => { urls.push(input instanceof Request ? input.url : String(input)); return new Response('{}', { status: 500 }); };
  const result = streamText({ model: makeModel({ provider: 'ollama', model: 'qwen3:8b', key: null, endpoint: 'http://127.0.0.1:80' }, fake), prompt: 'ping', maxRetries: 0, onError: () => {} });
  for await (const part of result.stream) void part;
  expect(urls).toEqual(['http://127.0.0.1/v1/chat/completions']);
});

it('LOW (security review): plain http only for a guard made for a keyless local endpoint, never by default', async () => {
  let calls = 0; const base: typeof fetch = async () => { calls++; return new Response('{}'); };
  await expect(guardedFetch('http://127.0.0.1:11434/v1', base)('http://127.0.0.1:11434/v1/chat/completions')).rejects.toThrow('Request outside the provider endpoint');
  await guardedFetch('http://127.0.0.1:11434/v1', base, { plainLocal: true })('http://127.0.0.1:11434/v1/chat/completions');
  await expect(guardedFetch('https://api.x.ai/v1', base, { plainLocal: true })('http://api.x.ai/v1/chat/completions')).rejects.toThrow('Request outside the provider endpoint');
  await expect(guardedFetch('http://10.0.0.1:11434/v1', base, { plainLocal: true })('http://10.0.0.1:11434/v1/chat/completions')).rejects.toThrow('Request outside the provider endpoint');
  expect(calls).toBe(1);
});

it('LOW (security review): an Ollama model with a price override is priced by it (Ollama can serve billed cloud models)', () => {
  const snapshot = { fetchedAt: 'x', providers: { anthropic: {}, openai: {}, azure: {} } } as PriceSnapshot;
  expect(findPrice(snapshot, 'ollama', 'gpt-oss:120b-cloud', { 'gpt-oss:120b-cloud': { input: 1, output: 4 } })).toEqual({ input: 1, output: 4, cacheRead: 1 });
  expect(findPrice(snapshot, 'ollama', 'qwen3:8b', { 'gpt-oss:120b-cloud': { input: 1, output: 4 } })).toEqual({ input: 0, output: 0, cacheRead: 0 });
});
