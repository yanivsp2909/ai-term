import priceData from '../../data/usage-prices.json' with { type: 'json' };
import { migratePriceOverrides, priceRows } from '../shared/prices.js';
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
