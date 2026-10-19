import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { KeyProvider } from '../../shared/protocol.js';
import { DIRECT_HOSTS, NO_STREAM_USAGE_OPTION, PROVIDER_LABELS, isDirectProvider, isLocalEndpoint, isLocalProvider, type DirectProvider, type LocalProvider } from '../../shared/providers.js';
import { isPublicEndpoint } from '../../shared/public-host.js';
import { isSecret, isValidModelId } from '../../shared/validate.js';
import { guardedFetch, ProviderError, type Fetch } from './guard.js';
import { publicFetch } from './public-fetch.js';

// v0.6.5: xAI, Moonshot, Z.ai and OpenRouter speak OpenAI's Chat Completions on their own fixed hosts, the key as the
// bearer token; Ollama the same on http://127.0.0.1 with no key and no Authorization header at all. includeUsage asks
// for the counts in the stream: without them every request would be booked at its worst case.
// Part A: every fixed-host provider of providers.ts but Vertex, LM Studio and any server on this machine (like Ollama),
// and a custom endpoint: the one bound to its key in the Keychain, reached only at public addresses (publicFetch).
export type CompatibleProvider = Exclude<DirectProvider, 'vertex'> | LocalProvider | 'custom';
export function isCompatibleProvider(p: KeyProvider): p is CompatibleProvider { return p === 'custom' || isLocalProvider(p) || isDirectProvider(p) && p !== 'vertex'; }
export function compatibleModel(provider: CompatibleProvider, model: string, key: string | null, endpoint: string | null, base?: Fetch): LanguageModel {
  const local = isLocalProvider(provider), custom = provider === 'custom';
  const valid = isValidModelId(model) && (local ? key === null && isLocalEndpoint(endpoint) : isSecret(key) && (!custom || isPublicEndpoint(endpoint)));
  if (!valid) throw new ProviderError(`Invalid ${PROVIDER_LABELS[provider]} settings`);
  const baseURL = local ? `${endpoint}/v1` : custom ? (endpoint ?? '').replace(/\/+$/, '') : DIRECT_HOSTS[provider];
  const fetch = guardedFetch(baseURL, base ?? (custom ? publicFetch() : undefined), { plainLocal: local });
  return createOpenAICompatible({ name: provider, baseURL, ...(key !== null ? { apiKey: key } : {}), includeUsage: !NO_STREAM_USAGE_OPTION.has(provider), fetch }).chatModel(model);
}
