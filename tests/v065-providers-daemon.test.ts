import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pty from 'node-pty';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { UsageService } from '../src/daemon/usage-service.js';
import { KeyStore } from '../src/daemon/keys.js';
import * as engines from '../src/daemon/engines.js';

// v0.6.5 (Part A) in the daemon: keys for the new providers live in the Keychain like any other (Ollama has none), a model
// starts only after its test passed, a new provider never reaches a CLI, and the key reaches only the agent's env.
const SECRET = 'AITERMCANARY-v065d-0123456789abcdef';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

async function setup(settings: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-v065-'))), paths = getPaths(root); await preparePaths(paths);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'settings.json'), JSON.stringify({ theme: 'slate', worktrees: 'off', ...settings }), { mode: 0o600 });
  const log = new Logger(paths.log), usage = new UsageService(root, log), vault = new Map<string, string>(), ops: string[] = [];
  const keys = new KeyStore(root, { vault: { read: async a => { ops.push(`read ${a}`); return vault.get(a) ?? null; }, write: async (a, s) => { ops.push(`write ${a}`); vault.set(a, s); }, remove: async a => { ops.push(`remove ${a}`); vault.delete(a); } } });
  const manager = new SessionManager(paths, log, undefined, undefined, undefined, keys, usage, '/opt/ai-term/dist/cli/index.js');
  await usage.start(); await manager.load();
  cleanups.push(async () => { await manager.shutdown(); await usage.close(); });
  const spawned: { file: string; args: string[]; env: Record<string, string> }[] = [];
  const real = pty.spawn;
  vi.spyOn(pty, 'spawn').mockImplementation((file, args, options) => {
    spawned.push({ file, args: Array.isArray(args) ? [...args] : [], env: { ...(options?.env as Record<string, string>) } });
    return real('/bin/sh', ['-c', 'printf ready; read done'], { ...options, env: { PATH: '/usr/bin:/bin' } });
  });
  vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' });
  return { root, paths, manager, keys, vault, ops, spawned };
}

it('an xAI key starts AI Term\'s agent on a tested model only, with the key only in its env', async () => {
  const d = await setup({ keysRunOn: 'cli' });
  const key = await d.keys.add({ provider: 'xai', label: 'grok', secret: SECRET, deployments: ['grok-5', 'grok-untested'] });
  await expect(d.manager.create({ engine: 'ai-term', model: 'grok-5', auth: { kind: 'key', keyId: key.id }, cwd: d.root, permission: 'ask' })).rejects.toThrow('Model must pass its test first; test the key in /settings (t)');
  await d.keys.saveTest(key.id, [{ model: 'grok-5', status: 'ready' }, { model: 'grok-untested', status: 'error', httpStatus: 404 }]);
  await expect(d.manager.create({ engine: 'ai-term', model: 'grok-untested', auth: { kind: 'key', keyId: key.id }, cwd: d.root, permission: 'ask' })).rejects.toThrow('Model must pass its test first; test the key in /settings (t)');
  // keysRunOn: 'cli' can't send it to a CLI: no CLI can use an xAI key.
  const session = await d.manager.create({ engine: 'codex', model: 'grok-5', auth: { kind: 'key', keyId: key.id }, cwd: d.root, permission: 'ask' });
  expect(session).toMatchObject({ engine: 'ai-term', model: 'grok-5', auth: { kind: 'key', provider: 'xai', last4: 'cdef' } });
  const run = d.spawned.at(-1); if (!run) throw new Error('no spawn');
  expect(run.args).toContain('--provider=xai'); expect(run.args).toContain('--models=grok-5');
  expect(run.env.AITERM_AGENT_KEY).toBe(SECRET); expect(run.env.AITERM_AGENT_ENDPOINT).toBeUndefined();
  expect(run.args.join(' ')).not.toContain(SECRET); expect(await readFile(d.paths.state, 'utf8')).not.toContain(SECRET);
});

it('a new provider\'s key never starts a CLI, even when the request names one', async () => {
  const d = await setup();
  const key = await d.keys.add({ provider: 'moonshot', label: 'kimi', secret: SECRET, deployments: ['kimi-k3'] });
  await d.keys.saveTest(key.id, [{ model: 'kimi-k3', status: 'ready' }]);
  // Second guard behind routing: if a CLI start ever got past route(), the CLI branch refuses the key itself.
  vi.spyOn(d.manager as unknown as { route(r: unknown): Promise<unknown> }, 'route').mockImplementation(async request => request);
  for (const engine of ['codex', 'claude-code'] as const)
    await expect(d.manager.create({ engine, model: 'kimi-k3', auth: { kind: 'key', keyId: key.id }, cwd: d.root, permission: 'ask' })).rejects.toThrow('Key provider does not match engine');
  expect(d.spawned).toEqual([]);
});

