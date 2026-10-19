import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamText } from 'ai';
import { Agent } from 'node:https';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LookupAddress } from 'node:dns';
import pty from 'node-pty';
import { makeModel, type ModelSpec } from '../src/agent/provider.js';
import { DIRECT_HOSTS, NO_STREAM_USAGE_OPTION, PROVIDER_LABELS, PROVIDER_REGIONS, isDirectProvider, regionLine } from '../src/shared/providers.js';
import { testDirect } from '../src/daemon/providers/direct.js';
import { providerTransportWithAgent, type ProviderRequest } from '../src/daemon/providers/foundry.js';
import { listLocalOpenAI } from '../src/daemon/providers/local-openai.js';
import { publicLookup } from '../src/shared/public-host.js';
import { validateRequest, validateSession } from '../src/shared/validate.js';
import { keyEngine, modelChoices } from '../src/shared/models.js';
import { findPrice, type PriceSnapshot } from '../src/daemon/usage-prices.js';
import { PRICED_BY_YOU } from '../src/shared/prices.js';
import priceData from '../data/usage-prices.json' with { type: 'json' };
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { UsageService } from '../src/daemon/usage-service.js';
import { KeyStore } from '../src/daemon/keys.js';
import * as engines from '../src/daemon/engines.js';
import { readAgentSecrets } from '../src/agent/report.js';
import { cardText } from '../src/client/tui/agent-card.js';
import type { KeyProvider, KeyView, SessionInfo } from '../src/shared/protocol.js';

// Part A (2026-10-19): more fixed-host providers (a region is a provider of its own), LM Studio and any OpenAI-compatible
// server on this machine (no key), and a custom https endpoint bound to its key, public addresses only.
const KEY = 'AITERMCANARY-partA-0123456789abcdef';
interface Seen { url: string; headers: Headers; redirect?: RequestRedirect; body: string }
async function oneRequest(spec: ModelSpec): Promise<Seen> {
  const seen: Seen[] = [];
  const fake: typeof fetch = async (input, init) => {
    seen.push({ url: input instanceof Request ? input.url : String(input), headers: new Headers(init?.headers), redirect: init?.redirect, body: String(init?.body ?? '') });
    return new Response(JSON.stringify({ error: { message: `refused ${KEY}` } }), { status: 401, headers: { 'content-type': 'application/json' } });
  };
  const result = streamText({ model: makeModel(spec, fake), prompt: 'ping', maxRetries: 0, onError: () => undefined });
  for await (const part of result.stream) void part;
  const request = seen[0]; if (!request) throw new Error('no request');
  expect(seen).toHaveLength(1); expect(request.redirect).toBe('error'); expect(request.url).not.toContain(KEY); expect(request.body).not.toContain(KEY);
  return request;
}
const NEW_HOSTS: Partial<Record<KeyProvider, string>> = {
  'moonshot-cn': 'https://api.moonshot.cn/v1', 'zai-cn': 'https://open.bigmodel.cn/api/paas/v4', gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  mistral: 'https://api.mistral.ai/v1', groq: 'https://api.groq.com/openai/v1', cerebras: 'https://api.cerebras.ai/v1', together: 'https://api.together.ai/v1', fireworks: 'https://api.fireworks.ai/inference/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai', huggingface: 'https://router.huggingface.co/v1', deepseek: 'https://api.deepseek.com',
  qwen: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'qwen-cn': 'https://dashscope.aliyuncs.com/compatible-mode/v1', minimax: 'https://api.minimax.io/v1', 'minimax-cn': 'https://api.minimax.cn/v1',
  ark: 'https://ark.cn-beijing.volces.com/api/v3', byteplus: 'https://ark.ap-southeast.bytepluses.com/api/v3', 'byteplus-eu': 'https://ark.eu-west.bytepluses.com/api/v3',
  siliconflow: 'https://api.siliconflow.com/v1', 'siliconflow-cn': 'https://api.siliconflow.cn/v1', qianfan: 'https://api.baiduqianfan.ai/v1', 'qianfan-cn': 'https://qianfan.baidubce.com/v2',
  hunyuan: 'https://tokenhub.tencentmaas.com/v1', stepfun: 'https://api.stepfun.ai/v1', 'stepfun-cn': 'https://api.stepfun.com/v1',
};

