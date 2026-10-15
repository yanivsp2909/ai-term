import { expect, it } from 'vitest';
import { findLimits, findPrice, trimPrices, type PriceSnapshot } from '../src/daemon/usage-prices.js';
import prices from '../data/usage-prices.json' with { type: 'json' };

// v0.6.5 (Yaniv, mid-run): the new providers' list prices are built in from the same Models.dev catalog (D45), so dollar
// budgets count their spend without typing prices. Tables: xai, moonshotai, zai, openrouter, amazon-bedrock, google-vertex.
const raw = {
  xai: { models: { 'grok-9': { cost: { input: 3, output: 15, cache_read: 0.75 }, limit: { context: 256000, output: 64000 } } } },
  moonshotai: { models: { 'kimi-k9': { cost: { input: 0.6, output: 2.5 } } } },
  zai: { models: { 'glm-9': { cost: { input: 0.6, output: 2.2, cache_read: 0.11 } } } },
  openrouter: { models: { 'vendor/model:free': { cost: { input: 0, output: 0 } }, 'vendor/broken': { cost: { input: -1, output: 2 } } } },
  'amazon-bedrock': { models: { 'us.anthropic.claude-x-v1:0': { cost: { input: 5, output: 25 } } } },
  'google-vertex': { models: { 'gemini-9-flash': { cost: { input: 0.3, output: 2.5 } } } },
  'moonshotai-cn': { models: { 'kimi-k9': { cost: { input: 0.01, output: 0.01 } } } },
};

it('trimPrices keeps the six new provider tables (and only valid prices), with their limits', () => {
  const snapshot = trimPrices(raw, '2026-10-15');
  expect(snapshot.providers).toMatchObject({ xai: { 'grok-9': { input: 3, output: 15, cacheRead: 0.75 } }, moonshotai: { 'kimi-k9': { input: 0.6, output: 2.5 } }, zai: { 'glm-9': { input: 0.6, output: 2.2, cacheRead: 0.11 } }, openrouter: { 'vendor/model:free': { input: 0, output: 0 } }, 'amazon-bedrock': { 'us.anthropic.claude-x-v1:0': { input: 5, output: 25 } }, 'google-vertex': { 'gemini-9-flash': { input: 0.3, output: 2.5 } } });
  expect(snapshot.providers.openrouter).not.toHaveProperty('vendor/broken');
  expect(snapshot.providers).not.toHaveProperty('moonshotai-cn');
  expect(snapshot.limits?.xai).toEqual({ 'grok-9': { context: 256000, output: 64000 } });
});

it('findPrice and findLimits read each provider\'s own table; an override still wins; another provider\'s table never answers', () => {
  const snapshot = trimPrices(raw, '2026-10-15');
  expect(findPrice(snapshot, 'xai', 'grok-9', {})).toEqual({ input: 3, output: 15, cacheRead: 0.75 });
  expect(findPrice(snapshot, 'moonshot', 'kimi-k9', {})).toEqual({ input: 0.6, output: 2.5 });
  expect(findPrice(snapshot, 'zai', 'glm-9', {})).toMatchObject({ input: 0.6 });
  expect(findPrice(snapshot, 'openrouter', 'vendor/model:free', {})).toEqual({ input: 0, output: 0 });
  expect(findPrice(snapshot, 'bedrock', 'us.anthropic.claude-x-v1:0', {})).toEqual({ input: 5, output: 25 });
  expect(findPrice(snapshot, 'vertex', 'gemini-9-flash', {})).toEqual({ input: 0.3, output: 2.5 });
  expect(findPrice(snapshot, 'xai', 'grok-9', { 'grok-9': { input: 1, output: 1 } })).toEqual({ input: 1, output: 1, cacheRead: 1 });
  expect(findPrice(snapshot, 'moonshot', 'grok-9', {})).toBeUndefined();
  expect(findPrice(snapshot, 'xai', 'toString', {})).toBeUndefined();
  expect(findLimits(snapshot, 'xai', 'grok-9')).toEqual({ context: 256000, output: 64000 });
  // A snapshot from before v0.6.5 has no such tables: unknown, never a crash.
  const old = { fetchedAt: 'x', providers: { anthropic: {}, openai: {}, azure: {} } } as PriceSnapshot;
  expect(findPrice(old, 'xai', 'grok-9', {})).toBeUndefined(); expect(findLimits(old, 'xai', 'grok-9')).toEqual({});
});

it('the bundled catalog now prices the new providers (refreshed from Models.dev)', () => {
  const bundled = prices as unknown as PriceSnapshot;
  for (const [provider, model] of [['xai', 'grok-4.7'], ['moonshot', 'kimi-k3'], ['zai', 'glm-5.3'], ['bedrock', 'us.anthropic.claude-opus-4-7'], ['vertex', 'gemini-3.6-flash']] as const)
    expect(findPrice(bundled, provider, model, {}), `${provider} ${model}`).toMatchObject({ input: expect.any(Number), output: expect.any(Number) });
  expect(Object.keys(bundled.providers.openrouter ?? {}).length).toBeGreaterThan(100);
});