it('Bedrock binds its region in the Keychain; a changed copy in settings.json refuses the key', async () => {
  const d = await setup();
  const key = await d.keys.add({ provider: 'bedrock', label: 'aws', secret: SECRET, endpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com', deployments: ['us.anthropic.claude-sonnet-5-v1:0'] });
  expect(JSON.parse(d.vault.get(`bedrock:${key.id}`) ?? '{}')).toEqual({ v: 1, secret: SECRET, endpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com', deployments: ['us.anthropic.claude-sonnet-5-v1:0'] });
  await d.keys.saveTest(key.id, [{ model: 'us.anthropic.claude-sonnet-5-v1:0', status: 'ready' }]);
  const session = await d.manager.create({ engine: 'ai-term', model: 'us.anthropic.claude-sonnet-5-v1:0', auth: { kind: 'key', keyId: key.id }, cwd: d.root, permission: 'ask' });
  expect(session.engine).toBe('ai-term');
  const run = d.spawned.at(-1);
  expect(run?.env.AITERM_AGENT_ENDPOINT).toBe('https://bedrock-runtime.us-east-1.amazonaws.com'); expect(run?.env.AITERM_AGENT_KEY).toBe(SECRET);
  const settings = JSON.parse(await readFile(join(d.root, 'settings.json'), 'utf8')) as { keys: { endpoint?: string }[] };
  settings.keys = settings.keys.map(k => ({ ...k, endpoint: 'https://bedrock-runtime.eu-west-1.amazonaws.com' }));
  await writeFile(join(d.root, 'settings.json'), JSON.stringify(settings), { mode: 0o600 });
  await expect(d.keys.withSecret(key.id, () => 'used')).rejects.toThrow('Bedrock key details changed outside AI Term; add the key again');
});

it('Ollama: no Keychain entry at all, models from the local listing, the endpoint only in the agent\'s env', async () => {
  const d = await setup();
  const key = await d.keys.add({ provider: 'ollama', label: 'local', endpoint: 'http://127.0.0.1:11434' });
  expect(key).toMatchObject({ provider: 'ollama', last4: '', endpoint: 'http://127.0.0.1:11434' });
  await d.keys.saveModels(key.id, ['qwen3-coder:30b', 'llama4:8b']);
  expect(await d.keys.view(key.id)).toMatchObject({ deployments: ['qwen3-coder:30b', 'llama4:8b'], lastTest: [{ model: 'qwen3-coder:30b', status: 'ready' }, { model: 'llama4:8b', status: 'ready' }] });
  const session = await d.manager.create({ engine: 'ai-term', model: 'llama4:8b', auth: { kind: 'key', keyId: key.id }, cwd: d.root, permission: 'ask' });
  expect(session).toMatchObject({ engine: 'ai-term', auth: { kind: 'key', provider: 'ollama' } });
  const run = d.spawned.at(-1);
  expect(run?.args).toContain('--provider=ollama'); expect(run?.env.AITERM_AGENT_ENDPOINT).toBe('http://127.0.0.1:11434'); expect(run?.env.AITERM_AGENT_KEY).toBeUndefined();
  await expect(d.keys.withSecret(key.id, () => 'used')).rejects.toThrow('Ollama has no key');
  await d.keys.remove(key.id);
  expect(d.ops.filter(op => op.includes('ollama'))).toEqual([]);
  expect(await d.keys.list()).toEqual([]);
});

it('agent facts price an Ollama model at zero and an xAI model by its override', async () => {
  const d = await setup({ priceOverrides: { 'grok-5': { input: 2, output: 10 } } });
  const xai = await d.keys.add({ provider: 'xai', label: 'grok', secret: SECRET, deployments: ['grok-5'] });
  await d.keys.saveTest(xai.id, [{ model: 'grok-5', status: 'ready' }]);
  const local = await d.keys.add({ provider: 'ollama', label: 'local', endpoint: 'http://127.0.0.1:11434' });
  await d.keys.saveModels(local.id, ['qwen3:8b']);
  const a = await d.manager.create({ engine: 'ai-term', model: 'grok-5', auth: { kind: 'key', keyId: xai.id }, cwd: d.root, permission: 'ask' });
  const b = await d.manager.create({ engine: 'ai-term', model: 'qwen3:8b', auth: { kind: 'key', keyId: local.id }, cwd: d.root, permission: 'ask' });
  expect((await d.manager.agentFacts(a.id, { model: 'grok-5' }))?.price).toEqual({ input: 2, output: 10, cacheRead: 2 });
  expect((await d.manager.agentFacts(b.id, { model: 'qwen3:8b' }))?.price).toEqual({ input: 0, output: 0, cacheRead: 0 });
});
