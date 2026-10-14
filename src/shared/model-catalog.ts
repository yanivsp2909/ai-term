import prices from '../../data/usage-prices.json' with { type: 'json' };
import { isValidModelId } from './validate.js';
// The models AI Term knows from its price catalog (D45: Models.dev list prices, data/usage-prices.json). Keyed agents
// offer only these chat models for Anthropic and OpenAI keys; a Foundry deployment can be told which of them it is.
export type CatalogProvider = 'anthropic' | 'openai' | 'azure';
const NOT_CHAT = /embed|image|realtime|tts|whisper|dall-e|moderation|audio|transcribe|instruct|router/i, SNAPSHOT = /-\d{8}$|-\d{4}-\d{2}-\d{2}$|-\d{4}$/;
const table = (prices as { providers: Record<CatalogProvider, Record<string, unknown>> }).providers;
// A model id the catalog would offer as a chat model (no embeddings, images, audio, realtime or dated snapshots).
export function isChatCatalogId(id: string): boolean { return isValidModelId(id) && !NOT_CHAT.test(id) && !SNAPSHOT.test(id); }
export function catalogModels(provider: CatalogProvider): string[] {
  return Object.keys(table[provider] ?? {}).filter(id => isValidModelId(id) && !NOT_CHAT.test(id) && !SNAPSHOT.test(id)).sort();
}
// Every model the catalog prices except embeddings, images and audio, for the "this deployment is model X" picker: a
// Foundry deployment may well be an instruct or dated model.
const NOT_TEXT = /embed|image|realtime|tts|whisper|dall-e|moderation|audio|transcribe/i;
export function catalogIds(): string[] { return [...new Set((['azure', 'openai', 'anthropic'] as const).flatMap(provider => Object.keys(table[provider] ?? {})).filter(id => isValidModelId(id) && !NOT_TEXT.test(id)))].sort(); }
