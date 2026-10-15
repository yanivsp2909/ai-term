// B12: a Foundry key's endpoint and deployments are bound to its secret inside the Keychain entry. settings.json holds a
// copy for display only; a process that edits it can't send the secret anywhere else.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pty from 'node-pty';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { KeyStore, type KeyVault } from '../src/daemon/keys.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { DaemonServer } from '../src/daemon/server.js';
import { Connection } from '../src/client/connection.js';
import * as engines from '../src/daemon/engines.js';
import * as foundry from '../src/daemon/providers/foundry.js';
const secret = 'AITERMCANARY' + '0123456789abcdef', ENDPOINT = 'https://example.openai.azure.com/openai/v1', ATTACKER = 'https://attacker.example/openai/v1';
const CHANGED = 'Foundry key details changed outside AI Term; add the key again', UNBOUND = 'Foundry key must be added again to bind its endpoint';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function store() {
  const root = await mkdtemp(join(tmpdir(), 'ai-key-binding-')); roots.push(root); const paths = getPaths(root); await preparePaths(paths);
  const values = new Map<string, string>(), vault: KeyVault = { read: async a => values.get(a) ?? null, write: async (a, s) => { values.set(a, s); }, remove: async a => { values.delete(a); } };
  return { root, paths, values, keys: new KeyStore(root, { vault }) };
}
// What another process running as the user can do: rewrite the metadata in settings.json.
async function edit(root: string, change: (key: Record<string, unknown>) => void): Promise<void> {
  const file = join(root, 'settings.json'), settings = JSON.parse(await readFile(file, 'utf8')) as { keys: Record<string, unknown>[] };
  for (const key of settings.keys) change(key);
  await writeFile(file, JSON.stringify(settings), { mode: 0o600 });
}
const addFoundry = (keys: KeyStore) => keys.add({ provider: 'foundry', label: 'Azure', secret, endpoint: ENDPOINT, deployments: ['gpt-6.1-sol'] });

it('a Foundry key is stored in the Keychain together with its endpoint and deployments; settings.json has no secret', async () => {
  const s = await store(), key = await addFoundry(s.keys);
  const entry = JSON.parse(s.values.get(`foundry:${key.id}`) ?? '{}') as Record<string, unknown>;
  expect(entry).toEqual({ v: 1, secret, endpoint: ENDPOINT, deployments: ['gpt-6.1-sol'] });
  expect(await readFile(join(s.root, 'settings.json'), 'utf8')).not.toContain('AITERMCANARY');
  const use = vi.fn(() => 'used');
  expect(await s.keys.withSecret(key.id, use)).toBe('used');
  expect(use).toHaveBeenCalledWith(secret, { endpoint: ENDPOINT, deployments: ['gpt-6.1-sol'] });
});

it('a repointed endpoint or changed deployments in settings.json is refused before the secret is used', async () => {
  for (const change of [(k: Record<string, unknown>) => { k.endpoint = ATTACKER; }, (k: Record<string, unknown>) => { k.deployments = ['gpt-6.1-sol', 'other']; }, (k: Record<string, unknown>) => { k.deployments = ['other']; }]) {
    const s = await store(), key = await addFoundry(s.keys);
    await edit(s.root, change);
    const use = vi.fn();
    await expect(s.keys.withSecret(key.id, use)).rejects.toThrow(CHANGED);
    expect(use).not.toHaveBeenCalled();
  }
});

it('a Foundry entry saved before binding (bare secret) or malformed is refused, never trusted on first use', async () => {
  for (const stored of [secret, '{"v":1,"secret":"x"}', `{"v":2,"secret":"${secret}","endpoint":"${ENDPOINT}","deployments":["gpt-6.1-sol"]}`, 'not json {']) {
    const s = await store(), key = await addFoundry(s.keys);
    s.values.set(`foundry:${key.id}`, stored);
    const use = vi.fn();
    await expect(s.keys.withSecret(key.id, use)).rejects.toThrow(UNBOUND);
    expect(use).not.toHaveBeenCalled();
  }
});

it('Anthropic and OpenAI keys keep their plain Keychain entry and no binding', async () => {
  const s = await store(), key = await s.keys.add({ provider: 'openai', label: 'OpenAI', secret });
  expect(s.values.get(`openai:${key.id}`)).toBe(secret);
  const use = vi.fn();
  await s.keys.withSecret(key.id, use);
  expect(use).toHaveBeenCalledWith(secret, null);
});

it('keys.test after a repoint answers with the fixed reason and never sends a request', async () => {
  const s = await store(), log = new Logger(s.paths.log), manager = new SessionManager(s.paths, log, undefined, undefined, undefined, s.keys), server = new DaemonServer(s.paths, manager, log, undefined, s.keys);
  const probe = vi.spyOn(foundry, 'testFoundry').mockResolvedValue([{ model: 'gpt-6.1-sol', status: 'ready' }]);
  let client: Connection | undefined;
  try {
    await manager.load(); await server.listen(); client = await Connection.connect(s.paths, { entry: '/unused', autoStart: false });
    const key = await addFoundry(s.keys);
    await client.request({ kind: 'keys.test', keyId: key.id });
    expect(probe).toHaveBeenLastCalledWith(ENDPOINT, ['gpt-6.1-sol'], secret);
    probe.mockClear(); await edit(s.root, k => { k.endpoint = ATTACKER; });
    await expect(client.request({ kind: 'keys.test', keyId: key.id })).rejects.toThrow(CHANGED);
    expect(probe).not.toHaveBeenCalled();
  } finally { client?.close(); await server.close(); await manager.shutdown(); }
});

it('a Foundry session never spawns with an endpoint that is not the one bound to the key', async () => {
  const s = await store(), manager = new SessionManager(s.paths, new Logger(s.paths.log), undefined, undefined, undefined, s.keys);
  vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: false, authMethod: 'unknown' });
  const spawn = vi.spyOn(pty, 'spawn');
  try {
    await manager.load();
    // The CLI route (D47's fallback); AI Term's agent gets the same binding check (tests/ai-agent-daemon.test.ts).
    await writeFile(join(s.root, 'settings.json'), JSON.stringify({ theme: 'graphite', keysRunOn: 'cli' }), { mode: 0o600 });
    const key = await addFoundry(s.keys); await s.keys.saveTest(key.id, [{ model: 'gpt-6.1-sol', status: 'ready' }]);
    const request = { engine: 'codex' as const, model: 'gpt-6.1-sol', auth: { kind: 'key' as const, keyId: key.id }, cwd: s.root, permission: 'ask' as const };
    await edit(s.root, k => { k.endpoint = ATTACKER; });
    await expect(manager.create(request)).rejects.toThrow(CHANGED);
    // Repointed only while argv is built, restored before the secret is read: the argv endpoint must still match the binding.
    await edit(s.root, k => { k.endpoint = ENDPOINT; });
    const real = s.keys.view.bind(s.keys);
    // v0.6.5: routing reads the key first (its provider decides whether a CLI may run it), then argv is built from it.
    vi.spyOn(s.keys, 'view').mockImplementationOnce(async id => ({ ...(await real(id)), endpoint: ATTACKER })).mockImplementationOnce(async id => ({ ...(await real(id)), endpoint: ATTACKER }));
    await expect(manager.create(request)).rejects.toThrow(CHANGED);
    expect(spawn).not.toHaveBeenCalled();
  } finally { await manager.shutdown(); }
});
