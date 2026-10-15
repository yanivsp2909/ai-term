import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { prepareSandbox, SECRET_PATHS, toolchainPaths } from '../src/daemon/test-sandbox.js';
import { runTests } from '../src/daemon/test-run.js';
import { ProcessTree } from '../src/daemon/process-tree.js';
import { buildTestEnv, buildBashEnv } from '../src/daemon/env.js';
import { savePrice } from '../src/daemon/price-migration.js';
import { SettingsStore } from '../src/daemon/settings.js';
import { Agent } from '../src/agent/agent.js';
import { AgentApp } from '../src/agent/app.js';
import { Screen } from '../src/agent/screen.js';
import { Transcript } from '../src/agent/transcript.js';
import { pricePauseText } from '../src/agent/limits.js';
import type { Reporter } from '../src/agent/report.js';
import { createTheme } from '../src/client/tui/theme.js';
import { testLines } from '../src/client/tui/test-ask.js';
import { validateRequest } from '../src/shared/validate.js';
import { stubFacts } from './fixtures/agent-facts.js';
import type { ModelPrice } from '../src/shared/protocol.js';

// Part A review (security-reviewer, typescript-reviewer, fresh context): each finding below failed before its fix.
const MAC = process.platform === 'darwin', roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-a-review-'))); roots.push(dir); return dir; }

it('MEDIUM (security): credential files inside toolchain folders stay closed; /var/tmp is hidden too', async () => {
  for (const name of ['.m2/settings.xml', '.m2/settings-security.xml', '.gradle/gradle.properties', '.gradle/init.d', '.config/mise/config.toml']) expect(SECRET_PATHS).toContain(name);
  const dir = await temp(), tree = join(dir, 'tree'); await mkdir(tree);
  const box = await prepareSandbox(tree, { home: join(dir, 'home'), private: [], loopback: false });
  try { expect(box.spec.hidden).toContain('/private/var/tmp'); } finally { await box.dispose(); }
});

it.skipIf(!MAC)('macOS (skipped elsewhere: sandbox-exec is macOS only): ~/.m2/settings.xml is unreadable while ~/.m2/repository stays readable', async () => {
  const dir = await temp(), home = join(dir, 'home'), tree = join(dir, 'tree');
  await mkdir(join(home, '.m2', 'repository'), { recursive: true }); await mkdir(tree);
  await writeFile(join(home, '.m2', 'settings.xml'), '<password>MAVEN-SECRET</password>\n'); await writeFile(join(home, '.m2', 'repository', 'lib.txt'), 'library\n');
  await writeFile(join(tree, 'probe.sh'), '#!/bin/sh\ncat "$HOME/.m2/settings.xml" > settings.txt\ncat "$HOME/.m2/repository/lib.txt" > lib.txt\nexit 0\n'); await chmod(join(tree, 'probe.sh'), 0o755);
  const env = { ...buildTestEnv(process.env), HOME: home }, box = await prepareSandbox(tree, { home, private: [], loopback: false, env });
  try { await runTests(['./probe.sh'], tree, { ...env, ...box.env }, { timeoutMs: 20_000, sandbox: box }); } finally { await box.dispose(); }
  expect(await readFile(join(tree, 'settings.txt'), 'utf8')).toBe('');
  expect(await readFile(join(tree, 'lib.txt'), 'utf8')).toBe('library\n');
}, 30_000);

it('LOW (TS review): a bin folder right under home opens only itself, not its parent (~/Documents/bin never opens ~/Documents); a dropped path is logged', async () => {
  const paths = toolchainPaths('/Users/me', { PATH: '/Users/me/Documents/bin:/Users/me/.nvm/versions/node/v22/bin:/Users/me/.pub-cache/bin' });
  expect(paths).toContain('/Users/me/Documents/bin'); expect(paths).not.toContain('/Users/me/Documents');
  expect(paths).toContain('/Users/me/.nvm/versions/node/v22'); expect(paths).toContain('/Users/me/.pub-cache');
  const dir = await temp(), tree = join(dir, 'tree'), log = vi.fn(); await mkdir(tree);
  const box = await prepareSandbox(tree, { home: join(dir, 'home'), private: [], loopback: false, readable: [join(dir, 'odd "repo"', '.git')], log });
  await box.dispose();
  expect(log).toHaveBeenCalledWith('Test sandbox: a folder with quotes, parentheses or control characters in its path stays closed to tests');
  expect(JSON.stringify(log.mock.calls)).not.toContain('odd');
});

it('LOW (TS review): stopping a run that never looked at its processes doesn\'t adopt a reused process id as its own', async () => {
  const stranger = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  try {
    if (stranger.pid === undefined) throw new Error('no pid');
    expect(await new ProcessTree(stranger.pid).stop()).toBe(0);
    expect(stranger.exitCode).toBeNull(); expect(stranger.signalCode).toBeNull();
  } finally { stranger.kill('SIGKILL'); }
});

