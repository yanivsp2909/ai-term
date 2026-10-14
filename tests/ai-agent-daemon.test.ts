import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pty from 'node-pty';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { UsageService } from '../src/daemon/usage-service.js';
import { KeyStore } from '../src/daemon/keys.js';
import * as engines from '../src/daemon/engines.js';
import { HttpReporter, reporterEnv } from '../src/agent/report.js';
import { parseAgentArgs } from '../src/agent/main.js';

// The daemon side of AI Term's agent: D47 routing, the spawn (argv and env from env.ts, key bound in the Keychain), and
// status and usage arriving through the shared receiver exactly as the agent's reporter sends them.
const SECRET = 'AITERMCANARY-daemon-0123456789abcdef', ENDPOINT = 'https://narvis-resource.openai.azure.com/openai/v1';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

async function daemon(settings: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-agent-daemon-'))), paths = getPaths(root); await preparePaths(paths);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'settings.json'), JSON.stringify({ theme: 'slate', worktrees: 'off', ...settings }), { mode: 0o600 });
  const log = new Logger(paths.log), usage = new UsageService(root, log), vault = new Map<string, string>();
  const keys = new KeyStore(root, { vault: { read: async a => vault.get(a) ?? null, write: async (a, s) => { vault.set(a, s); }, remove: async a => { vault.delete(a); } } });
  const manager = new SessionManager(paths, log, undefined, undefined, undefined, keys, usage, '/opt/ai-term/dist/cli/index.js');
  await usage.start(); await manager.load();
  cleanups.push(async () => { await manager.shutdown(); await usage.close(); });
  const spawned: { file: string; args: string[]; env: Record<string, string>; cwd: string }[] = [];
  const real = pty.spawn;
  vi.spyOn(pty, 'spawn').mockImplementation((file, args, options) => {
    spawned.push({ file, args: Array.isArray(args) ? [...args] : [], env: { ...(options?.env as Record<string, string>) }, cwd: String(options?.cwd) });
    return real('/bin/sh', ['-c', 'printf ready; read done'], { ...options, env: { PATH: '/usr/bin:/bin' } });
  });
  vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' });
  const foundry = await keys.add({ provider: 'foundry', label: 'narvis', secret: SECRET, endpoint: ENDPOINT, deployments: ['gpt-6.1-sol', 'gpt-6-luna', 'kimi-k3'] });
  await keys.saveTest(foundry.id, [{ model: 'gpt-6.1-sol', status: 'ready' }, { model: 'gpt-6-luna', status: 'ready' }, { model: 'kimi-k3', status: 'not a chat model' }]);
  return { root, paths, manager, usage, keys, foundry, spawned };
}

