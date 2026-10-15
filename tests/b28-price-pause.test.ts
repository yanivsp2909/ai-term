import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { randomUUID } from 'node:crypto';
import pty from 'node-pty';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { Agent } from '../src/agent/agent.js';
import { AgentApp } from '../src/agent/app.js';
import { Screen } from '../src/agent/screen.js';
import { Transcript } from '../src/agent/transcript.js';
import { RunLimits, pricePauseText } from '../src/agent/limits.js';
import { HttpReporter, reporterEnv, type Reporter } from '../src/agent/report.js';
import { createTheme } from '../src/client/tui/theme.js';
import { cardText } from '../src/client/tui/agent-card.js';
import { buildBashEnv } from '../src/daemon/env.js';
import { closestCatalogModel, trimPrices } from '../src/daemon/usage-prices.js';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { UsageService } from '../src/daemon/usage-service.js';
import { KeyStore } from '../src/daemon/keys.js';
import { SettingsStore } from '../src/daemon/settings.js';
import * as engines from '../src/daemon/engines.js';
import { stubFacts } from './fixtures/agent-facts.js';
import type { AgentFacts } from '../src/shared/agent-facts.js';
import type { ModelPrice, SessionInfo } from '../src/shared/protocol.js';

// B28 (UX): with a daily, weekly or monthly budget, a model with no known price waits for one (that stays: never a
// "run outside budgets" option). The pause now offers the way out right there: p sets a price (input / output / cache per
// 1M, prefilled from the catalog's closest model when there is one, labeled `guess, check it`), m marks which catalog
// model a Foundry deployment is, Esc stops. $0 counts only typed, and the card then shows `price: yours`. Ollama is $0
// and never pauses on price.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const budgets = { daily: 3, weekly: null, monthly: null };

it('the pause says what to press: p for any provider, m only for a Foundry deployment, ⏎ checks again; no going on with a budget', () => {
  expect(pricePauseText('my-kimi', 'foundry', true, 16_000)).toBe("no price known for my-kimi, so your budgets can't count it · p sets its price · m marks which catalog model it is · ⏎ checks again · Esc stops");
  expect(pricePauseText('vendor/model', 'openrouter', true, 16_000)).toBe("no price known for vendor/model, so your budgets can't count it · p sets its price · ⏎ checks again · Esc stops");
  expect(pricePauseText('vendor/model', null, false, 16_000)).toBe("no price known for vendor/model, so what it spends is not counted in this run's spend cap · p sets its price · ⏎ goes on for this model this run (at most 16,000 output tokens a request) · Esc stops");
  const limits = new RunLimits(), pause = limits.check(stubFacts({ model: 'my-kimi', price: null, budgets }), 100);
  expect(pause).toMatchObject({ price: { model: 'my-kimi', budgets: true } });
  expect(pause?.onContinue).toBeUndefined();
  // Ollama is priced $0 by the daemon (findPrice), so it never reaches the price pause, budgets or not.
  expect(new RunLimits().check(stubFacts({ model: 'llama4', price: { input: 0, output: 0, cacheRead: 0 }, budgets }), 100)).toBeNull();
});

