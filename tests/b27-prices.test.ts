import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findPrice, trimPrices } from '../src/daemon/usage-prices.js';
import { migratePriceOverrides, overridesFor, priceRows, PRICED_BY_YOU } from '../src/shared/prices.js';
import { migratePrices } from '../src/daemon/price-migration.js';
import { PriceForm } from '../src/client/tui/usage-forms.js';
import { validateSettingsPatch } from '../src/shared/validate.js';
import type { KeyView, Settings } from '../src/shared/protocol.js';

// B27 (LOW): price overrides were keyed by model id alone, across providers, so a Foundry deployment and an OpenRouter
// model with the same id shared one price. Now a price belongs to a provider and a model id. Old records (model id only)
// are migrated without losing any: one that only one of your providers has moves to that provider; one that several (or
// none) have stays, applies to every provider with that id as before, and /settings lists it once as "any provider".
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const snapshot = trimPrices({ xai: { models: { 'grok-9': { cost: { input: 3, output: 15 } } } } }, '2026-10-15');
const key = (provider: KeyView['provider'], deployments: string[]): KeyView => ({ id: `6f1c4f53-3a1e-4bb0-9a49-${String(provider.length).padStart(12, '0')}`, provider, label: provider, last4: 'abcd', deployments, ...(provider === 'foundry' ? { endpoint: 'https://example.openai.azure.com' } : {}) });

it('a price is per provider and model: the same id on Foundry and OpenRouter keeps two prices; an old record still applies to both', () => {
  const settings: Pick<Settings, 'priceOverrides' | 'providerPrices'> = { providerPrices: { foundry: { 'shared-id': { input: 1, output: 2 } }, openrouter: { 'shared-id': { input: 5, output: 9, cacheRead: 0.5 } } }, priceOverrides: { legacy: { input: 7, output: 7 } } };
  expect(findPrice(snapshot, 'foundry', 'shared-id', overridesFor(settings, 'foundry'))).toEqual({ input: 1, output: 2, cacheRead: 1 });
  expect(findPrice(snapshot, 'openrouter', 'shared-id', overridesFor(settings, 'openrouter'))).toEqual({ input: 5, output: 9, cacheRead: 0.5 });
  expect(findPrice(snapshot, 'xai', 'shared-id', overridesFor(settings, 'xai'))).toBeUndefined();
  for (const provider of ['foundry', 'openrouter', 'xai'] as const) expect(findPrice(snapshot, provider, 'legacy', overridesFor(settings, provider))).toMatchObject({ input: 7 });
  // A provider's own price wins over an old record of the same id; Anthropic and OpenAI keep the catalog's prices.
  expect(overridesFor({ priceOverrides: { m: { input: 1, output: 1 } }, providerPrices: { xai: { m: { input: 2, output: 2 } } } }, 'xai').m).toEqual({ input: 2, output: 2 });
  expect(overridesFor(settings, 'anthropic')).toEqual({}); expect(PRICED_BY_YOU).not.toContain('openai');
  expect(Object.getPrototypeOf(overridesFor(settings, 'foundry'))).toBeNull();
});

it('migration keeps every old record: a single provider takes it, several or none keep it for every provider, listed once', () => {
  const keys = [key('foundry', ['my-deploy', 'shared']), key('openrouter', ['shared', 'vendor/model'])];
  const before: Settings = { theme: 'graphite', keys, priceOverrides: { 'my-deploy': { input: 1, output: 2 }, shared: { input: 3, output: 4 }, 'grok-9': { input: 5, output: 6 }, gone: { input: 7, output: 8 } } };
  const after = migratePriceOverrides(before, (provider, model) => findPrice(snapshot, provider, model, {}) !== undefined);
  expect(after.providerPrices).toEqual({ foundry: { 'my-deploy': { input: 1, output: 2 } }, xai: { 'grok-9': { input: 5, output: 6 } } });
  expect(after.priceOverrides).toEqual({ shared: { input: 3, output: 4 }, gone: { input: 7, output: 8 } });
  // Nothing is lost: every old id still prices what it priced, for each provider that has it.
  for (const [provider, model] of [['foundry', 'my-deploy'], ['foundry', 'shared'], ['openrouter', 'shared'], ['xai', 'grok-9'], ['zai', 'gone']] as const)
    expect(findPrice(snapshot, provider, model, overridesFor(after, provider)), `${provider} ${model}`).toEqual(findPrice(snapshot, provider, model, before.priceOverrides ?? {}));
  expect(migratePriceOverrides(after, () => true)).toEqual(after);
  expect(priceRows(after)).toEqual([
    { provider: 'any', model: 'gone', price: { input: 7, output: 8 } }, { provider: 'any', model: 'shared', price: { input: 3, output: 4 } },
    { provider: 'foundry', model: 'my-deploy', price: { input: 1, output: 2 } }, { provider: 'xai', model: 'grok-9', price: { input: 5, output: 6 } },
  ]);
});

