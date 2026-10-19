import { describe, expect, it } from 'vitest';
import { streamText } from 'ai';
import { guardedFetch, makeModel, type ModelSpec } from '../src/agent/provider.js';
import { DIRECT_HOSTS, bedrockEndpoint, isBedrockEndpoint, isLocalEndpoint, testedModels } from '../src/shared/providers.js';
import { testDirect } from '../src/daemon/providers/direct.js';
import { listOllama } from '../src/daemon/providers/ollama.js';
import type { ProviderRequest } from '../src/daemon/providers/foundry.js';
import { validateRequest, validateKeyView, isKeyProvider } from '../src/shared/validate.js';
import { keyEngine, modelChoices } from '../src/shared/models.js';
import { findPrice, type PriceSnapshot } from '../src/daemon/usage-prices.js';
import { buildAgentArgs, buildAgentEnv } from '../src/daemon/env.js';
import { parseAgentArgs, takeSecrets } from '../src/agent/main.js';
import { cheapestWriter } from '../src/daemon/handoff.js';
import type { KeyView } from '../src/shared/protocol.js';

// v0.6.5 (Part A): xAI, Moonshot, Z.ai, OpenRouter, Bedrock and Vertex keys, plus Ollama on this Mac. Each key goes only in
// its own header, only to its provider's fixed official host (Bedrock: the region bound to the key), never through a
// redirect; Ollama only to http://127.0.0.1 with no key at all.
const KEY = 'AITERMCANARY-v065-0123456789abcdef';
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