it('the guess is the catalog\'s closest model (the longest whose words are all in the id), never a model of another kind', () => {
  const snapshot = trimPrices({ azure: { models: { 'gpt-5': { cost: { input: 1, output: 8 } }, 'gpt-5-mini': { cost: { input: 0.25, output: 2, cache_read: 0.025 } } } },
    moonshotai: { models: { 'kimi-k2': { cost: { input: 0.6, output: 2.5 } }, 'kimi-k2.6': { cost: { input: 0.7, output: 3 } } } } }, '2026-10-15');
  expect(closestCatalogModel(snapshot, 'foundry', 'my-gpt-5-mini-prod')).toEqual({ model: 'gpt-5-mini', price: { input: 0.25, output: 2, cacheRead: 0.025 } });
  expect(closestCatalogModel(snapshot, 'openrouter', 'moonshotai/kimi-k2.7')).toEqual({ model: 'kimi-k2', price: { input: 0.6, output: 2.5 } });
  expect(closestCatalogModel(snapshot, 'foundry', 'totally-unknown')).toBeNull();
  expect(closestCatalogModel(snapshot, 'foundry', 'gpt')).toBeNull();
  expect(closestCatalogModel(snapshot, 'ollama', 'gpt-5-mini')).toBeNull();
});

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const reply = (text: string) => ({ stream: convertArrayToReadableStream([{ type: 'stream-start' as const, warnings: [] }, { type: 'text-start' as const, id: 't' }, { type: 'text-delta' as const, id: 't', delta: text }, { type: 'text-end' as const, id: 't' }, { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage }]) });
async function app(provider: 'foundry' | 'openrouter', guess: { model: string; price: ModelPrice } | null) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-b28-'))); cleanups.push(() => rm(root, { recursive: true, force: true }));
  let price: ModelPrice | null = null, mapped: string | null = null;
  const saved: ModelPrice[] = [];
  const reporter: Reporter = {
    status: async () => {}, usage: async () => true, facts: async (): Promise<AgentFacts> => stubFacts({ model: 'my-kimi', price: price ?? (mapped ? { input: 0.7, output: 3 } : null), budgets }),
    reserve: async () => ({ grant: { id: randomUUID() } }), settle: async () => {},
    priceInfo: async () => ({ provider, guess }),
    setPrice: async (_model, value) => { saved.push(value); price = value; return true; },
    mapModel: async (_model, catalog) => { mapped = catalog; return true; },
  };
  let out = ''; const screen = new Screen({ write: t => { out += t; }, columns: 160, rows: 40 }, createTheme('graphite'));
  const model = new MockLanguageModelV4({ doStream: [reply('done one'), reply('done two')] });
  const a = new AgentApp({ screen, permission: 'ask', models: ['my-kimi'], quit: vi.fn(), makeModel: async () => model,
    agent: io => new Agent({ root, permission: 'ask', model, modelId: 'my-kimi', instructions: { text: '', files: [], notes: [] }, reporter, transcript: new Transcript(null, t => t, () => {}), io, redact: t => t, bashEnv: buildBashEnv(process.env), rg: null }) });
  a.start();
  return { app: a, model, saved, screen: () => stripVTControlCharacters(out), mapped: () => mapped };
}

it('p at the pause: the guess is prefilled and labeled; ⏎ saves it as your price and the request goes; Esc in the form goes back to the pause', async () => {
  const s = await app('foundry', { model: 'kimi-k2.6', price: { input: 0.6, output: 2.5, cacheRead: 0.15 } });
  s.app.input('fix login\r');
  await vi.waitFor(() => expect(s.screen()).toContain('p sets its price · m marks which catalog model it is'));
  s.app.input('p');
  await vi.waitFor(() => expect(s.screen()).toContain('price for my-kimi · USD per 1M tokens · input / output / cache read'));
  expect(s.screen()).toContain('guess, check it: kimi-k2.6');
  expect(s.screen()).toContain('› 0.6 / 2.5 / 0.15');
  s.app.input('\x1b');
  await vi.waitFor(() => expect(s.screen().split('● paused · no price known for my-kimi')).toHaveLength(3));
  expect(s.model.doStreamCalls).toHaveLength(0);
  s.app.input('p'); s.app.input('\r');
  await vi.waitFor(() => expect(s.model.doStreamCalls).toHaveLength(1));
  expect(s.saved).toEqual([{ input: 0.6, output: 2.5, cacheRead: 0.15 }]);
  expect(s.screen()).toContain('✓ your price for my-kimi: $0.60 in / $2.50 out / $0.15 cache read per 1M');
  s.app.close();
});

it('p with no guess starts empty: ⏎ alone is refused, a typed 0 / 0 is your price; a paste never saves', async () => {
  const s = await app('openrouter', null);
  s.app.input('fix login\r');
  await vi.waitFor(() => expect(s.screen()).toContain('p sets its price · ⏎ checks again'));
  expect(s.screen()).not.toContain('m marks');
  s.app.input('m'); s.app.input('p');
  await vi.waitFor(() => expect(s.screen()).toContain('no guess: type each price; 0 counts only typed'));
  s.app.input('\r');
  await vi.waitFor(() => expect(s.screen()).toContain('type input / output per 1M (cache read optional), like 0.6 / 2.5'));
  s.app.input('\x1b[200~0 / 0\r\x1b[201~');
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(s.saved).toEqual([]);
  s.app.input('\r');
  await vi.waitFor(() => expect(s.saved).toEqual([{ input: 0, output: 0 }]));
  await vi.waitFor(() => expect(s.model.doStreamCalls).toHaveLength(1));
  s.app.close();
});