it('the daemon migrates settings.json once at start, in place, and leaves the rest of it alone', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-b27-'))); roots.push(root);
  await writeFile(join(root, 'settings.json'), JSON.stringify({ theme: 'graphite', budgets: { daily: 3, weekly: null, monthly: null }, keys: [key('foundry', ['dep'])], priceOverrides: { dep: { input: 1, output: 2 }, other: { input: 3, output: 4 } } }), { mode: 0o600 });
  expect(await migratePrices(root)).toBe(1);
  const stored = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')) as Settings;
  expect(stored).toMatchObject({ budgets: { daily: 3 }, providerPrices: { foundry: { dep: { input: 1, output: 2 } } }, priceOverrides: { other: { input: 3, output: 4 } } });
  expect(await migratePrices(root)).toBe(0);
});

it('settings accept a price per provider (not Anthropic or OpenAI, at most 100 in all) and refuse junk', () => {
  expect(validateSettingsPatch({ providerPrices: { openrouter: { 'vendor/model': { input: 1, output: 2, cacheRead: 0.1 } } } })).toMatchObject({ providerPrices: { openrouter: { 'vendor/model': { input: 1 } } } });
  for (const providerPrices of [{ anthropic: { m: { input: 1, output: 2 } } }, { nope: { m: { input: 1, output: 2 } } }, { xai: { m: { input: -1, output: 2 } } }, { xai: { '-bad': { input: 1, output: 2 } } }, { xai: [] }, { xai: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`m${i}`, { input: 1, output: 1 }])) }])
    expect(() => validateSettingsPatch({ providerPrices }), JSON.stringify(providerPrices).slice(0, 60)).toThrow();
});

it('/settings p: the provider is part of the price (← → picks it), cache is optional, $0 only typed; your prices are listed once', () => {
  const settings: Settings = { theme: 'graphite', priceOverrides: { shared: { input: 3, output: 4 } }, providerPrices: { foundry: { 'my-deploy': { input: 1, output: 2, cacheRead: 0.5 } } } };
  const form = new PriceForm(settings, [key('openrouter', ['vendor/model']), key('foundry', ['my-deploy'])]);
  const lines = form.lines().join('\n');
  expect(lines).toContain('› provider: ‹ OpenRouter ›');
  expect(lines).toContain('YOUR PRICES · USD per 1M in / out / cache');
  expect(lines).toContain('Microsoft Foundry · my-deploy · $1.00 / $2.00 / $0.50');
  expect(lines).toContain('any provider · shared · $3.00 / $4.00 / same as input');
  form.key('right'); expect(form.lines().join('\n')).toContain('provider: ‹ Microsoft Foundry ›');
  form.key('left');
  form.key('down'); for (const c of 'vendor/model') form.key(c);
  form.key('down'); form.key('down');
  expect(() => form.values()).toThrow('Type the input and output price; 0 counts only typed');
  form.key('up'); for (const c of '0') form.key(c); form.key('down'); for (const c of '0') form.key(c);
  expect(form.values()).toEqual({ provider: 'openrouter', model: 'vendor/model', price: { input: 0, output: 0 } });
  form.key('down'); for (const c of '0.25') form.key(c);
  expect(form.values()).toEqual({ provider: 'openrouter', model: 'vendor/model', price: { input: 0, output: 0, cacheRead: 0.25 } });
});
