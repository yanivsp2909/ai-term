// Every provider of AI Term's agent sends its key in its own header to one endpoint: a fixed one (Anthropic, OpenAI) or
// the one bound to the key in the Keychain (Foundry, B12). This fetch refuses every URL outside that endpoint and never
// follows a redirect, because a redirect would carry the key header to whatever host it names (S16, S19).
export class ProviderError extends Error {}
export type Fetch = typeof globalThis.fetch;

export function guardedFetch(endpoint: string, base: Fetch = globalThis.fetch): Fetch {
  const allowed = new URL(endpoint.endsWith('/') ? endpoint : endpoint + '/');
  return (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.protocol !== 'https:' || target.origin !== allowed.origin || !(target.pathname + '/').startsWith(allowed.pathname)) return Promise.reject(new ProviderError('Request outside the provider endpoint'));
    return base(input, { ...init, redirect: 'error' });
  };
}
