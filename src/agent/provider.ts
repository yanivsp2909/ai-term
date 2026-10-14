import type { LanguageModel } from 'ai';
import type { KeyProvider } from '../shared/protocol.js';
import { anthropicModel } from './providers/anthropic.js';
import { foundryModel, type FoundryWire } from './providers/foundry.js';
import { openaiModel } from './providers/openai.js';
import { ProviderError, type Fetch } from './providers/guard.js';
export { guardedFetch, ProviderError } from './providers/guard.js';
export { foundryModel } from './providers/foundry.js';

// The one place that turns a key, its provider and a model id into an AI SDK model. The endpoint is used for Foundry only
// (the Keychain-bound one); Anthropic and OpenAI have fixed hosts in their own modules.
export interface ModelSpec { provider: KeyProvider; model: string; key: string; endpoint: string | null; wire?: FoundryWire }
export function makeModel(spec: ModelSpec, base?: Fetch): LanguageModel {
  if (spec.provider === 'foundry') { if (!spec.endpoint) throw new ProviderError('Invalid Foundry settings'); return foundryModel(spec.endpoint, spec.model, spec.key, spec.wire ?? 'responses', base); }
  if (spec.provider === 'anthropic') return anthropicModel(spec.model, spec.key, base);
  return openaiModel(spec.model, spec.key, base);
}
