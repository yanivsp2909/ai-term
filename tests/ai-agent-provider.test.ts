import { expect, it } from 'vitest';
import { streamText } from 'ai';
import { foundryModel, guardedFetch } from '../src/agent/provider.js';

// S16 for AI Term's agent: the Foundry key goes only to the endpoint bound to it, only in the api-key header, and a
// redirect (which would carry that header elsewhere) is never followed.
const KEY = 'AITERMCANARY-provider-0123456789abcdef', ENDPOINT = 'https://narvis-resource.openai.azure.com/openai/v1';

it('requests go to the bound endpoint with the key in api-key only, and never follow redirects', async () => {
  const seen: { url: string; headers: Headers; redirect?: RequestRedirect }[] = [];
  const fake: typeof fetch = async (input, init) => {
    seen.push({ url: input instanceof Request ? input.url : String(input), headers: new Headers(init?.headers), redirect: init?.redirect });
    return new Response(JSON.stringify({ error: { message: 'no' } }), { status: 401, headers: { 'content-type': 'application/json' } });
  };
  const result = streamText({ model: foundryModel(ENDPOINT, 'gpt-6.1-sol', KEY, fake), prompt: 'ping', maxRetries: 0, onError: () => {} });
  for await (const part of result.stream) void part;
  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe(`${ENDPOINT}/responses`);
  expect(seen[0]?.headers.get('api-key')).toBe(KEY);
  expect(seen[0]?.headers.get('authorization')).toBeNull();
  expect(seen[0]?.redirect).toBe('error');
});

it('the guard refuses any URL outside the endpoint before a request is made', async () => {
  let calls = 0;
  const guarded = guardedFetch(ENDPOINT, async () => { calls++; return new Response('{}'); });
  for (const url of ['https://evil.example/openai/v1/responses', 'http://narvis-resource.openai.azure.com/openai/v1/responses', 'https://narvis-resource.openai.azure.com/openai/v10/responses', 'https://narvis-resource.openai.azure.com/other'])
    await expect(guarded(url)).rejects.toThrow('Request outside the Foundry endpoint');
  await guarded(`${ENDPOINT}/responses`);
  expect(calls).toBe(1);
  expect(() => foundryModel('http://x.example/openai/v1', 'gpt', KEY)).toThrow('Invalid Foundry settings');
});