it('MEDIUM (TS review): a price you save in /settings p goes through the daemon\'s own queue, so a price saved at a pause meanwhile is kept', async () => {
  const root = await temp();
  await Promise.all([savePrice(root, 'foundry', 'from-pause', { input: 1, output: 2 }), savePrice(root, 'foundry', 'from-settings', { input: 3, output: 4 }), savePrice(root, 'xai', 'grok-x', { input: 5, output: 6, cacheRead: 1 })]);
  expect((await new SettingsStore(root).get()).providerPrices).toEqual({ foundry: { 'from-pause': { input: 1, output: 2 }, 'from-settings': { input: 3, output: 4 } }, xai: { 'grok-x': { input: 5, output: 6, cacheRead: 1 } } });
  const id = randomUUID();
  await expect(validateRequest({ id, kind: 'prices.set', provider: 'openrouter', model: 'vendor/model', price: { input: 0, output: 0 } })).resolves.toMatchObject({ provider: 'openrouter' });
  for (const bad of [{ provider: 'anthropic', model: 'm', price: { input: 1, output: 1 } }, { provider: 'xai', model: '-bad', price: { input: 1, output: 1 } }, { provider: 'xai', model: 'm', price: { input: -1, output: 1 } }])
    await expect(validateRequest({ id, kind: 'prices.set', ...bad })).rejects.toThrow();
});

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: undefined }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
const reply = { stream: convertArrayToReadableStream([{ type: 'stream-start' as const, warnings: [] }, { type: 'text-start' as const, id: 't' }, { type: 'text-delta' as const, id: 't', delta: 'ok' }, { type: 'text-end' as const, id: 't' }, { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage }]) };
async function pausedApp(provider: 'anthropic' | 'openrouter' | null, answer: 'saved' | 'full' = 'saved') {
  const root = await temp(), saved: ModelPrice[] = [];
  const reporter: Reporter = { status: async () => {}, usage: async () => true, facts: async () => stubFacts({ model: 'mystery', price: saved[0] ?? null, budgets: { daily: 3, weekly: null, monthly: null } }),
    reserve: async () => ({ grant: { id: randomUUID() } }), settle: async () => {}, priceInfo: async () => provider ? { provider, guess: null } : null,
    setPrice: async (_m, price) => { if (answer === 'full') return 'full'; saved.push(price); return 'saved'; } };
  let out = ''; const screen = new Screen({ write: t => { out += t; }, columns: 160, rows: 40 }, createTheme('graphite'));
  const model = new MockLanguageModelV4({ doStream: [reply] });
  const app = new AgentApp({ screen, permission: 'ask', models: ['mystery'], quit: vi.fn(), makeModel: async () => model,
    agent: io => new Agent({ root, permission: 'ask', model, modelId: 'mystery', instructions: { text: '', files: [], notes: [] }, reporter, transcript: new Transcript(null, t => t, () => {}), io, redact: t => t, bashEnv: buildBashEnv(process.env), rg: null }) });
  app.start(); app.input('go\r');
  return { app, saved, out: () => stripVTControlCharacters(out), raw: () => out };
}

it('MEDIUM (TS review): p is offered only where a price can be saved (not Anthropic or OpenAI, not when the daemon didn\'t say); a full price list says so', async () => {
  expect(pricePauseText('mystery', null, true, 16_000)).toBe("no price known for mystery, so your budgets can't count it · ⏎ checks again · Esc stops");
  expect(pricePauseText('mystery', 'anthropic', true, 16_000)).not.toContain('p sets');
  for (const provider of ['anthropic', null] as const) {
    const s = await pausedApp(provider);
    await vi.waitFor(() => expect(s.out()).toContain("no price known for mystery, so your budgets can't count it · ⏎ checks again"));
    s.app.input('p'); await new Promise(resolve => setTimeout(resolve, 80));
    expect(s.out()).not.toContain('price for mystery'); s.app.close();
  }
  const full = await pausedApp('openrouter', 'full');
  await vi.waitFor(() => expect(full.out()).toContain('p sets its price'));
  full.app.input('p'); full.app.input('1 / 2\r');
  await vi.waitFor(() => expect(full.out()).toContain('AI Term keeps at most 100 prices · change one in /settings p · Esc back'));
  full.app.close();
});

it('LOW (TS review): a paste into the price line drops control characters before they are drawn', async () => {
  const s = await pausedApp('openrouter');
  await vi.waitFor(() => expect(s.out()).toContain('p sets its price'));
  s.app.input('p'); s.app.input('\x1b[200~1\x07 / 2\x1b]0;x\x07\x1b[201~');
  await vi.waitFor(() => expect(s.out()).toContain('› 1 / 2'));
  expect(s.raw()).not.toContain('\x07'); expect(s.raw()).not.toContain('\x1b]0;');
  s.app.input('\r');
  await vi.waitFor(() => expect(s.saved).toEqual([{ input: 1, output: 2 }]));
  s.app.close();
});

it('LOW (security): the 127.0.0.1 switch says what it opens', () => {
  const plan = { title: 'fixer', command: ['npm', 'test'], cwd: '/tmp/t', changed: [], fingerprint: 'a'.repeat(64), sandbox: true, loopback: false };
  expect(testLines(plan).map(line => line.text)).toContain('127.0.0.1: off · l allows it for this project (any local service, like a dev database)');
});
