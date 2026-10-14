import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import { isSecret, isValidModelId } from '../../shared/validate.js';
import { guardedFetch, ProviderError, type Fetch } from './guard.js';

// An Anthropic key goes to api.anthropic.com only, in `x-api-key` only (never as a bearer token).
export const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1';
export function anthropicModel(model: string, key: string, base?: Fetch): LanguageModel {
  if (!isValidModelId(model) || !isSecret(key)) throw new ProviderError('Invalid Anthropic settings');
  return createAnthropic({ baseURL: ANTHROPIC_ENDPOINT, apiKey: key, fetch: guardedFetch(ANTHROPIC_ENDPOINT, base) })(model);
}
