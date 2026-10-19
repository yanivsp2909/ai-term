import type { LanguageModel } from 'ai';
import type { KeyProvider } from '../shared/protocol.js';
import { anthropicModel } from './providers/anthropic.js';
import { foundryModel, type FoundryWire } from './providers/foundry.js';
import { openaiModel } from './providers/openai.js';
import { bedrockModel } from './providers/bedrock.js';
import { compatibleModel, isCompatibleProvider } from './providers/compatible.js';
import { vertexModel } from './providers/vertex.js';
import { ProviderError, type Fetch } from './providers/guard.js';
export { guardedFetch, ProviderError } from './providers/guard.js';
export { foundryModel } from './providers/foundry.js';

// The one place that turns a key, its provider and a model id into an AI SDK model. The endpoint is used only where it is
// bound to the key in the Keychain (Foundry, Bedrock, a custom endpoint) or local (Ollama, LM Studio, a server on this
// machine); every other provider has a fixed host in code. key is null only for a local server.
export interface ModelSpec { provider: KeyProvider; model: string; key: string | null; endpoint: string | null; wire?: FoundryWire }
export function makeModel(spec: ModelSpec, base?: Fetch): LanguageModel {
  const { provider, model, key, endpoint } = spec;
  if (provider === 'bedrock') return bedrockModel(model, key, endpoint, base);
  if (provider === 'vertex') return vertexModel(model, key, base);
  if (isCompatibleProvider(provider)) return compatibleModel(provider, model, key, endpoint, base);
  if (key === null) throw new ProviderError('Invalid key settings');
  if (provider === 'foundry') { if (!endpoint) throw new ProviderError('Invalid Foundry settings'); return foundryModel(endpoint, model, key, spec.wire ?? 'responses', base); }
  if (provider === 'anthropic') return anthropicModel(model, key, base);
  return openaiModel(model, key, base);
}