describe('agent providers', () => {
  for (const [provider, host] of Object.entries({ xai: 'https://api.x.ai/v1', moonshot: 'https://api.moonshot.ai/v1', zai: 'https://api.z.ai/api/paas/v4', openrouter: 'https://openrouter.ai/api/v1' }))
    it(`${provider}: its fixed host's Chat Completions, key as its bearer token only, a passed endpoint ignored`, async () => {
      const seen = await oneRequest({ provider: provider as ModelSpec['provider'], model: 'some/model:free', key: KEY, endpoint: 'https://evil.example/v1' });
      expect(seen.url).toBe(`${host}/chat/completions`); expect(JSON.parse(seen.body)).toMatchObject({ model: 'some/model:free', stream: true, stream_options: { include_usage: true } });
      expect(seen.headers.get('authorization')).toBe(`Bearer ${KEY}`);
      for (const name of ['api-key', 'x-api-key', 'x-goog-api-key']) expect(seen.headers.get(name)).toBeNull();
    });

  it('Ollama: http://127.0.0.1 only, no key header at all', async () => {
    const seen = await oneRequest({ provider: 'ollama', model: 'qwen3-coder:30b', key: null, endpoint: 'http://127.0.0.1:11434' });
    expect(seen.url).toBe('http://127.0.0.1:11434/v1/chat/completions'); expect(seen.headers.get('authorization')).toBeNull();
    for (const endpoint of ['http://localhost:11434', 'http://10.0.0.2:11434', 'https://127.0.0.1:11434', 'http://127.0.0.1:11434/v1', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:70000', 'http://user@127.0.0.1:11434'])
      expect(() => makeModel({ provider: 'ollama', model: 'm', key: null, endpoint })).toThrow('Invalid Ollama settings');
  });

  it('Bedrock: the bound region\'s runtime host, key as a bearer token only (never SigV4 from the environment)', async () => {
    const endpoint = 'https://bedrock-runtime.eu-west-1.amazonaws.com';
    const seen = await oneRequest({ provider: 'bedrock', model: 'eu.anthropic.claude-sonnet-5-v1:0', key: KEY, endpoint });
    expect(seen.url).toBe(`${endpoint}/model/${encodeURIComponent('eu.anthropic.claude-sonnet-5-v1:0')}/converse-stream`);
    expect(seen.headers.get('authorization')).toBe(`Bearer ${KEY}`); expect(seen.headers.get('x-amz-date')).toBeNull();
    for (const bad of [null, 'https://evil.example', 'https://bedrock-runtime.eu-west-1.amazonaws.com.evil.example', 'http://bedrock-runtime.eu-west-1.amazonaws.com'])
      expect(() => makeModel({ provider: 'bedrock', model: 'm', key: KEY, endpoint: bad })).toThrow('Invalid Bedrock settings');
  });

  it('Vertex (express mode): aiplatform.googleapis.com only, key in x-goog-api-key only, never in the URL', async () => {
    const seen = await oneRequest({ provider: 'vertex', model: 'gemini-3.8-flash', key: KEY, endpoint: 'https://evil.example/v1' });
    expect(seen.url.startsWith('https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:streamGenerateContent')).toBe(true);
    expect(seen.headers.get('x-goog-api-key')).toBe(KEY); expect(seen.headers.get('authorization')).toBeNull();
  });

  it('keys must be present for keyed providers and absent for Ollama', () => {
    expect(() => makeModel({ provider: 'xai', model: 'grok', key: null, endpoint: null })).toThrow('Invalid xAI settings');
    expect(() => makeModel({ provider: 'ollama', model: 'm', key: KEY, endpoint: 'http://127.0.0.1:11434' })).toThrow('Invalid Ollama settings');
  });

  it('the guard lets plain http reach only the local endpoint it was made for', async () => {
    let calls = 0;
    const guarded = guardedFetch('http://127.0.0.1:11434/v1', async () => { calls++; return new Response('{}'); }, { plainLocal: true });
    for (const url of ['http://127.0.0.1:11435/v1/chat/completions', 'http://localhost:11434/v1/chat/completions', 'https://127.0.0.1:11434/v1/chat/completions', 'http://127.0.0.1:11434/api/pull'])
      await expect(guarded(url)).rejects.toThrow('Request outside the provider endpoint');
    await guarded('http://127.0.0.1:11434/v1/chat/completions');
    expect(calls).toBe(1);
    // A remote endpoint never accepts http.
    await expect(guardedFetch('https://api.x.ai/v1', async () => new Response('{}'))('http://api.x.ai/v1/chat/completions')).rejects.toThrow('Request outside the provider endpoint');
  });
});

describe('shared provider rules', () => {
  it('fixed hosts, endpoint shapes and labels', () => {
    expect(DIRECT_HOSTS).toMatchObject({ xai: 'https://api.x.ai/v1', moonshot: 'https://api.moonshot.ai/v1', zai: 'https://api.z.ai/api/paas/v4', openrouter: 'https://openrouter.ai/api/v1', vertex: 'https://aiplatform.googleapis.com/v1/publishers/google' });
    expect(isLocalEndpoint('http://127.0.0.1:11434')).toBe(true); expect(isLocalEndpoint('http://127.0.0.1:65535')).toBe(true);
    for (const bad of ['http://localhost:11434', 'http://127.0.0.1:11434/', 'http://127.0.0.2:1', 'http://127.0.0.1:65536', 'http://127.0.0.1:011434', 'https://127.0.0.1:1']) expect(isLocalEndpoint(bad)).toBe(false);
    expect(bedrockEndpoint('us-east-1')).toBe('https://bedrock-runtime.us-east-1.amazonaws.com'); expect(bedrockEndpoint('us-gov-west-1')).toBe('https://bedrock-runtime.us-gov-west-1.amazonaws.com');
    for (const bad of ['', 'us east 1', 'evil.example/x', 'US-EAST-1', 'us-east-1.evil']) expect(bedrockEndpoint(bad)).toBeNull();
    expect(isBedrockEndpoint('https://bedrock-runtime.ap-southeast-2.amazonaws.com')).toBe(true); expect(isBedrockEndpoint('https://bedrock-runtime.x.amazonaws.com.evil.example')).toBe(false);
    for (const p of ['xai', 'moonshot', 'zai', 'openrouter', 'bedrock', 'vertex', 'ollama']) expect(isKeyProvider(p)).toBe(true);
    expect(isKeyProvider('not-a-provider')).toBe(false);
  });

  it('a model is offered only after its test passed', () => {
    const key: KeyView = { id: '00000000-0000-4000-8000-000000000001', provider: 'xai', label: 'grok', last4: 'cdef', deployments: ['grok-5', 'grok-bad', 'grok-new'], lastTest: [{ model: 'grok-5', status: 'ready' }, { model: 'grok-bad', status: 'error', httpStatus: 404 }] };
    expect(testedModels(key)).toEqual(['grok-5']);
    const choices = modelChoices([key]);
    expect(choices.filter(c => c.auth?.kind === 'key').map(c => [c.engine, c.model, c.group])).toEqual([['ai-term', 'grok-5', 'XAI']]);
  });

  it('new providers always run on AI Term\'s agent, even with keys run on the CLI', () => {
    for (const p of ['xai', 'moonshot', 'zai', 'openrouter', 'bedrock', 'vertex', 'ollama'] as const) { expect(keyEngine(p, 'cli')).toBe('ai-term'); expect(keyEngine(p, undefined)).toBe('ai-term'); }
    expect(keyEngine('anthropic', 'cli')).toBe('claude-code');
  });
});

describe('daemon key tests (one tiny request per model before it is offered)', () => {
  it('OpenAI-compatible providers: one Chat Completions ping per model to the fixed host, bearer key, HTTP status only', async () => {
    const calls: ProviderRequest[] = [];
    const results = await testDirect('openrouter', DIRECT_HOSTS.openrouter, ['ok/model', 'bad/model'], KEY, async request => { calls.push(request); return request.model === 'ok/model' ? { status: 200, errorCode: null } : { status: 404, errorCode: KEY }; });
    expect(results).toEqual([{ model: 'ok/model', status: 'ready' }, { model: 'bad/model', status: 'error', httpStatus: 404 }]);
    for (const call of calls) {
      expect(call.url.href).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(call.headers).toEqual({ authorization: `Bearer ${KEY}`, 'content-type': 'application/json' });
      expect(call.body).toEqual({ model: call.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 }); expect(call.timeout).toBe(15000);
    }
    expect(JSON.stringify(results)).not.toContain('AITERMCANARY');
  });

  it('Bedrock: Converse on the bound region; Vertex: generateContent with x-goog-api-key', async () => {
    const calls: ProviderRequest[] = [];
    const record = async (request: ProviderRequest) => { calls.push(request); return { status: 200, errorCode: null }; };
    await testDirect('bedrock', 'https://bedrock-runtime.us-east-1.amazonaws.com', ['us.anthropic.claude-sonnet-5-v1:0'], KEY, record);
    await testDirect('vertex', DIRECT_HOSTS.vertex, ['gemini-3.8-flash'], KEY, record);
    expect(calls[0]?.url.href).toBe(`https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent('us.anthropic.claude-sonnet-5-v1:0')}/converse`);
    expect(calls[0]?.headers).toEqual({ authorization: `Bearer ${KEY}`, 'content-type': 'application/json' });
    expect(calls[0]?.body).toEqual({ messages: [{ role: 'user', content: [{ text: 'ping' }] }], inferenceConfig: { maxTokens: 16 } });
    expect(calls[1]?.url.href).toBe('https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:generateContent');
    expect(calls[1]?.headers).toEqual({ 'x-goog-api-key': KEY, 'content-type': 'application/json' });
  });

  it('refuses a host that is not the provider\'s own, before any request', async () => {
    let calls = 0; const count = async () => { calls++; return { status: 200, errorCode: null }; };
    await expect(testDirect('xai', 'https://evil.example/v1', ['grok'], KEY, count)).rejects.toThrow('Invalid provider test details');
    await expect(testDirect('bedrock', 'https://evil.example', ['m'], KEY, count)).rejects.toThrow('Invalid provider test details');
    await expect(testDirect('xai', DIRECT_HOSTS.xai, [], KEY, count)).rejects.toThrow('Invalid provider test details');
    expect(calls).toBe(0);
  });

  it('a transport failure becomes a fixed reason, never the error text', async () => {
    const results = await testDirect('zai', DIRECT_HOSTS.zai, ['glm-5'], KEY, async () => { throw Object.assign(new Error(`boom ${KEY}`), { code: 'ECONNREFUSED' }); });
    expect(results).toEqual([{ model: 'glm-5', status: 'error', reason: 'Provider connection failed' }]);
  });
});

describe('Ollama listing', () => {
  it('lists valid model names from the local server, at most 40, nothing else', async () => {
    const urls: string[] = [];
    const names = [...Array(45).keys()].map(i => `model-${i}:latest`);
    const models = await listOllama('http://127.0.0.1:11434', async url => { urls.push(url.href); return { status: 200, body: JSON.stringify({ models: [{ name: 'bad name\u001b[31m' }, { name: 'qwen3-coder:30b', size: 1 }, ...names.map(name => ({ name }))] }) }; });
    expect(urls).toEqual(['http://127.0.0.1:11434/api/tags']);
    expect(models).toHaveLength(40); expect(models[0]).toBe('qwen3-coder:30b'); expect(models).not.toContain('bad name\u001b[31m');
  });
  it('refuses any other URL and reports failures with fixed words', async () => {
    let calls = 0;
    await expect(listOllama('http://localhost:11434', async () => { calls++; return { status: 200, body: '{}' }; })).rejects.toThrow('Ollama must be at http://127.0.0.1:<port>');
    expect(calls).toBe(0);
    await expect(listOllama('http://127.0.0.1:11434', async () => ({ status: 500, body: 'secret text' }))).rejects.toThrow('Ollama did not answer');
    await expect(listOllama('http://127.0.0.1:11434', async () => ({ status: 200, body: 'not json' }))).rejects.toThrow('Ollama did not answer');
    await expect(listOllama('http://127.0.0.1:11434', async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); })).rejects.toThrow('Ollama is not running; start it, then test again (t)');
  });
});

