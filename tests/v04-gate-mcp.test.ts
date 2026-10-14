import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { SettingsStore } from '../src/daemon/settings.js';
import { KeyStore, type KeyVault } from '../src/daemon/keys.js';
import { Logger } from '../src/daemon/log.js';
import { McpService } from '../src/daemon/mcp/service.js';
import { mcpConnector } from '../src/daemon/mcp/runtime.js';
import { Agent } from '../src/agent/agent.js';
import { AgentApp } from '../src/agent/app.js';
import { Screen } from '../src/agent/screen.js';
import { Transcript } from '../src/agent/transcript.js';
import { createTheme } from '../src/client/tui/theme.js';
import type { McpAccess } from '../src/shared/mcp.js';
import { stubFacts } from './fixtures/agent-facts.js';

// v0.4 gate, MCP lifecycle: a cancelled call doesn't leave the next one failing, /cd and a daemon shutdown stop the
// servers they leave behind, and a failed rollback still tries to remove every Keychain value it wrote.
const roots: string[] = [], services: McpService[] = [];
afterEach(async () => { for (const s of services.splice(0)) await s.stop('agent'); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(vaultOverride?: Partial<KeyVault>) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'ai-gate-mcp-'))); roots.push(home);
  const cwd = join(home, 'work'), state = join(home, 'state'); await mkdir(cwd); await mkdir(join(state, 'logs'), { recursive: true });
  const values = new Map<string, string>(), vault: KeyVault = { read: async n => values.get(n) ?? null, write: async (n, v) => { values.set(n, v); }, remove: async n => { values.delete(n); }, ...vaultOverride };
  const keys = new KeyStore(state, { vault }), log = new Logger(join(state, 'logs/daemon.log'));
  const service = new McpService(new SettingsStore(state), keys, log, home, mcpConnector(keys)); services.push(service);
  return { home, cwd, state, values, keys, service };
}
// A stdio server that writes its pid, then answers initialize, tools/list and an echo.
const SERVER = (pidFile: string) => `import {createInterface} from 'node:readline';import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
const tools=[{name:'echo',description:'Echo',inputSchema:{type:'object',properties:{message:{type:'string'}}}}];
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'s',version:'1'}}:m.method==='tools/list'?{tools}:{content:[{type:'text',text:'echo '+m.params.arguments.message}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});
process.stdin.on('end',()=>{});setInterval(()=>{},1000);`;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function server(f: Awaited<ReturnType<typeof fixture>>) {
  const pidFile = join(f.home, 'server.pid'), path = join(f.home, 'server.mjs'); await writeFile(path, SERVER(pidFile));
  await f.service.query('agent', { kind: 'mcp.add', config: { name: 'local', type: 'stdio', command: process.execPath, args: [path], env: [] }, values: {} });
  const s = (await f.service.list(f.cwd)).servers[0]; if (!s) throw new Error('missing server');
  return { s, pid: async () => Number(await readFile(pidFile, 'utf8')) };
}

it('after Esc or Ctrl+K cancels MCP work, the next call to the selected tool works instead of failing', async () => {
  const f = await fixture(), { s } = await server(f);
  await f.service.query('agent', { kind: 'mcp.schema', cwd: f.cwd, serverId: s.id, hash: s.hash, tool: 'echo' });
  expect((await f.service.query('agent', { kind: 'mcp.call', cwd: f.cwd, serverId: s.id, hash: s.hash, tool: 'echo', arguments: { message: 'one' } })).mcpResult).toContain('echo one');
  await f.service.query('agent', { kind: 'mcp.cancel' });
  expect((await f.service.query('agent', { kind: 'mcp.call', cwd: f.cwd, serverId: s.id, hash: s.hash, tool: 'echo', arguments: { message: 'two' } })).mcpResult).toContain('echo two');
});

it('a daemon shutdown stops every running MCP server before it returns', async () => {
  const f = await fixture(), { s, pid } = await server(f);
  await f.service.query('agent', { kind: 'mcp.discover', cwd: f.cwd, serverId: s.id, hash: s.hash });
  const running = await pid(); expect(alive(running)).toBe(true);
  await f.service.shutdown();
  // SIGKILL went to the whole group; the child is gone once Node reaps it.
  await vi.waitFor(() => expect(alive(running)).toBe(false), { timeout: 2000 });
});

it('/cd stops the servers the old folder started', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-gate-mcp-cd-'))); roots.push(root); await mkdir(join(root, 'b'));
  const stop = vi.fn(async () => {}), model = new MockLanguageModelV4({ doStream: [] });
  const mcp: McpAccess = { list: async () => ({ servers: [], notes: [], tokens: 0 }), add: async () => {}, remove: async () => {}, toggle: async () => ({ servers: [], notes: [], tokens: 0 }), approve: async () => {}, discover: async () => ({ servers: [], notes: [], tokens: 0 }), schema: async () => ({}), call: async () => '', stop };
  let out = '';
  const app = new AgentApp({ screen: new Screen({ write: t => { out += t; }, columns: 100, rows: 30 }, createTheme('graphite')), permission: 'ask', models: ['m1'], quit: vi.fn(), makeModel: async () => model,
    agent: io => new Agent({ root, permission: 'ask', model, modelId: 'm1', instructions: { text: '', files: [], notes: [] }, reporter: { status: async () => {}, usage: async () => true, facts: async () => stubFacts() }, transcript: new Transcript(null, t => t, () => {}), io, redact: t => t, bashEnv: {}, rg: null, mcp }) });
  app.start(); app.input('/cd b\r');
  await vi.waitFor(() => expect(out).toContain(`folder: ${join(root, 'b')}`));
  expect(stop).toHaveBeenCalledOnce();
  app.close();
});

it('a rollback that fails to remove one Keychain value still removes the others and says so in the log', async () => {
  const removed: string[] = [];
  const g = await fixture({ remove: async n => { removed.push(n); if (n.endsWith(':TOKEN_A')) throw new Error('locked'); } });
  await g.keys.saveMcp('0123456789abcdef', 'TOKEN_A', 'value-a-1234567890', 'f'.repeat(64));
  await g.keys.saveMcp('0123456789abcdef', 'TOKEN_B', 'value-b-1234567890', 'f'.repeat(64));
  await expect(g.keys.removeMcp('0123456789abcdef', ['TOKEN_A', 'TOKEN_B'])).rejects.toThrow('MCP keychain remove failed');
  expect(removed).toEqual(['mcp:0123456789abcdef:TOKEN_A', 'mcp:0123456789abcdef:TOKEN_B']);
  // An add whose second write fails rolls back the first; that removal failing too is logged, never silent.
  let writes = 0;
  const f = await fixture({ write: async () => { if (writes++ === 1) throw new Error('keychain full'); }, remove: async () => { throw new Error('locked'); } });
  await expect(f.service.query('agent', { kind: 'mcp.add', config: { name: 'two', type: 'stdio', command: '/bin/echo', args: [], env: ['TOKEN_A', 'TOKEN_B'] }, values: { TOKEN_A: 'value-a-1234567890', TOKEN_B: 'value-b-1234567890' } })).rejects.toThrow();
  await vi.waitFor(async () => expect(await readFile(join(f.state, 'logs/daemon.log'), 'utf8')).toContain('MCP keychain cleanup failed'));
});
