import type { DeploymentTest, ProviderFailureReason } from '../../shared/protocol.js';
import { DIRECT_HOSTS, isBedrockEndpoint, type DirectProvider } from '../../shared/providers.js';
import { isSecret, isValidModelId } from '../../shared/validate.js';
import { ProviderFailure, providerTransport, type ProviderRequest, type ProviderTransport } from './foundry.js';

// v0.6.5: before a model of a new provider is offered, one tiny request (16 output tokens) per model checks that this key
// reaches it. Only the provider's own host (Bedrock: the Keychain-bound region) ever gets the key, in its own header;
// the transport follows no redirect, and only the HTTP status or a fixed reason comes back, never the provider's text.
export type TestedProvider = DirectProvider | 'bedrock';
const TIMEOUT_MS = 15000, MAX_MODELS = 40;
function request(provider: TestedProvider, endpoint: string, model: string, secret: string): ProviderRequest {
  const base = endpoint.replace(/\/+$/, '');
  if (provider === 'bedrock') {
    const url = new URL(`${base}/model/${encodeURIComponent(model)}/converse`);
    return { url, path: url.pathname, model, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: { messages: [{ role: 'user', content: [{ text: 'ping' }] }], inferenceConfig: { maxTokens: 16 } }, timeout: TIMEOUT_MS };
  }
  if (provider === 'vertex') {
    const url = new URL(`${base}/models/${encodeURIComponent(model)}:generateContent`);
    return { url, path: url.pathname, model, headers: { 'x-goog-api-key': secret, 'content-type': 'application/json' }, body: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 16 } }, timeout: TIMEOUT_MS };
  }
  const url = new URL(`${base}/chat/completions`);
  return { url, path: url.pathname, model, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 }, timeout: TIMEOUT_MS };
}
function hostAllowed(provider: TestedProvider, endpoint: string): boolean {
  return provider === 'bedrock' ? isBedrockEndpoint(endpoint) : Object.hasOwn(DIRECT_HOSTS, provider) && DIRECT_HOSTS[provider] === endpoint;
}
export function failureReason(error: unknown): ProviderFailureReason {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return error instanceof ProviderFailure ? error.reason : code === 'ETIMEDOUT' ? 'Provider request timed out' : ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(String(code)) ? 'Provider connection failed' : 'Provider request failed';
}
export async function testDirect(provider: TestedProvider, endpoint: string, models: string[], secret: string, transport: ProviderTransport = providerTransport): Promise<DeploymentTest[]> {
  if (!hostAllowed(provider, endpoint) || !isSecret(secret) || !models.length || models.length > MAX_MODELS || models.some(m => !isValidModelId(m))) throw new Error('Invalid provider test details');
  const results: DeploymentTest[] = [];
  for (const model of models) {
    try {
      const reply = await transport(request(provider, endpoint, model, secret));
      results.push(reply.status >= 200 && reply.status < 300 ? { model, status: 'ready' } : { model, status: 'error', httpStatus: reply.status });
    } catch (error) { results.push({ model, status: 'error', reason: failureReason(error) }); }
  }
  return results;
}
