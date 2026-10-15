import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { DIRECT_HOSTS, PROVIDER_LABELS, isLocalEndpoint } from '../../shared/providers.js';
import { isSecret, isValidModelId } from '../../shared/validate.js';
import { guardedFetch, ProviderError, type Fetch } from './guard.js';

// v0.6.5: xAI, Moonshot, Z.ai and OpenRouter speak OpenAI's Chat Completions on their own fixed hosts, the key as the
// bearer token; Ollama the same on http://127.0.0.1 with no key and no Authorization header at all. includeUsage asks
// for the counts in the stream: without them every request would be booked at its worst case.
export type CompatibleProvider = 'xai' | 'moonshot' | 'zai' | 'openrouter' | 'ollama';
export function compatibleModel(provider: CompatibleProvider, model: string, key: string | null, endpoint: string | null, base?: Fetch): LanguageModel {
  const local = provider === 'ollama';
  if (!isValidModelId(model) || (local ? key !== null || !isLocalEndpoint(endpoint) : !isSecret(key))) throw new ProviderError(`Invalid ${PROVIDER_LABELS[provider]} settings`);
  const baseURL = local ? `${endpoint}/v1` : DIRECT_HOSTS[provider];
  return createOpenAICompatible({ name: provider, baseURL, ...(key !== null ? { apiKey: key } : {}), includeUsage: true, fetch: guardedFetch(baseURL, base) }).chatModel(model);
}
