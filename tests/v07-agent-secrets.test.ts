import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import pty from 'node-pty';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { UsageService } from '../src/daemon/usage-service.js';
import { KeyStore } from '../src/daemon/keys.js';
import * as engines from '../src/daemon/engines.js';
import { reporterEnv } from '../src/agent/report.js';
import { takeSecrets } from '../src/agent/main.js';
import { runBash } from '../src/agent/bash.js';
import { buildBashEnv } from '../src/daemon/env.js';

// Yaniv, during the v0.7 gate: "in Don't ask mode, a hijacked agent could set its own model's price to $0 and get past
// your budgets". A command the agent runs could read the agent's status token (and its API key) from the process's
// environment (`ps -E` shows a process's starting env to the same user), then call the daemon as the agent; it could also
// write ~/.ai-term/settings.json or talk to AI Term's socket as you. Now the key and tokens reach the agent in a 0600 file
// it reads and deletes before anything runs, and on macOS every bash command runs in a sandbox that can't read or write
// AI Term's folder (except the agent's own worktree) or connect to its sockets.
const MAC = process.platform === 'darwin', cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const SECRET = 'AITERMCANARY-secrets-0123456789abcdef';

it('the key and the tokens never sit in the agent\'s environment: a 0600 file the agent reads and deletes carries them', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-secrets-'))), paths = getPaths(root); await preparePaths(paths);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'settings.json'), JSON.stringify({ theme: 'graphite', worktrees: 'off' }), { mode: 0o600 });
  const log = new Logger(paths.log), usage = new UsageService(root, log), vault = new Map<string, string>();
  const keys = new KeyStore(root, { vault: { read: async a => vault.get(a) ?? null, write: async (a, s) => { vault.set(a, s); }, remove: async a => { vault.delete(a); } } });
  const manager = new SessionManager(paths, log, undefined, undefined, undefined, keys, usage, '/opt/ai-term/dist/cli/index.js');
  await usage.start(); await manager.load();
  cleanups.push(async () => { await manager.shutdown(); await usage.close(); });
  const spawned: Record<string, string>[] = [], real = pty.spawn;
  vi.spyOn(pty, 'spawn').mockImplementation((_file, _args, options) => { spawned.push({ ...(options?.env as Record<string, string>) }); return real('/bin/sh', ['-c', 'printf ready; read done'], { ...options, env: { PATH: '/usr/bin:/bin' } }); });
  vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' });
  const key = await keys.add({ provider: 'foundry', label: 'f', secret: SECRET, endpoint: 'https://secrets.openai.azure.com/openai/v1', deployments: ['gpt-6.1-sol'] });
  await keys.saveTest(key.id, [{ model: 'gpt-6.1-sol', status: 'ready' }]);
  await manager.create({ engine: 'ai-term', model: 'gpt-6.1-sol', auth: { kind: 'key', keyId: key.id }, cwd: root, permission: 'dontAsk' });
  const env = spawned.at(-1) ?? {};
  expect(JSON.stringify(env)).not.toContain(SECRET);
  for (const name of ['AITERM_AGENT_KEY', 'AITERM_STATUS_TOKEN', 'AITERM_USAGE_TOKEN']) expect(env[name]).toBeUndefined();
  expect(env.AITERM_HOME).toBe(root);
  const file = env.AITERM_AGENT_SECRETS ?? '';
  expect(file.startsWith(join(root, 'sessions'))).toBe(true);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(await readFile(file, 'utf8')).toContain(SECRET);
  expect(reporterEnv(env)).toMatchObject({ port: Number(env.AITERM_STATUS_PORT), status: expect.stringMatching(/^[a-f0-9]{64}$/) });
  const own = { ...env }, taken = takeSecrets(own);
  expect(taken).toMatchObject({ key: SECRET, endpoint: 'https://secrets.openai.azure.com/openai/v1', reporter: { status: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  expect(own.AITERM_AGENT_SECRETS).toBeUndefined();
  await expect(stat(file)).rejects.toThrow();
}, 30_000);

it.skipIf(!MAC)('macOS (skipped elsewhere: sandbox-exec is macOS only): a bash command can\'t read or write AI Term\'s folder or reach its sockets; it works in its own worktree as before', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-bash-sbx-'))), folder = join(root, 'worktrees', 'r', 'agent');
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(folder, { recursive: true }); await mkdir(join(root, 'run'));
  await writeFile(join(root, 'settings.json'), '{"budgets":{"daily":3}}');
  const socket = join(root, 'run', 'd.sock'); let connected = 0;
  const server = createServer(s => { connected++; s.end(); }); await new Promise<void>(resolve => server.listen(socket, resolve)); cleanups.push(async () => { server.close(); });
  const env = buildBashEnv(process.env);
  const result = await runBash([
    `cat "${root}/settings.json" > read.txt`, `echo '{"budgets":{}}' > "${root}/settings.json"`,
    `node -e 'require("net").connect("${socket}").on("connect",()=>require("fs").writeFileSync("sock.txt","connected")).on("error",()=>{})'`,
    'echo own > own.txt', 'head -c 3 /etc/hosts > outside.txt', 'true',
  ].join('\n'), { cwd: folder, env, sandbox: { home: root } });
  expect(result.exitCode).toBe(0);
  expect(await readFile(join(folder, 'read.txt'), 'utf8')).toBe('');
  expect(await readFile(join(root, 'settings.json'), 'utf8')).toBe('{"budgets":{"daily":3}}');
  await expect(stat(join(folder, 'sock.txt'))).rejects.toThrow(); expect(connected).toBe(0);
  expect(await readFile(join(folder, 'own.txt'), 'utf8')).toBe('own\n');
  expect((await readFile(join(folder, 'outside.txt'), 'utf8')).length).toBe(3);
}, 30_000);
