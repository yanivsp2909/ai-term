// Every provider of AI Term's agent sends its key in its own header to one endpoint: a fixed one (Anthropic, OpenAI and
// the v0.6.5 providers) or the one bound to the key in the Keychain (Foundry, Bedrock, B12). This fetch refuses every URL
// outside that endpoint and never follows a redirect, because a redirect would carry the key header to whatever host it
// names (S16, S19). Plain http only for a guard its caller made for Ollama (plainLocal: no key) on 127.0.0.1.
export class ProviderError extends Error {}
export type Fetch = typeof globalThis.fetch;

export function guardedFetch(endpoint: string, base: Fetch = globalThis.fetch, options: { plainLocal?: boolean } = {}): Fetch {
  const allowed = new URL(endpoint.endsWith('/') ? endpoint : endpoint + '/');
  // Decided from the parsed URL, not its origin string: an origin drops a default port such as :80.
  const protocol = options.plainLocal && allowed.hostname === '127.0.0.1' ? 'http:' : 'https:';
  return (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.protocol !== protocol || allowed.protocol !== protocol || target.origin !== allowed.origin || !(target.pathname + '/').startsWith(allowed.pathname)) return Promise.reject(new ProviderError('Request outside the provider endpoint'));
    return base(input, { ...init, redirect: 'error' });
  };
}
