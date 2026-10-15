import priceData from '../../data/usage-prices.json' with { type: 'json' };
import { MAX_PRICES, migratePriceOverrides, priceCount, priceRows } from '../shared/prices.js';
import type { KeyProvider, ModelPrice } from '../shared/protocol.js';
import { SettingsStore } from './settings.js';
import { findPrice, type PriceSnapshot } from './usage-prices.js';

// B27: once at start, the price records kept by model id alone (before B27) move to the one provider that has that id;
// the rest stay as they are. Returns how many moved. Nothing is written when nothing moves.
const PRICES = priceData as PriceSnapshot;
const inCatalog = (provider: Parameters<typeof findPrice>[1], model: string) => findPrice(PRICES, provider, model, {}) !== undefined;
export async function migratePrices(root: string): Promise<number> {
  const store = new SettingsStore(root);
  const before = await store.get();
  if (migratePriceOverrides(before, inCatalog) === before) return 0;
  let moved = 0;
  await store.update(async settings => {
    const next = migratePriceOverrides(settings, inCatalog);
    moved = priceRows(next).filter(row => row.provider !== 'any').length - priceRows(settings).filter(row => row.provider !== 'any').length;
    return next;
  });
  return moved;
}

export const PRICE_ERRORS = ['AI Term keeps at most 100 prices'] as const;
// B27 review: /settings p saves one price through the daemon's settings queue (prices.set), so a price an agent saved at a
// pause meanwhile is never overwritten by the form's older copy of the list.
export async function savePrice(root: string, provider: KeyProvider, model: string, price: ModelPrice): Promise<void> {
  await new SettingsStore(root).update(async settings => {
    const current = settings.providerPrices ?? {}, next = { ...settings, providerPrices: { ...current, [provider]: { ...current[provider], [model]: { input: price.input, output: price.output, ...(price.cacheRead === undefined ? {} : { cacheRead: price.cacheRead }) } } } };
    if (priceCount(next) > MAX_PRICES) throw new Error(PRICE_ERRORS[0]);
    return next;
  });
}
