import { expect, it } from 'vitest';
import { streamText } from 'ai';
import { guardedFetch, makeModel, type ModelSpec } from '../src/agent/provider.js';

// S16/S19 for AI Term's agent: each provider sends its key only in its own header, only to its own endpoint (fixed, or
// the Foundry one bound in the Keychain), never follows a redirect, and no provider error text reaches the screen.
const KEY = 'AITERM' + 'CANARY-provider-0123456789abcdef', ENDPOINT = 'https://example-resource.openai.azure.com/openai/v1';
interface Seen { url: string; headers: Headers; redirect?: RequestRedirect; body: string }

async function oneRequest(spec: ModelSpec): Promise<Seen> {
  const seen: Seen[] = [];
  const fake: typeof fetch = async (input, init) => {
    seen.push({ url: input instanceof Request ? input.url : String(input), headers: new Headers(init?.headers), redirect: init?.redirect, body: String(init?.body ?? '') });
    return new Response(JSON.stringify({ error: { message: `refused ${KEY}`, type: 'auth' } }), { status: 401, headers: { 'content-type': 'application/json' } });
  };
  const errors: unknown[] = [];
  const result = streamText({ model: makeModel(spec, fake), prompt: 'ping', maxRetries: 0, onError: ({ error }) => { errors.push(error); } });
  for await (const part of result.stream) void part;
  expect(seen).toHaveLength(1); expect(errors).toHaveLength(1);
  const request = seen[0]; if (!request) throw new Error('no request');
  expect(request.redirect).toBe('error'); expect(request.url).not.toContain(KEY); expect(request.body).not.toContain(KEY);
  return request;
}

it('Foundry GPT: the bound endpoint\'s Responses API, key in api-key only', async () => {
  const seen = await oneRequest({ provider: 'foundry', model: 'gpt-6.1-sol', key: KEY, endpoint: ENDPOINT, wire: 'responses' });
  expect(seen.url).toBe(`${ENDPOINT}/responses`); expect(seen.headers.get('api-key')).toBe(KEY); expect(seen.headers.get('authorization')).toBeNull();
});

it('Foundry non-GPT: the bound endpoint\'s Chat Completions, key in api-key only', async () => {
  const seen = await oneRequest({ provider: 'foundry', model: 'kimi-k2.6', key: KEY, endpoint: ENDPOINT, wire: 'chat' });
  expect(seen.url).toBe(`${ENDPOINT}/chat/completions`); expect(JSON.parse(seen.body).model).toBe('kimi-k2.6');
  expect(seen.headers.get('api-key')).toBe(KEY); expect(seen.headers.get('authorization')).toBeNull();
});

it('Anthropic: api.anthropic.com only, key in x-api-key only', async () => {
  const seen = await oneRequest({ provider: 'anthropic', model: 'claude-sonnet-5', key: KEY, endpoint: 'https://evil.example/v1' });
  expect(seen.url).toBe('https://api.anthropic.com/v1/messages'); expect(seen.headers.get('x-api-key')).toBe(KEY);
  expect(seen.headers.get('authorization')).toBeNull(); expect(seen.headers.get('api-key')).toBeNull();
});

it('OpenAI: api.openai.com only, key as its bearer token only, no organization or project header', async () => {
  const seen = await oneRequest({ provider: 'openai', model: 'gpt-6.1-sol', key: KEY, endpoint: 'https://evil.example/v1' });
  expect(seen.url).toBe('https://api.openai.com/v1/responses'); expect(seen.headers.get('authorization')).toBe(`Bearer ${KEY}`);
  for (const name of ['api-key', 'x-api-key', 'openai-organization', 'openai-project']) expect(seen.headers.get(name)).toBeNull();
});

it('the guard refuses any URL outside the endpoint before a request is made', async () => {
  let calls = 0;
  const guarded = guardedFetch(ENDPOINT, async () => { calls++; return new Response('{}'); });
  for (const url of ['https://evil.example/openai/v1/responses', 'http://example-resource.openai.azure.com/openai/v1/responses', 'https://example-resource.openai.azure.com/openai/v10/responses', 'https://example-resource.openai.azure.com/other'])
    await expect(guarded(url)).rejects.toThrow('Request outside the provider endpoint');
  await guarded(`${ENDPOINT}/responses`);
  expect(calls).toBe(1);
  expect(() => makeModel({ provider: 'foundry', model: 'gpt', key: KEY, endpoint: 'http://x.example/openai/v1' })).toThrow('Invalid Foundry settings');
  expect(() => makeModel({ provider: 'foundry', model: 'gpt', key: KEY, endpoint: null })).toThrow('Invalid Foundry settings');
});
