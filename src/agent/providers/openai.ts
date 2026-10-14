import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { isSecret, isValidModelId } from '../../shared/validate.js';
import { guardedFetch, ProviderError, type Fetch } from './guard.js';

// An OpenAI key goes to api.openai.com only, as its bearer token, through the Responses API. No organization or project
// header: nothing from the environment decides where the key goes.
export const OPENAI_ENDPOINT = 'https://api.openai.com/v1';
export function openaiModel(model: string, key: string, base?: Fetch): LanguageModel {
  if (!isValidModelId(model) || !isSecret(key)) throw new ProviderError('Invalid OpenAI settings');
  return createOpenAI({ baseURL: OPENAI_ENDPOINT, apiKey: key, fetch: guardedFetch(OPENAI_ENDPOINT, base) }).responses(model);
}