it('a Foundry key starts AI Term\'s agent: Ask by default, tested deployments only, the key only in its env', async () => {
  const d = await daemon(), before = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-from-shell'; cleanups.push(async () => { if (before === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before; });
  const session = await d.manager.create({ engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', auth: { kind: 'key', keyId: d.foundry.id }, cwd: d.root, permission: 'ask', firstMessage: 'edit README' });
  expect(session).toMatchObject({ engine: 'ai-term', title: 'AI Term', model: 'gpt-6.1-sol', effort: null, authMethod: 'api-key', auth: { kind: 'key', provider: 'foundry', last4: 'cdef' } });
  const run = d.spawned.at(-1); if (!run) throw new Error('no spawn');
  expect(run.file).toBe(process.execPath);
  const transcript = join(d.root, 'sessions', session.id, 'transcript.jsonl');
  expect(run.args).toEqual(['/opt/ai-term/dist/cli/index.js', 'agent', '--model=gpt-6.1-sol', '--models=gpt-6.1-sol,gpt-6-luna', '--theme=slate', `--transcript=${transcript}`, '--ask', '--', 'edit README']);
  expect(parseAgentArgs(run.args.slice(2))).toMatchObject({ model: 'gpt-6.1-sol', permission: 'ask', theme: 'slate', firstMessage: 'edit README' });
  expect((await stat(join(d.root, 'sessions', session.id))).mode & 0o777).toBe(0o700);
  expect(run.env.AITERM_AGENT_KEY).toBe(SECRET); expect(run.env.AITERM_AGENT_ENDPOINT).toBe(ENDPOINT);
  expect(run.env.OPENAI_API_KEY).toBeUndefined(); expect(run.env.AITERM_FOUNDRY_KEY).toBeUndefined();
  expect(run.args.join(' ')).not.toContain(SECRET);
  expect(await readFile(d.paths.state, 'utf8')).not.toContain(SECRET); expect(JSON.stringify(d.manager.list())).not.toContain(SECRET);
  expect(await readFile(d.paths.log, 'utf8').catch(() => '')).not.toContain(SECRET);
  const dontAsk = await d.manager.create({ engine: 'ai-term', model: 'gpt-6-luna', auth: { kind: 'key', keyId: d.foundry.id }, cwd: d.root, permission: 'dontAsk' });
  expect(dontAsk.permission).toBe('dontAsk'); expect(d.spawned.at(-1)?.args).toContain('--dont-ask'); expect(d.spawned.at(-1)?.args).not.toContain('--ask');
  await expect(d.manager.create({ engine: 'ai-term', model: 'kimi-k3', auth: { kind: 'key', keyId: d.foundry.id }, cwd: d.root, permission: 'ask' })).rejects.toThrow('must pass its test first');
  await expect(d.manager.resume(session.id)).rejects.toThrow();
});

it('the fallback setting sends keys to the CLI; account logins and keys the agent lacks always start the CLIs', async () => {
  const d = await daemon({ keysRunOn: 'cli' });
  expect((await d.manager.create({ engine: 'codex', model: 'gpt-6.1-sol', auth: { kind: 'key', keyId: d.foundry.id }, cwd: d.root, permission: 'ask' })).engine).toBe('codex');
  expect(d.spawned.at(-1)?.env.AITERM_FOUNDRY_KEY).toBe(SECRET);
  const routed = await daemon();
  expect((await routed.manager.create({ engine: 'codex', model: null, auth: { kind: 'account' }, cwd: routed.root, permission: 'ask' })).engine).toBe('codex');
  const anthropic = await routed.keys.add({ provider: 'anthropic', label: 'a', secret: 'sk-ant-AITERMCANARY0000000000' });
  expect((await routed.manager.create({ engine: 'claude-code', model: null, auth: { kind: 'key', keyId: anthropic.id }, cwd: routed.root, permission: 'ask' })).engine).toBe('claude-code');
  await expect(routed.manager.create({ engine: 'ai-term', model: null, auth: { kind: 'key', keyId: anthropic.id }, cwd: routed.root, permission: 'ask' })).rejects.toThrow("can't use this key yet");
});

it('status and usage from the agent\'s reporter reach the card, the last reply and Usage', async () => {
  const d = await daemon();
  const session = await d.manager.create({ engine: 'ai-term', model: 'gpt-6.1-sol', auth: { kind: 'key', keyId: d.foundry.id }, cwd: d.root, permission: 'ask' });
  const env = d.spawned.at(-1)?.env ?? {}, reporter = new HttpReporter(reporterEnv(env), () => { throw new Error('report failed'); });
  await expect.poll(() => d.manager.get(session.id).status).toBe('running');
  await reporter.status({ event: 'turn-start' }); await reporter.status({ event: 'tool-start', tool: 'bash' }); await reporter.status({ event: 'permission' });
  expect(d.manager.get(session.id)).toMatchObject({ status: 'waiting', statusDetail: 'permission', lastActivity: { tool: 'bash' } });
  await expect(d.manager.send(session.id, 'y')).rejects.toThrow('Agent is asking for permission');
  await reporter.status({ event: 'answered' });
  expect(d.manager.get(session.id).status).toBe('running');
  await expect(d.manager.send(session.id, 'y')).rejects.toThrow('Agent is running a tool');
  await reporter.status({ event: 'tool-finish', tool: 'bash' }); await reporter.status({ event: 'done', reply: 'Changed README.' });
  expect(d.manager.get(session.id).status).toBe('done');
  expect((await d.manager.text(session.id, true)).text).toBe('Changed README.');
  await reporter.status({ event: 'model', model: 'gpt-6-luna' }); expect(d.manager.get(session.id).model).toBe('gpt-6-luna');
  await reporter.status({ event: 'model', model: 'kimi-k3' }); expect(d.manager.get(session.id).model).toBe('gpt-6-luna');
  await reporter.status({ event: 'turn-failed', error: 'rate_limit' }); expect(d.manager.get(session.id)).toMatchObject({ status: 'waiting', statusDetail: 'turn failed: rate_limit' });
  await reporter.usage('gpt-6-luna', { input: 1200, cached: 200, output: 300 });
  await expect.poll(() => d.usage.summary().today.tokens).toBe(1500);
  expect(d.usage.summary().today.providers).toEqual([expect.objectContaining({ provider: 'foundry', tokens: 1500, cachedTokens: 200 })]);
  expect(reporter.failures).toBe(0);
  // Another engine's path refuses this credential (S12: each status credential reaches only its own engine's route).
  const wrong = await fetch(`http://127.0.0.1:${env.AITERM_STATUS_PORT}/v1/status/claude`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ai-term-session': env.AITERM_STATUS_TOKEN ?? '' }, body: JSON.stringify({ hook_event_name: 'Stop' }) });
  expect(wrong.status).toBe(204); expect(d.manager.get(session.id).statusDetail).toBe('turn failed: rate_limit');
  await d.manager.stop(session.id); await d.manager.remove(session.id);
  await expect(stat(join(d.root, 'sessions', session.id, 'transcript.jsonl'))).rejects.toThrow();
});

it('B12 holds for AI Term\'s agent: a repointed endpoint or deployment in settings.json never gets the key', async () => {
  const d = await daemon(), file = join(d.root, 'settings.json');
  const settings = JSON.parse(await readFile(file, 'utf8')) as { keys: { endpoint: string; deployments: string[] }[] };
  for (const key of settings.keys) { key.endpoint = 'https://attacker.example/openai/v1'; }
  await writeFile(file, JSON.stringify(settings), { mode: 0o600 });
  const spawns = d.spawned.length;
  await expect(d.manager.create({ engine: 'ai-term', model: 'gpt-6.1-sol', auth: { kind: 'key', keyId: d.foundry.id }, cwd: d.root, permission: 'ask' })).rejects.toThrow('changed outside AI Term');
  for (const key of settings.keys) { key.endpoint = ENDPOINT; key.deployments = ['gpt-6.1-sol', 'gpt-6-luna', 'kimi-k3', 'gpt-evil']; }
  await writeFile(file, JSON.stringify(settings), { mode: 0o600 });
  await expect(d.manager.create({ engine: 'ai-term', model: 'gpt-6.1-sol', auth: { kind: 'key', keyId: d.foundry.id }, cwd: d.root, permission: 'ask' })).rejects.toThrow('changed outside AI Term');
  expect(d.spawned.length).toBe(spawns);
});