describe('fixed-host providers', () => {
  it('each new provider has the official host its docs give, a label and a region line', () => {
    expect(DIRECT_HOSTS).toMatchObject(NEW_HOSTS);
    for (const provider of Object.keys(PROVIDER_LABELS) as KeyProvider[]) { expect(PROVIDER_REGIONS[provider], provider).not.toBe(''); expect(regionLine(provider)).toMatch(/^requests go to /); }
    expect(regionLine('moonshot-cn')).toContain('China'); expect(regionLine('qwen')).toContain('Singapore'); expect(regionLine('lmstudio')).toBe('requests go to this machine only');
  });

  for (const [provider, host] of Object.entries(NEW_HOSTS) as [KeyProvider, string][])
    it(`${provider}: its fixed host's Chat Completions, the key as its bearer token only, a passed endpoint ignored`, async () => {
      const seen = await oneRequest({ provider, model: 'vendor/model-1', key: KEY, endpoint: 'https://evil.example/v1' });
      expect(seen.url).toBe(`${host}/chat/completions`); expect(seen.headers.get('authorization')).toBe(`Bearer ${KEY}`);
      for (const name of ['api-key', 'x-api-key', 'x-goog-api-key']) expect(seen.headers.get(name)).toBeNull();
      const body = JSON.parse(seen.body) as Record<string, unknown>;
      // Usage in the stream is asked for only where the provider documents the option (Mistral refuses unknown fields).
      if (NO_STREAM_USAGE_OPTION.has(provider)) expect(body).not.toHaveProperty('stream_options'); else expect(body).toMatchObject({ stream_options: { include_usage: true } });
    });

  it('a new provider\'s key runs only on AI Term\'s agent, even with keys set to run on a CLI', () => {
    for (const provider of Object.keys(NEW_HOSTS) as KeyProvider[]) expect(keyEngine(provider, 'cli')).toBe('ai-term');
    expect(keyEngine('custom', 'cli')).toBe('ai-term'); expect(keyEngine('lmstudio', 'cli')).toBe('ai-term');
  });

  it('the tiny model test goes to the fixed host only, never to a host passed in', async () => {
    const sent: ProviderRequest[] = [];
    const results = await testDirect('deepseek', DIRECT_HOSTS.deepseek, ['deepseek-v4-flash'], KEY, async request => { sent.push(request); return { status: 200, errorCode: null }; });
    expect(results).toEqual([{ model: 'deepseek-v4-flash', status: 'ready' }]); expect(sent[0]?.url.href).toBe('https://api.deepseek.com/chat/completions');
    await expect(testDirect('deepseek', 'https://evil.example', ['m'], KEY, async () => ({ status: 200, errorCode: null }))).rejects.toThrow('Invalid provider test details');
  });

  it('prices come from each provider\'s own Models.dev table where it has one; the rest wait for your price; servers here are free', () => {
    const snapshot = priceData as unknown as PriceSnapshot;
    expect(findPrice(snapshot, 'deepseek', 'deepseek-v4-flash', {})).toMatchObject({ input: 0.15, output: 0.6 });
    expect(findPrice(snapshot, 'byteplus', 'seed-1', {})).toBeUndefined(); expect(findPrice(snapshot, 'custom', 'gpt-oss', {})).toBeUndefined();
    expect(findPrice(snapshot, 'byteplus', 'seed-1', { 'seed-1': { input: 1, output: 2 } })).toMatchObject({ input: 1, output: 2 });
    expect(findPrice(snapshot, 'lmstudio', 'qwen3', {})).toEqual({ input: 0, output: 0, cacheRead: 0 });
    // Another provider's table never answers: DeepSeek's table holds no Qwen model.
    expect(findPrice(snapshot, 'deepseek', 'qwen3-max', {})).toBeUndefined();
    for (const provider of ['custom', 'byteplus', 'lmstudio', 'gemini'] as const) expect(PRICED_BY_YOU).toContain(provider);
    expect(PRICED_BY_YOU).not.toContain('anthropic');
  });
});