it('m at a Foundry pause: type to narrow the catalog, ⏎ marks the deployment and the request goes; Esc at the pause stops', async () => {
  const s = await app('foundry', null);
  s.app.input('fix login\r');
  await vi.waitFor(() => expect(s.screen()).toContain('m marks which catalog model it is'));
  s.app.input('m');
  await vi.waitFor(() => expect(s.screen()).toContain('which catalog model is my-kimi? type to narrow · ↑↓ · ⏎ marks it · Esc back'));
  for (const c of 'kimi-k2.6') s.app.input(c);
  await vi.waitFor(() => expect(s.screen()).toMatch(/› kimi-k2\.6 → kimi-k2\.6 \(1 of \d+\)/));
  s.app.input('\r');
  await vi.waitFor(() => expect(s.mapped()).toBe('kimi-k2.6'));
  await vi.waitFor(() => expect(s.model.doStreamCalls).toHaveLength(1));
  s.app.close();
  const t = await app('openrouter', null);
  t.app.input('fix login\r');
  await vi.waitFor(() => expect(t.screen()).toContain('p sets its price'));
  t.app.input('\x1b');
  await vi.waitFor(() => expect(t.screen()).toContain('■ stopped'));
  expect(t.model.doStreamCalls).toHaveLength(0); expect(t.saved).toEqual([]);
  t.app.close();
});

it('the daemon side: an agent can price only its own unpriced model (never change a price), map only its own Foundry deployment; the card then says price: yours', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-b28-daemon-'))), paths = getPaths(root); await preparePaths(paths);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'settings.json'), JSON.stringify({ theme: 'graphite', worktrees: 'off', budgets }), { mode: 0o600 });
  const log = new Logger(paths.log), usageService = new UsageService(root, log), vault = new Map<string, string>();
  const keys = new KeyStore(root, { vault: { read: async a => vault.get(a) ?? null, write: async (a, s) => { vault.set(a, s); }, remove: async a => { vault.delete(a); } } });
  const manager = new SessionManager(paths, log, undefined, undefined, undefined, keys, usageService, '/opt/ai-term/dist/cli/index.js');
  await usageService.start(); await manager.load();
  cleanups.push(async () => { await manager.shutdown(); await usageService.close(); });
  const spawned: Record<string, string>[] = [], real = pty.spawn;
  vi.spyOn(pty, 'spawn').mockImplementation((_file, _args, options) => { spawned.push({ ...(options?.env as Record<string, string>) }); return real('/bin/sh', ['-c', 'printf ready; read done'], { ...options, env: { PATH: '/usr/bin:/bin' } }); });
  vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' });
  const foundry = await keys.add({ provider: 'foundry', label: 'f', secret: 'AITERMCANARY-b28-0123456789', endpoint: 'https://b28.openai.azure.com/openai/v1', deployments: ['my-unpriced-x', 'my-mapped-y', 'gpt-6.1-sol'] });
  await keys.saveTest(foundry.id, [{ model: 'my-unpriced-x', status: 'chat' }, { model: 'my-mapped-y', status: 'chat' }, { model: 'gpt-6.1-sol', status: 'ready' }]);
  const session = await manager.create({ engine: 'ai-term', model: 'my-unpriced-x', auth: { kind: 'key', keyId: foundry.id }, cwd: root, permission: 'ask' });
  const reporter = new HttpReporter(reporterEnv(spawned.at(-1) ?? {}), () => {});
  await expect.poll(() => manager.get(session.id).status).toBe('running');
  expect((await reporter.facts('my-unpriced-x'))?.price).toBeNull();
  expect(await reporter.priceInfo('my-unpriced-x')).toEqual({ provider: 'foundry', guess: null });
  expect(await reporter.setPrice('not-mine', { input: 1, output: 1 })).toBe(false);
  expect(await reporter.setPrice('gpt-6.1-sol', { input: 0, output: 0 })).toBe(false);
  expect(await reporter.setPrice('my-unpriced-x', { input: -1, output: 1 })).toBe(false);
  expect(await reporter.setPrice('my-unpriced-x', { input: 0, output: 0 })).toBe(true);
  expect((await new SettingsStore(root).get()).providerPrices).toEqual({ foundry: { 'my-unpriced-x': { input: 0, output: 0 } } });
  expect((await reporter.facts('my-unpriced-x'))?.price).toEqual({ input: 0, output: 0, cacheRead: 0 });
  // Priced now: the agent can't change it (only you can, in /settings p).
  expect(await reporter.setPrice('my-unpriced-x', { input: 9, output: 9 })).toBe(false);
  await expect.poll(() => manager.get(session.id).priceYours).toBe(true);
  const info: SessionInfo = manager.get(session.id);
  expect(cardText({ ...info, taskUsage: { tokens: 10, costUsd: 0 } }, Date.now(), 120).auth).toContain('price: yours');
  expect(await reporter.mapModel('my-mapped-y', 'made-up-model')).toBe(false);
  expect(await reporter.mapModel('my-mapped-y', 'kimi-k2.6')).toBe(true);
  expect((await new SettingsStore(root).get()).deploymentModels).toEqual({ 'my-mapped-y': 'kimi-k2.6' });
  expect(await reporter.mapModel('my-mapped-y', 'gpt-5')).toBe(false);
}, 30_000);
