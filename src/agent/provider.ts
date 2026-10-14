import { createAzure } from '@ai-sdk/azure';
import type { LanguageModel } from 'ai';
import { isEndpoint, isSecret, isValidModelId } from '../shared/validate.js';

// v0.4.1's one provider: an Azure AI Foundry deployment through the Responses API, the same wire the Foundry key's
// deployment test already passed. The endpoint is the one bound to the key in the Keychain (B12); the provider sends the
// key only in its `api-key` header (S16). The fetch below refuses every URL outside that endpoint and never follows a
// redirect, because a redirect would carry the `api-key` header to whatever host it names.
export class ProviderError extends Error {}
type Fetch = typeof globalThis.fetch;

export function guardedFetch(endpoint: string, base: Fetch = globalThis.fetch): Fetch {
  const allowed = new URL(endpoint.endsWith('/') ? endpoint : endpoint + '/');
  return (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.protocol !== 'https:' || target.origin !== allowed.origin || !(target.pathname + '/').startsWith(allowed.pathname)) return Promise.reject(new ProviderError('Request outside the Foundry endpoint'));
    return base(input, { ...init, redirect: 'error' });
  };
}

export function foundryModel(endpoint: string, deployment: string, key: string, base?: Fetch): LanguageModel {
  if (!isEndpoint(endpoint) || !isValidModelId(deployment) || !isSecret(key)) throw new ProviderError('Invalid Foundry settings');
  return createAzure({ baseURL: endpoint.replace(/\/+$/, ''), apiKey: key, fetch: guardedFetch(endpoint, base) }).responses(deployment);
}
