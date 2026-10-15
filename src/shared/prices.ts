import type { KeyProvider, ModelPrice, Settings } from './protocol.js';

// B27: your own prices (/settings p, and p at a budget pause) belong to a provider and a model id, so a Foundry deployment
// and an OpenRouter model with the same id keep two prices. Anthropic and OpenAI keys always use the catalog's prices
// (D45), so they take none. priceOverrides holds records from before B27, by model id alone: each still applies to every
// provider with that id, and a provider's own price wins over it.
export const PRICED_BY_YOU: readonly KeyProvider[] = ['foundry', 'xai', 'moonshot', 'zai', 'openrouter', 'bedrock', 'vertex', 'ollama'];
export const MAX_PRICES = 100;
type Prices = Pick<Settings, 'priceOverrides' | 'providerPrices'>;
const own = <T>(table: Record<string, T> | undefined, id: string): T | undefined => table && Object.hasOwn(table, id) ? table[id] : undefined;

// The prices that apply to one provider, by model id (a null-prototype object: an id like toString is just an id).
export function overridesFor(settings: Prices, provider: KeyProvider): Record<string, ModelPrice> {
  const merged = Object.create(null) as Record<string, ModelPrice>;
  if (!PRICED_BY_YOU.includes(provider)) return merged;
  for (const table of [settings.priceOverrides, own(settings.providerPrices, provider)]) for (const [id, price] of Object.entries(table ?? {})) merged[id] = price;
  return merged;
}
// Whether the price in use for this provider and model is one you typed (the card then says `price: yours`).
export function isYourPrice(settings: Prices, provider: KeyProvider, model: string): boolean { return Object.hasOwn(overridesFor(settings, provider), model); }
export function priceCount(settings: Prices): number {
  return Object.keys(settings.priceOverrides ?? {}).length + Object.values(settings.providerPrices ?? {}).reduce((sum, table) => sum + Object.keys(table ?? {}).length, 0);
}
// Every price you set, once each: old records first as "any provider", then by provider and model id.
export interface PriceRow { provider: KeyProvider | 'any'; model: string; price: ModelPrice }
export function priceRows(settings: Prices): PriceRow[] {
  const legacy = Object.entries(settings.priceOverrides ?? {}).map(([model, price]): PriceRow => ({ provider: 'any', model, price }));
  const mine = PRICED_BY_YOU.flatMap(provider => Object.entries(own(settings.providerPrices, provider) ?? {}).map(([model, price]): PriceRow => ({ provider, model, price })));
  const byModel = (a: PriceRow, b: PriceRow) => a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
  return [...legacy.sort(byModel), ...mine.sort((a, b) => a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : byModel(a, b))];
}
// One old record moves to the single provider that has its id (a key's deployment or model, or that provider's catalog
// table); with several or none it stays as it is, so nothing is lost and nothing is priced differently.
export function migratePriceOverrides<T extends Settings>(settings: T, inCatalog: (provider: KeyProvider, model: string) => boolean): T {
  const legacy = settings.priceOverrides ?? {}, keys = Array.isArray(settings.keys) ? settings.keys as { provider?: unknown; deployments?: unknown }[] : [];
  const keep: Record<string, ModelPrice> = {}, moved: Partial<Record<KeyProvider, Record<string, ModelPrice>>> = {};
  let changed = false;
  for (const [model, price] of Object.entries(legacy)) {
    // Ollama has no catalog: only a key's own model list says it has an id.
    const providers = PRICED_BY_YOU.filter(provider => provider !== 'ollama' && inCatalog(provider, model) || keys.some(key => key.provider === provider && Array.isArray(key.deployments) && key.deployments.includes(model)));
    const only = providers.length === 1 ? providers[0] : undefined;
    // A price you set for that provider already wins over the old record, so the old one moves only into an empty slot.
    if (!only || own(own(settings.providerPrices, only), model)) { keep[model] = price; continue; }
    moved[only] = { ...moved[only], [model]: price }; changed = true;
  }
  if (!changed) return settings;
  const providerPrices: Partial<Record<KeyProvider, Record<string, ModelPrice>>> = { ...settings.providerPrices };
  for (const [provider, table] of Object.entries(moved) as [KeyProvider, Record<string, ModelPrice>][]) providerPrices[provider] = { ...providerPrices[provider], ...table };
  const { priceOverrides: _old, ...rest } = settings; void _old;
  return { ...rest, providerPrices, ...(Object.keys(keep).length ? { priceOverrides: keep } : {}) } as T;
}
