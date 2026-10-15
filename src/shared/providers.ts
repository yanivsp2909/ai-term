import type { KeyProvider, KeyView } from './protocol.js';
// v0.6.5: providers whose keys AI Term's agent alone can use. Each key goes to one official host fixed here (S16), never
// to anything settings.json says: these hosts are not configurable. Bedrock's host depends on its region, so its region
// is bound to the key in the Keychain like a Foundry endpoint (B12). Ollama runs on this Mac and has no key.
export type DirectProvider = 'xai' | 'moonshot' | 'zai' | 'openrouter' | 'vertex';
export const DIRECT_HOSTS: Readonly<Record<DirectProvider, string>> = {
  xai: 'https://api.x.ai/v1', moonshot: 'https://api.moonshot.ai/v1', zai: 'https://api.z.ai/api/paas/v4', openrouter: 'https://openrouter.ai/api/v1',
  // Vertex express mode: an API key alone, no Google Cloud login (Gemini models).
  vertex: 'https://aiplatform.googleapis.com/v1/publishers/google',
};
export function isDirectProvider(p: KeyProvider): p is DirectProvider { return Object.hasOwn(DIRECT_HOSTS, p); }
// The providers the official CLIs can run a key for (D47's fallback); every other key runs only on AI Term's agent.
export const CLI_KEY_PROVIDERS: readonly KeyProvider[] = ['anthropic', 'openai', 'foundry'];
// Keys whose Keychain entry also holds the endpoint and model list (B12).
export function isBoundProvider(p: KeyProvider): p is 'foundry' | 'bedrock' { return p === 'foundry' || p === 'bedrock'; }
// Keys that carry their own model list (typed when added, or listed by Ollama) and are tested model by model.
export function hasModelList(p: KeyProvider): boolean { return p !== 'anthropic' && p !== 'openai'; }
export const PROVIDER_LABELS: Readonly<Record<KeyProvider, string>> = {
  anthropic: 'Anthropic', openai: 'OpenAI', foundry: 'Microsoft Foundry', xai: 'xAI', moonshot: 'Moonshot', zai: 'Z.ai', openrouter: 'OpenRouter',
  bedrock: 'Amazon Bedrock', vertex: 'Google Vertex', ollama: 'Ollama',
};

// Ollama: plain http to this Mac's loopback address only, an explicit port, nothing after it. `localhost` is refused
// because it is a name a hosts file or resolver can point anywhere.
export const OLLAMA_DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';
export function isLocalEndpoint(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const port = v.match(/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/)?.[1];
  return port !== undefined && Number(port) <= 65535;
}
const BEDROCK_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
export function bedrockEndpoint(region: string): string | null { return BEDROCK_REGION.test(region) ? `https://bedrock-runtime.${region}.amazonaws.com` : null; }
export function isBedrockEndpoint(v: unknown): v is string {
  const region = typeof v === 'string' ? v.match(/^https:\/\/bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com$/)?.[1] : undefined;
  return region !== undefined && bedrockEndpoint(region) === v;
}
// A model a key offers: for these providers, one whose own tiny test request (or Ollama's listing) succeeded.
export function testedModels(key: KeyView): string[] {
  return (key.deployments ?? []).filter(model => key.lastTest?.some(r => r.model === model && r.status === 'ready'));
}
