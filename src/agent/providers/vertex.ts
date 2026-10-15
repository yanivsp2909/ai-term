import { createVertex } from '@ai-sdk/google-vertex/edge';
import type { LanguageModel } from 'ai';
import { DIRECT_HOSTS } from '../../shared/providers.js';
import { isSecret, isValidModelId } from '../../shared/validate.js';
import { guardedFetch, ProviderError, type Fetch } from './guard.js';

// v0.6.5: Vertex AI express mode, an API key alone (no gcloud login), in `x-goog-api-key` only, to the fixed express host.
// The edge entry point is used so google-auth-library (for logins we never use) isn't loaded.
export function vertexModel(model: string, key: string | null, base?: Fetch): LanguageModel {
  if (!isValidModelId(model) || !isSecret(key)) throw new ProviderError('Invalid Vertex settings');
  return createVertex({ apiKey: key, baseURL: DIRECT_HOSTS.vertex, fetch: guardedFetch(DIRECT_HOSTS.vertex, base) })(model);
}