describe('servers on this machine', () => {
  it('LM Studio and any local server: http://127.0.0.1 only, no key header at all', async () => {
    for (const provider of ['lmstudio', 'local'] as const) {
      const seen = await oneRequest({ provider, model: 'qwen3-coder', key: null, endpoint: 'http://127.0.0.1:1234' });
      expect(seen.url).toBe('http://127.0.0.1:1234/v1/chat/completions'); expect(seen.headers.get('authorization')).toBeNull();
      for (const endpoint of ['http://localhost:1234', 'http://10.0.0.2:1234', 'https://127.0.0.1:1234', 'http://127.0.0.1'])
        expect(() => makeModel({ provider, model: 'm', key: null, endpoint })).toThrow(`Invalid ${PROVIDER_LABELS[provider]} settings`);
      expect(() => makeModel({ provider, model: 'm', key: KEY, endpoint: 'http://127.0.0.1:1234' })).toThrow();
    }
  });

  it('their models come from GET /v1/models: valid ids only, at most 40; nothing there says so', async () => {
    const asked: string[] = [];
    const ids = await listLocalOpenAI('http://127.0.0.1:1234', async url => { asked.push(url.href); return { status: 200, body: JSON.stringify({ data: [{ id: 'qwen3-coder' }, { id: 'bad id\u001b' }, { id: 'qwen3-coder' }, { nope: 1 }, ...Array.from({ length: 50 }, (_, i) => ({ id: `m${i}` }))] }) }; });
    expect(asked).toEqual(['http://127.0.0.1:1234/v1/models']); expect(ids[0]).toBe('qwen3-coder'); expect(ids).not.toContain('bad id\u001b'); expect(ids).toHaveLength(40);
    await expect(listLocalOpenAI('http://localhost:1234')).rejects.toThrow('The server must be at http://127.0.0.1:<port>');
    await expect(listLocalOpenAI('http://127.0.0.1:1234', async () => { throw Object.assign(new Error('x /Users/me'), { code: 'ECONNREFUSED' }); })).rejects.toThrow('Nothing answers at that port; start the server, then test again (t)');
    await expect(listLocalOpenAI('http://127.0.0.1:1234', async () => ({ status: 200, body: 'not json' }))).rejects.toThrow('The server did not answer with a model list');
  });
});

