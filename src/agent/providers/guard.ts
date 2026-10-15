import { isLocalEndpoint } from '../../shared/providers.js';
// Every provider of AI Term's agent sends its key in its own header to one endpoint: a fixed one (Anthropic, OpenAI and
// the v0.6.5 providers) or the one bound to the key in the Keychain (Foundry, Bedrock, B12). This fetch refuses every URL
// outside that endpoint and never follows a redirect, because a redirect would carry the key header to whatever host it
// names (S16, S19). Plain http is allowed only when the endpoint itself is Ollama's 127.0.0.1 one, which has no key.
export class ProviderError extends Error {}
export type Fetch = typeof globalThis.fetch;

export function guardedFetch(endpoint: string, base: Fetch = globalThis.fetch): Fetch {
  const allowed = new URL(endpoint.endsWith('/') ? endpoint : endpoint + '/');
  const protocol = isLocalEndpoint(allowed.origin) ? 'http:' : 'https:';
  return (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.protocol !== protocol || allowed.protocol !== protocol || target.origin !== allowed.origin || !(target.pathname + '/').startsWith(allowed.pathname)) return Promise.reject(new ProviderError('Request outside the provider endpoint'));
    return base(input, { ...init, redirect: 'error' });
  };
}
