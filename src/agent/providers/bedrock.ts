import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import type { LanguageModel } from 'ai';
import { isBedrockEndpoint } from '../../shared/providers.js';
import { isSecret, isValidModelId } from '../../shared/validate.js';
import { guardedFetch, ProviderError, type Fetch } from './guard.js';

// v0.6.5: an Amazon Bedrock API key (no AWS login, no SigV4) as the bearer token, to the runtime host of the region bound
// to it in the Keychain (B12). Passing the key and the host explicitly means nothing is read from AWS_* variables.
export function bedrockModel(model: string, key: string | null, endpoint: string | null, base?: Fetch): LanguageModel {
  if (!isValidModelId(model) || !isSecret(key) || !isBedrockEndpoint(endpoint)) throw new ProviderError('Invalid Bedrock settings');
  const region = new URL(endpoint).hostname.split('.')[1] ?? '';
  return createAmazonBedrock({ region, apiKey: key, baseURL: endpoint, fetch: guardedFetch(endpoint, base) })(model);
}
