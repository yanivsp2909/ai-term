import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { KeyProvider, KeyView, Settings } from '../shared/protocol.js';
import { isChatCatalogId } from '../shared/model-catalog.js';
import { deploymentWire } from '../shared/models.js';
import { testedModels } from '../shared/providers.js';
import { isFsError } from '../shared/paths.js';
import { REVIEW_MAX_MODELS, type ReviewModel } from '../shared/review.js';
import type { KeyedWriter } from './handoff.js';
import { atomicWrite } from './store.js';
import { deploymentAlias, estimateCost, findPrice, type PriceSnapshot } from './usage-prices.js';
import { overridesFor } from '../shared/prices.js';

// v0.7.4 /review: the models you can pick are your keys' chat models with a known price (so the ask shows a real price
// range and budgets can hold its worst case), on the providers whose one-shot request needs only the key (and Foundry's
// Keychain-bound endpoint). Bedrock (a region binding) and Ollama (no key; slow to load a model) aren't offered yet.
export const REVIEW_PROVIDERS: readonly KeyProvider[] = ['anthropic', 'openai', 'foundry', 'xai', 'moonshot', 'zai', 'openrouter', 'vertex'];
export class ReviewError extends Error {}
export const REVIEW_ERRORS = ['The diff changed since it was shown; run /review again', 'Pick one of the models /review offered', 'No priced model among your keys · add an API key in /settings',
  'No review yet for this agent · /review <agent>', 'The review would pass your daily budget', 'The review would pass your weekly budget', 'The review would pass your monthly budget', 'The review request failed',
  'The diff is empty; nothing to review', 'A review of this agent is already running'] as const;

export function reviewWriters(keys: readonly KeyView[], settings: Pick<Settings, 'priceOverrides' | 'providerPrices' | 'deploymentModels'>, prices: PriceSnapshot): KeyedWriter[] {
  const writers: KeyedWriter[] = [];
  for (const key of keys) {
    if (!REVIEW_PROVIDERS.includes(key.provider)) continue;
    const models = key.provider === 'foundry' ? (key.deployments ?? []).filter(model => deploymentWire(key.lastTest?.find(r => r.model === model)) !== null)
      : key.provider === 'anthropic' || key.provider === 'openai' ? Object.keys(prices.providers[key.provider] ?? {}).filter(isChatCatalogId) : testedModels(key);
    for (const model of models) {
      const price = findPrice(prices, key.provider, model, overridesFor(settings, key.provider), key.provider === 'foundry' ? deploymentAlias(settings, model) : undefined);
      if (price) writers.push({ key, model, price, wire: key.provider === 'foundry' ? deploymentWire(key.lastTest?.find(r => r.model === model)) : null });
    }
  }
  // Cheapest first (input + output per 1M tokens); ties by provider and name, so the order never shuffles.
  return writers.sort((a, b) => a.price.input + a.price.output - (b.price.input + b.price.output) || a.key.provider.localeCompare(b.key.provider) || a.model.localeCompare(b.model)).slice(0, REVIEW_MAX_MODELS);
}
type Range = { low: number; high: number };
export function reviewModelView(writer: KeyedWriter, input: Range, output: Range): ReviewModel {
  return { keyId: writer.key.id, provider: writer.key.provider, keyLabel: writer.key.label, last4: writer.key.last4, model: writer.model,
    priceUsd: { low: estimateCost(writer.price, input.low, output.low) ?? 0, high: estimateCost(writer.price, input.high, output.high) ?? 0 } };
}
export function reviewCandidates(keys: readonly KeyView[], settings: Pick<Settings, 'priceOverrides' | 'providerPrices' | 'deploymentModels'>, prices: PriceSnapshot, input: Range, output: Range): ReviewModel[] {
  return reviewWriters(keys, settings, prices).map(writer => reviewModelView(writer, input, output));
}

// Auto-review's own daily budget (D55, off by default): what today's auto-reviews spent, in ~/.ai-term/auto-review.json.
// A day is your local calendar day. Reads and writes go one at a time.
export class AutoReviewLedger {
  private readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(root: string) { this.path = join(root, 'auto-review.json'); }
  private static today(): string { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  private async read(day = AutoReviewLedger.today()): Promise<number> {
    let file;
    try { file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (isFsError(error, 'ENOENT')) return 0; throw error; }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 4096) throw new Error('Unsafe auto-review file');
      const data: unknown = JSON.parse(await file.readFile('utf8'));
      const record = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
      return record.day === day && typeof record.spentUsd === 'number' && Number.isFinite(record.spentUsd) && record.spentUsd >= 0 ? record.spentUsd : 0;
    } finally { await file.close(); }
  }
  private serial<T>(work: () => Promise<T>): Promise<T> { const next = this.queue.then(work, work); this.queue = next.then(() => undefined, () => undefined); return next; }
  // Takes `worst` from today's room (null when it doesn't fit); settle() replaces it with what was spent. A hold settled
  // after midnight leaves the new day alone: the old day's file is gone by then, and its spend went with it.
  take(worst: number, dailyUsd: number): Promise<{ day: string; worst: number } | null> {
    return this.serial(async () => { const day = AutoReviewLedger.today(), spent = await this.read(day); if (spent + worst > dailyUsd) return null; await atomicWrite(this.path, { day, spentUsd: spent + worst }); return { day, worst }; });
  }
  settle(hold: { day: string; worst: number }, spentUsd: number): Promise<void> {
    return this.serial(async () => { if (hold.day !== AutoReviewLedger.today()) return; const spent = await this.read(hold.day); await atomicWrite(this.path, { day: hold.day, spentUsd: Math.max(0, spent - hold.worst + spentUsd) }); });
  }
}
