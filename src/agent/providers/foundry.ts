import { createAzure } from '@ai-sdk/azure';
import type { LanguageModel } from 'ai';
import { isEndpoint, isSecret, isValidModelId } from '../../shared/validate.js';
import { guardedFetch, ProviderError, type Fetch } from './guard.js';

// A Foundry deployment on the endpoint bound to its key (B12), key only in `api-key`. GPT deployments speak the Responses
// API; others (Grok, Kimi, DeepSeek, GLM…) only Chat Completions. The key's deployment test decides which (D30): a
// Responses success is 'ready', a Chat Completions success after the Responses refusal is 'chat'.
export type FoundryWire = 'responses' | 'chat';
export function foundryModel(endpoint: string, deployment: string, key: string, wire: FoundryWire = 'responses', base?: Fetch): LanguageModel {
  if (!isEndpoint(endpoint) || !isValidModelId(deployment) || !isSecret(key)) throw new ProviderError('Invalid Foundry settings');
  const provider = createAzure({ baseURL: endpoint.replace(/\/+$/, ''), apiKey: key, fetch: guardedFetch(endpoint, base) });
  return wire === 'chat' ? provider.chat(deployment) : provider.responses(deployment);
}
