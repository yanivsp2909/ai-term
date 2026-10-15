import { generateText } from 'ai';
import type { CliEngine, KeyView, ModelPrice, Settings } from '../shared/protocol.js';
import { isChatCatalogId } from '../shared/model-catalog.js';
import { deploymentWire } from '../shared/models.js';
import { HANDOFF_OUTPUT_TOKENS, HANDOFF_SOURCE_CHARS, handoffInstructions, handoffPrompt, type HandoffPlan, type HandoffWriter } from '../shared/handoff.js';
import { estimateTokens } from '../agent/limits.js';
import { makeModel } from '../agent/provider.js';
import { deploymentAlias, estimateCost, findPrice, type PriceSnapshot } from './usage-prices.js';

// v0.6.3 engine handoff: who writes the summary and what it may cost (D49 asks with this before anything runs).
export interface KeyedWriter { key: KeyView; model: string; price: ModelPrice; wire: 'responses' | 'chat' | null }
// The cheapest model with a known price among your saved keys (input + output per 1M tokens), or none.
export function cheapestWriter(keys: readonly KeyView[], settings: Pick<Settings, 'priceOverrides' | 'deploymentModels'>, prices: PriceSnapshot): KeyedWriter | null {
  let best: KeyedWriter | null = null;
  for (const key of keys) {
    // Only the providers this one-shot request was reviewed for (v0.6.3); a v0.6.5 provider (or Ollama, free but slow to
    // load a model) is never picked by itself to read an agent's screen.
    if (key.provider !== 'foundry' && key.provider !== 'anthropic' && key.provider !== 'openai') continue;
    const models = key.provider === 'foundry' ? (key.deployments ?? []).filter(model => deploymentWire(key.lastTest?.find(r => r.model === model)) !== null) : Object.keys(prices.providers[key.provider] ?? {}).filter(isChatCatalogId);
    for (const model of models) {
      const price = findPrice(prices, key.provider, model, settings.priceOverrides ?? {}, key.provider === 'foundry' ? deploymentAlias(settings, model) : undefined);
      if (!price) continue;
      if (!best || price.input + price.output < best.price.input + best.price.output) best = { key, model, price, wire: key.provider === 'foundry' ? deploymentWire(key.lastTest?.find(r => r.model === model)) : null };
    }
  }
  return best;
}
// Low: a third of the screen text is real content; high: all of it. Output: a short note up to the cap. With the agent as
// writer its own context is unknown; the screen text stands in for it.
export function handoffPlan(source: string, engine: CliEngine, screen: string, writer: KeyedWriter | null, subscription: boolean): HandoffPlan {
  const instructions = estimateTokens(handoffInstructions(engine));
  const high = writer ? estimateTokens(handoffPrompt(engine, screen)) : instructions + estimateTokens(screen.slice(-HANDOFF_SOURCE_CHARS));
  const low = Math.max(instructions, Math.round(high / 3)), output = { low: 200, high: HANDOFF_OUTPUT_TOKENS };
  const kind: HandoffWriter = writer ? { kind: 'key', provider: writer.key.provider, model: writer.model, keyLabel: writer.key.label, last4: writer.key.last4 } : { kind: 'agent' };
  const price = writer ? { low: estimateCost(writer.price, low, output.low) ?? 0, high: estimateCost(writer.price, high, output.high) ?? 0 } : null;
  return { source, engine, writer: kind, inputTokens: { low, high }, outputTokens: output, priceUsd: price, subscription: !writer && subscription };
}
export interface Summary { text: string; inputTokens: number | null; outputTokens: number | null }
export type Summarize = (writer: KeyedWriter, secret: string, endpoint: string | null, prompt: string, signal: AbortSignal) => Promise<Summary>;
// One request (no retry: a retried request could be billed twice against one hold), bounded output, the provider's own counts; the fetch is guarded to the key's own endpoint (S16, B12).
export const summarizeWithKey: Summarize = async (writer, secret, endpoint, prompt, signal) => {
  const model = makeModel({ provider: writer.key.provider, model: writer.model, key: secret, endpoint, ...(writer.wire ? { wire: writer.wire } : {}) });
  const result = await generateText({ model, prompt, maxOutputTokens: HANDOFF_OUTPUT_TOKENS, abortSignal: signal, maxRetries: 0 });
  return { text: result.text, inputTokens: result.usage.inputTokens ?? null, outputTokens: result.usage.outputTokens ?? null };
};
