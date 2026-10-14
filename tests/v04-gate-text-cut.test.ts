import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseExtension } from '../src/agent/extensions/frontmatter.js';
import { parseCodexAgent } from '../src/agent/extensions/toml.js';
import { SettingsStore } from '../src/daemon/settings.js';
import { KeyStore, type KeyVault } from '../src/daemon/keys.js';
import { Logger } from '../src/daemon/log.js';
import { McpService } from '../src/daemon/mcp/service.js';
import { mcpConnector } from '../src/daemon/mcp/runtime.js';
import { validateExtensionCatalog } from '../src/shared/validate.js';
import { extensionTokens } from '../src/shared/extensions.js';

// v0.4 gate: a cut at 240 characters or a last-four suffix must never split an emoji. Half a surrogate pair is a
// control character to the validators, which then refused the whole catalog and failed every agent turn.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const description = 'a'.repeat(239) + '😀 and more';
const catalogOf = (parsed: { name: string; description: string }) => ({ items: [{ id: '0'.repeat(16), kind: 'agent' as const, name: parsed.name, description: parsed.description, source: 'shared' as const, enabled: true, tokens: extensionTokens(parsed.description) }], notes: [], tokens: extensionTokens(parsed.description) });

it('a skill, agent or Codex agent description cut at 240 keeps the catalog valid', () => {
  for (const parsed of [parseExtension(`---\nname: s\ndescription: ${description}\n---\nbody`, 'skill', 's'), parseCodexAgent(`name = "c"\ndescription = "${description}"\ninstructions = "body"\n`, 'c')]) {
    expect(parsed.description.length).toBeLessThanOrEqual(240);
    expect(() => validateExtensionCatalog(catalogOf(parsed))).not.toThrow();
  }
});

async function service(fetchFn?: typeof fetch) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'ai-gate-cut-'))); roots.push(home);
  const cwd = join(home, 'work'), state = join(home, 'state'); await mkdir(cwd); await mkdir(state);
  const values = new Map<string, string>(), vault: KeyVault = { read: async n => values.get(n) ?? null, write: async (n, v) => { values.set(n, v); }, remove: async n => { values.delete(n); } };
  const keys = new KeyStore(state, { vault });
  return { cwd, keys, service: new McpService(new SettingsStore(state), keys, new Logger(join(state, 'logs/daemon.log')), home, mcpConnector(keys, fetchFn)) };
}

it('an MCP tool description cut at 240 keeps the MCP list valid after discovery', async () => {
  const tools = [{ name: 'echo', description, inputSchema: { type: 'object' } }];
  const fetchFn: typeof fetch = async (_input, init) => {
    const m = JSON.parse(String(init?.body)) as { id?: string; method: string };
    if (m.id === undefined) return new Response(null, { status: 202 });
    const result = m.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } } : { tools };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }), { headers: { 'content-type': 'application/json' } });
  };
  const f = await service(fetchFn);
  try {
    await f.service.query('agent', { kind: 'mcp.add', config: { name: 'remote', type: 'http', url: 'https://stub.invalid/mcp', headers: [] }, values: {} });
    const s = (await f.service.list(f.cwd)).servers[0]; if (!s) throw new Error('missing server');
    await f.service.query('agent', { kind: 'mcp.discover', cwd: f.cwd, serverId: s.id, hash: s.hash });
    const listed = (await f.service.list(f.cwd)).servers[0]?.available[0]?.description ?? '';
    expect(listed.startsWith('a'.repeat(239))).toBe(true);
    expect(listed.length).toBeLessThanOrEqual(240);
  } finally { await f.service.stop('agent'); }
});

it('a value whose last four characters would split an emoji shows no suffix instead of breaking the list', async () => {
  const f = await service();
  await writeFile(join(f.cwd, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: 'node', args: ['s.js'], env: { TOKEN: 'project-value-123👋abc' } } } }));
  const listed = await f.service.list(f.cwd);
  expect(listed.servers.map(s => s.values)).toEqual([[{ name: 'TOKEN', last4: '' }]]);
  expect(await f.keys.saveMcp('0123456789abcdef', 'TOKEN', 'own-value-1234567👋abc', 'f'.repeat(64))).toBe('');
  expect(await f.keys.saveMcp('0123456789abcdef', 'TOKEN', 'own-value-1234567890', 'f'.repeat(64))).toBe('7890');
});