describe('protocol and metadata validation', () => {
  const add = (body: Record<string, unknown>) => validateRequest({ id: '00000000-0000-4000-8000-0000000000aa', kind: 'keys.add', label: 'k', ...body });
  it('keys.add: models for model-list providers, a bound region for Bedrock, no secret and a local endpoint for Ollama', async () => {
    await expect(add({ provider: 'xai', secret: KEY, deployments: ['grok-5'] })).resolves.toBeTruthy();
    await expect(add({ provider: 'xai', secret: KEY })).rejects.toThrow('Invalid key details');
    await expect(add({ provider: 'xai', secret: KEY, deployments: ['grok-5'], endpoint: 'https://evil.example/v1' })).rejects.toThrow('Invalid key details');
    await expect(add({ provider: 'bedrock', secret: KEY, deployments: ['m'], endpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com' })).resolves.toBeTruthy();
    await expect(add({ provider: 'bedrock', secret: KEY, deployments: ['m'], endpoint: 'https://evil.example' })).rejects.toThrow('Invalid key details');
    await expect(add({ provider: 'ollama', endpoint: 'http://127.0.0.1:11434' })).resolves.toBeTruthy();
    await expect(add({ provider: 'ollama', endpoint: 'http://127.0.0.1:11434', secret: KEY })).rejects.toThrow('Invalid key details');
    await expect(add({ provider: 'ollama', endpoint: 'http://localhost:11434' })).rejects.toThrow('Invalid key details');
    await expect(add({ provider: 'anthropic' })).rejects.toThrow('Invalid key details');
  });
  it('key metadata: local endpoints only for Ollama, no endpoint for fixed-host providers', () => {
    const base = { id: '00000000-0000-4000-8000-000000000002', label: 'k', last4: '' };
    expect(() => validateKeyView({ ...base, provider: 'ollama', endpoint: 'http://127.0.0.1:11434' })).not.toThrow();
    expect(() => validateKeyView({ ...base, provider: 'foundry', endpoint: 'http://127.0.0.1:11434', deployments: ['x'] })).toThrow();
    expect(() => validateKeyView({ ...base, provider: 'xai', endpoint: 'https://evil.example', deployments: ['x'] })).toThrow();
    expect(() => validateKeyView({ ...base, provider: 'bedrock', endpoint: 'https://evil.example', deployments: ['x'] })).toThrow();
  });
});

describe('prices, spawn args and env', () => {
  const snapshot = { fetchedAt: 'x', providers: { anthropic: {}, openai: {}, azure: {} } } as PriceSnapshot;
  it('a new provider\'s price is its override or unknown (never a crash); Ollama runs on this Mac and is free', () => {
    expect(findPrice(snapshot, 'xai', 'grok-5', {})).toBeUndefined();
    expect(findPrice(snapshot, 'xai', 'grok-5', { 'grok-5': { input: 3, output: 15 } })).toEqual({ input: 3, output: 15, cacheRead: 3 });
    expect(findPrice(snapshot, 'ollama', 'qwen3:8b', {})).toEqual({ input: 0, output: 0, cacheRead: 0 });
  });
  it('the agent takes every provider by argv; Ollama gets an endpoint and no key in its env', () => {
    const built = buildAgentArgs({ command: { node: '/usr/bin/node', entry: '/opt/ai/dist/cli/index.js' }, provider: 'openrouter', model: 'a/b', models: ['a/b'], permission: 'ask', theme: 'slate', transcript: '/tmp/t.jsonl' });
    expect(built.args).toContain('--provider=openrouter'); expect(parseAgentArgs(built.args.slice(2)).provider).toBe('openrouter');
    const env = buildAgentEnv({ PATH: '/bin' }, { secret: null, endpoint: 'http://127.0.0.1:11434', entry: '/opt/ai/dist/cli/index.js' });
    expect(env.AITERM_AGENT_KEY).toBeUndefined(); expect(env.AITERM_AGENT_ENDPOINT).toBe('http://127.0.0.1:11434');
    expect(() => buildAgentEnv({ PATH: '/bin' }, { secret: null, endpoint: 'http://10.0.0.1:11434', entry: '/opt/ai/dist/cli/index.js' })).toThrow('Invalid agent env');
    expect(() => buildAgentEnv({ PATH: '/bin' }, { secret: null, endpoint: null, entry: '/opt/ai/dist/cli/index.js' })).toThrow('Invalid agent env');
    const taken = takeSecrets({ AITERM_AGENT_ENDPOINT: 'http://127.0.0.1:11434' });
    expect(taken).toMatchObject({ key: null, endpoint: 'http://127.0.0.1:11434' });
    expect(takeSecrets({ AITERM_AGENT_ENDPOINT: 'http://10.1.1.1:11434' }).endpoint).toBeNull();
  });
  it('the handoff note writer is never a new provider (keys only to the three it was reviewed for)', () => {
    const local: KeyView = { id: '00000000-0000-4000-8000-000000000003', provider: 'ollama', label: 'local', last4: '', endpoint: 'http://127.0.0.1:11434', deployments: ['m'], lastTest: [{ model: 'm', status: 'ready' }] };
    const xai: KeyView = { id: '00000000-0000-4000-8000-000000000004', provider: 'xai', label: 'x', last4: 'abcd', deployments: ['grok-5'], lastTest: [{ model: 'grok-5', status: 'ready' }] };
    expect(cheapestWriter([local, xai], { priceOverrides: { 'grok-5': { input: 0.1, output: 0.1 } } }, snapshot)).toBeNull();
  });
});