describe('custom endpoint', () => {
  it('requests go to the endpoint bound to the key, with its key, and only to a public https endpoint', async () => {
    const seen = await oneRequest({ provider: 'custom', model: 'gpt-oss-120b', key: KEY, endpoint: 'https://llm.example.com/v1/' });
    expect(seen.url).toBe('https://llm.example.com/v1/chat/completions'); expect(seen.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    for (const endpoint of [null, 'http://llm.example.com/v1', 'https://127.0.0.1/v1', 'https://localhost/v1', 'https://10.0.0.8/v1', 'https://printer.local/v1'])
      expect(() => makeModel({ provider: 'custom', model: 'm', key: KEY, endpoint })).toThrow('Invalid Custom OpenAI-compatible endpoint settings');
    expect(() => makeModel({ provider: 'custom', model: 'm', key: null, endpoint: 'https://llm.example.com/v1' })).toThrow();
  });

  it('its test connects only to public addresses: a name that resolves here is refused with a fixed reason', async () => {
    const resolver = (address: string) => (_host: string, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => callback(null, [{ address, family: 4 }]);
    const transport = providerTransportWithAgent(new Agent({ lookup: publicLookup(resolver('127.0.0.1')) }));
    expect(await testDirect('custom', 'https://llm.example.com/v1', ['m1'], KEY, transport)).toEqual([{ model: 'm1', status: 'error', reason: 'Provider address is not on the public internet' }]);
    await expect(testDirect('custom', 'https://192.168.1.4/v1', ['m1'], KEY, transport)).rejects.toThrow('Invalid provider test details');
  });

  it('adding one needs the word add; local servers take no key; the request shapes are checked', async () => {
    const id = '6f1c4f53-3a1e-4bb0-9a49-3f3f3f3f3f3f', base = { id, kind: 'keys.add', label: 'mine', secret: KEY, endpoint: 'https://llm.example.com/v1', deployments: ['m1'] };
    await expect(validateRequest({ ...base, provider: 'custom', confirm: 'add' })).resolves.toMatchObject({ provider: 'custom' });
    for (const bad of [{ ...base, provider: 'custom' }, { ...base, provider: 'custom', confirm: 'yes' }, { ...base, provider: 'custom', confirm: 'add', endpoint: 'https://10.0.0.1/v1' },
      { ...base, provider: 'custom', confirm: 'add', deployments: [] }, { ...base, provider: 'deepseek', endpoint: undefined, confirm: 'add' }, { id, kind: 'keys.add', provider: 'lmstudio', label: 'l', secret: KEY, endpoint: 'http://127.0.0.1:1234' }])
      await expect(validateRequest(bad), JSON.stringify(bad)).rejects.toThrow('Invalid key details');
    await expect(validateRequest({ id, kind: 'keys.add', provider: 'lmstudio', label: 'l', endpoint: 'http://127.0.0.1:1234' })).resolves.toMatchObject({ provider: 'lmstudio' });
  });

  it('its card names the host; only a custom key may carry one', () => {
    const info: SessionInfo = { id: '6f1c4f53-3a1e-4bb0-9a49-3f3f3f3f3f3f', title: 'AI Term', engine: 'ai-term', model: 'gpt-oss-120b', permission: 'ask', cwd: '/tmp', status: 'running', statusDetail: 'running', statusSince: '2026-10-19T08:00:00.000Z', createdAt: '2026-10-19T08:00:00.000Z', lastActivity: null, lastOutputAt: null, exitCode: null, ctxPercent: null,
      auth: { kind: 'key', keyId: '7f1c4f53-3a1e-4bb0-9a49-3f3f3f3f3f3f', provider: 'custom', keyLabel: 'mine', last4: 'cdef', host: 'llm.example.com' } };
    expect(validateSession(info).auth).toMatchObject({ host: 'llm.example.com' });
    expect(cardText(info, Date.parse('2026-10-19T08:00:05.000Z'), 120).auth).toContain('API key ····cdef · llm.example.com');
    expect(() => validateSession({ ...info, auth: { ...info.auth, provider: 'deepseek' } })).toThrow();
    expect(() => validateSession({ ...info, auth: { ...info.auth, host: 'evil\u001b[2J' } })).toThrow();
    const local: SessionInfo = { ...info, auth: { kind: 'key', keyId: info.auth.kind === 'key' ? info.auth.keyId : '', provider: 'lmstudio', keyLabel: 'LM Studio', last4: '' } };
    expect(cardText(local, Date.parse('2026-10-19T08:00:05.000Z'), 120).auth).toContain('local · no key');
  });

  it('the model picker groups a custom key under its host and a local server under this Mac', () => {
    const keys: KeyView[] = [{ id: '7f1c4f53-3a1e-4bb0-9a49-3f3f3f3f3f3f', provider: 'custom', label: 'mine', last4: 'cdef', endpoint: 'https://llm.example.com/v1', deployments: ['m1'], lastTest: [{ model: 'm1', status: 'ready' }] },
      { id: '8f1c4f53-3a1e-4bb0-9a49-3f3f3f3f3f3f', provider: 'lmstudio', label: 'LM Studio', last4: '', endpoint: 'http://127.0.0.1:1234', deployments: ['qwen3'], lastTest: [{ model: 'qwen3', status: 'ready' }] }];
    const choices = modelChoices(keys);
    expect(choices.find(c => c.model === 'm1')).toMatchObject({ engine: 'ai-term', group: 'CUSTOM · llm.example.com' });
    expect(choices.find(c => c.model === 'qwen3')).toMatchObject({ engine: 'ai-term', group: 'LM STUDIO · this Mac', authLabel: 'local · no key' });
  });
});

describe('in the daemon', () => {
  const SECRET = 'AITERMCANARY-partAd-0123456789abcdef';
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
  async function setup() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-partA-'))), paths = getPaths(root); await preparePaths(paths);
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'settings.json'), JSON.stringify({ theme: 'slate', worktrees: 'off' }), { mode: 0o600 });
    const log = new Logger(paths.log), usage = new UsageService(root, log), vault = new Map<string, string>();
    const keys = new KeyStore(root, { vault: { read: async a => vault.get(a) ?? null, write: async (a, s) => { vault.set(a, s); }, remove: async a => { vault.delete(a); } } });
    const manager = new SessionManager(paths, log, undefined, undefined, undefined, keys, usage, '/opt/ai-term/dist/cli/index.js');
    await usage.start(); await manager.load();
    cleanups.push(async () => { await manager.shutdown(); await usage.close(); });
    const spawned: { args: string[]; env: Record<string, string> }[] = [], real = pty.spawn;
    vi.spyOn(pty, 'spawn').mockImplementation((_file, args, options) => { spawned.push({ args: Array.isArray(args) ? [...args] : [], env: { ...(options?.env as Record<string, string>) } }); return real('/bin/sh', ['-c', 'printf ready; read done'], { ...options, env: { PATH: '/usr/bin:/bin' } }); });
    vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' });
    return { root, paths, manager, keys, vault, spawned };
  }

  it('a custom endpoint is bound in the Keychain, needs add, and reaches the agent only from the Keychain\'s copy', async () => {
    const d = await setup(), endpoint = 'https://llm.example.com/v1';
    await expect(d.keys.add({ provider: 'custom', label: 'mine', secret: SECRET, endpoint, deployments: ['m1'] })).rejects.toThrow('Type add to send this key to a custom endpoint');
    await expect(d.keys.add({ provider: 'custom', label: 'mine', secret: SECRET, endpoint: 'https://169.254.169.254/latest', deployments: ['m1'], confirm: 'add' })).rejects.toThrow();
    const key = await d.keys.add({ provider: 'custom', label: 'mine', secret: SECRET, endpoint, deployments: ['m1'], confirm: 'add' });
    expect(JSON.parse(d.vault.get(`custom:${key.id}`) ?? '{}')).toEqual({ v: 1, secret: SECRET, endpoint, deployments: ['m1'] });
    await d.keys.saveTest(key.id, [{ model: 'm1', status: 'ready' }]);
    const session = await d.manager.create({ engine: 'ai-term', model: 'm1', auth: { kind: 'key', keyId: key.id }, cwd: d.root, permission: 'ask' });
    expect(session.auth).toMatchObject({ kind: 'key', provider: 'custom', host: 'llm.example.com' });
    const run = d.spawned.at(-1); if (!run) throw new Error('no spawn');
    expect(run.args).toContain('--provider=custom'); expect(readAgentSecrets(run.env)).toMatchObject({ AITERM_AGENT_KEY: SECRET, AITERM_AGENT_ENDPOINT: endpoint });
    expect(run.args.join(' ')).not.toContain(SECRET); expect(await readFile(d.paths.state, 'utf8')).not.toContain(SECRET);
    // settings.json is anyone's to edit as you: a changed endpoint there refuses the key instead of following it.
    const settings = JSON.parse(await readFile(join(d.root, 'settings.json'), 'utf8')) as { keys: KeyView[] };
    await writeFile(join(d.root, 'settings.json'), JSON.stringify({ ...settings, keys: settings.keys.map(k => ({ ...k, endpoint: 'https://evil.example.org/v1' })) }), { mode: 0o600 });
    await expect(d.manager.create({ engine: 'ai-term', model: 'm1', auth: { kind: 'key', keyId: key.id }, cwd: d.root, permission: 'ask' })).rejects.toThrow('Custom endpoint details changed outside AI Term; add the key again');
  });

  it('a region\'s key is bound by its Keychain account: moving it to the other region in settings.json finds no key', async () => {
    const d = await setup();
    const key = await d.keys.add({ provider: 'moonshot-cn', label: 'kimi', secret: SECRET, deployments: ['kimi-k3'] });
    expect(d.vault.has(`moonshot-cn:${key.id}`)).toBe(true);
    await d.keys.saveTest(key.id, [{ model: 'kimi-k3', status: 'ready' }]);
    const settings = JSON.parse(await readFile(join(d.root, 'settings.json'), 'utf8')) as { keys: KeyView[] };
    await writeFile(join(d.root, 'settings.json'), JSON.stringify({ ...settings, keys: settings.keys.map(k => ({ ...k, provider: 'moonshot' })) }), { mode: 0o600 });
    await expect(d.manager.create({ engine: 'ai-term', model: 'kimi-k3', auth: { kind: 'key', keyId: key.id }, cwd: d.root, permission: 'ask' })).rejects.toThrow('Key is missing from the OS keychain');
  });

  it('LM Studio has no Keychain entry; its agent gets the local endpoint and no key', async () => {
    const d = await setup();
    await expect(d.keys.add({ provider: 'lmstudio', label: 'LM Studio', secret: SECRET, endpoint: 'http://127.0.0.1:1234' })).rejects.toThrow('Invalid key details');
    const key = await d.keys.add({ provider: 'lmstudio', label: 'LM Studio', endpoint: 'http://127.0.0.1:1234' });
    expect(d.vault.size).toBe(0);
    await d.keys.saveModels(key.id, ['qwen3-coder']);
    await expect(d.keys.withSecret(key.id, () => 'used')).rejects.toThrow('A server on this machine has no key');
    await d.manager.create({ engine: 'ai-term', model: 'qwen3-coder', auth: { kind: 'key', keyId: key.id }, cwd: d.root, permission: 'ask' });
    const run = d.spawned.at(-1); if (!run) throw new Error('no spawn');
    expect(run.args).toContain('--provider=lmstudio'); expect(readAgentSecrets(run.env)).toMatchObject({ AITERM_AGENT_ENDPOINT: 'http://127.0.0.1:1234' });
    expect(readAgentSecrets(run.env).AITERM_AGENT_KEY).toBeUndefined();
    await d.keys.remove(key.id); expect(await d.keys.list()).toEqual([]);
  });

  it('every fixed-host provider is a direct provider', () => { for (const provider of Object.keys(NEW_HOSTS) as KeyProvider[]) expect(isDirectProvider(provider)).toBe(true); });
});
