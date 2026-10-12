import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { testFoundry } from '../src/daemon/providers/foundry.js';
import { checkEngine } from '../src/daemon/engines.js';
import { KeyStore, type KeyVault } from '../src/daemon/keys.js';
import { validateDeploymentTests, validateEngineStatus } from '../src/shared/validate.js';

afterEach(() => vi.restoreAllMocks());
it('B17 Foundry failures retain only fixed network, timeout and reply-size causes', async () => {
  const errors = [Object.assign(new Error('AITERMCANARY'), { code: 'ETIMEDOUT' }), Object.assign(new Error('AITERMCANARY'), { code: 'ECONNRESET' }), new Error('AITERMCANARY')];
  const reasons = ['Provider request timed out', 'Provider connection failed', 'Provider request failed'];
  for (const [i, error] of errors.entries()) {
    const result = await testFoundry('https://example.com', ['gpt'], 'fake-value', async () => { throw error; });
    expect(result).toEqual([{ model: 'gpt', status: 'error', reason: reasons[i] }]);
    expect(() => validateDeploymentTests(result)).not.toThrow(); expect(JSON.stringify(result)).not.toContain('AITERMCANARY');
  }
  expect(() => validateDeploymentTests([{ model: 'gpt', status: 'error', reason: 'AITERMCANARY' }])).toThrow();
});
it('B17 engine runner failures preserve installation and a fixed cause without raw output', async () => {
  const root = await mkdtemp('/tmp/ai-b17-engine-');
  try {
    await writeFile(join(root, 'codex'), 'stub', { mode: 0o700 });
    for (const phase of ['version', 'login']) {
      const status = await checkEngine('codex', { PATH: root }, async (_file, args) => { if ((args[0] === '--version') === (phase === 'version')) throw new Error('AITERMCANARY'); return { code: 0, stdout: args[0] === '--version' ? '1.2.3' : 'Logged in using ChatGPT', stderr: '' }; });
      expect(status).toMatchObject({ installed: true, error: phase === 'version' ? 'Engine version check failed' : 'Engine login check failed' });
      expect(() => validateEngineStatus(status)).not.toThrow(); expect(JSON.stringify(status)).not.toContain('AITERMCANARY');
    }
    expect(() => validateEngineStatus({ installed: true, path: '/stub', version: null, loggedIn: null, authMethod: 'unknown', error: 'AITERMCANARY' })).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('B17 keyring failures wrap a fixed operation cause and never retain a raw cause', async () => {
  const root = await mkdtemp('/tmp/ai-b17-vault-');
  const values = new Map<string, string>(); let fail = '';
  const vault: KeyVault = { read: async id => { if (fail === 'read') throw new Error('AITERMCANARY'); return values.get(id) ?? null; }, write: async (id, secret) => { if (fail === 'write') throw new Error('AITERMCANARY'); values.set(id, secret); }, remove: async id => { if (fail === 'remove') throw new Error('AITERMCANARY'); values.delete(id); } };
  const store = new KeyStore(root, { vault });
  try {
    const key = await store.add({ provider: 'anthropic', label: 'test', secret: 'fake-value' });
    for (const operation of ['write', 'read', 'remove']) {
      fail = operation;
      const task = operation === 'write' ? store.add({ provider: 'anthropic', label: 'fail', secret: 'fake-value' }) : operation === 'read' ? store.withSecret(key.id, () => true) : store.remove(key.id);
      const error: unknown = await task.catch(e => e);
      expect(error).toMatchObject({ cause: expect.objectContaining({ message: `Keychain ${operation} failed` }) });
      expect(String(error) + String((error as Error).cause)).not.toContain('AITERMCANARY');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('B17 skips and reports one malformed metadata entry, keeping other keys removable', async () => {
  const root = await mkdtemp('/tmp/ai-b17-metadata-');
  const vault: KeyVault = { read: async () => null, write: async () => {}, remove: vi.fn(async () => {}) };
  const store = new KeyStore(root, { vault });
  try {
    const key = { id: randomUUID(), provider: 'anthropic', label: 'good', last4: '' };
    await writeFile(join(root, 'settings.json'), JSON.stringify({ theme: 'graphite', keys: [key, { id: randomUUID(), provider: 'bad', label: 'AITERMCANARY' }] }));
    expect(await store.list()).toEqual([key]); expect(await store.list()).toEqual([key]);
    await store.remove(key.id); expect(vault.remove).toHaveBeenCalledWith(`anthropic:${key.id}`); expect(await store.list()).toEqual([]);
    const text = await readFile(join(root, 'logs/daemon.log'), 'utf8'); expect(text.match(/Invalid key metadata entry skipped/g)).toHaveLength(1); expect(text).not.toContain('AITERMCANARY');
  } finally { await rm(root, { recursive: true, force: true }); }
});
