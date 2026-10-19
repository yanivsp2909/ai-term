import type { KeyProvider, KeyView } from './protocol.js';
// v0.6.5: providers whose keys AI Term's agent alone can use. Each key goes to one official host fixed here (S16), never
// to anything settings.json says: these hosts are not configurable. Bedrock's host depends on its region, so its region
// is bound to the key in the Keychain like a Foundry endpoint (B12). Ollama runs on this Mac and has no key.
// Part A (2026-10-19): more fixed hosts, each from the provider's own API docs (docs/architecture.md §12.31 lists the pages).
// Where a provider runs one official host per region, each region is a provider of its own (moonshot-cn, zai-cn, …): the
// host stays fixed in code, and the Keychain entry's account name (`<provider>:<id>`) binds a key to its region, so editing
// settings.json can't move a key to another host. All of them speak OpenAI's Chat Completions with the key as a bearer
// token, except Vertex (generateContent, x-goog-api-key).
export type DirectProvider = 'xai' | 'moonshot' | 'moonshot-cn' | 'zai' | 'zai-cn' | 'openrouter' | 'vertex'
  | 'gemini' | 'mistral' | 'groq' | 'cerebras' | 'together' | 'fireworks' | 'deepinfra' | 'huggingface'
  | 'deepseek' | 'qwen' | 'qwen-cn' | 'minimax' | 'minimax-cn' | 'ark' | 'byteplus' | 'byteplus-eu' | 'siliconflow' | 'siliconflow-cn' | 'qianfan' | 'qianfan-cn' | 'hunyuan' | 'stepfun' | 'stepfun-cn';
export const DIRECT_HOSTS: Readonly<Record<DirectProvider, string>> = {
  xai: 'https://api.x.ai/v1', moonshot: 'https://api.moonshot.ai/v1', 'moonshot-cn': 'https://api.moonshot.cn/v1', zai: 'https://api.z.ai/api/paas/v4', 'zai-cn': 'https://open.bigmodel.cn/api/paas/v4',
  openrouter: 'https://openrouter.ai/api/v1',
  // Vertex express mode: an API key alone, no Google Cloud login (Gemini models).
  vertex: 'https://aiplatform.googleapis.com/v1/publishers/google',
  // Google's OpenAI compatibility for an AI Studio (Gemini API) key; Google calls it beta.
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  mistral: 'https://api.mistral.ai/v1', groq: 'https://api.groq.com/openai/v1', cerebras: 'https://api.cerebras.ai/v1', together: 'https://api.together.ai/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1', deepinfra: 'https://api.deepinfra.com/v1/openai', huggingface: 'https://router.huggingface.co/v1',
  deepseek: 'https://api.deepseek.com',
  // Alibaba Model Studio's region-wide hosts (Singapore, Beijing); its US, Frankfurt and Tokyo regions have only per-workspace
  // hosts, which would make the host part of the key's details, so they aren't offered.
  qwen: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'qwen-cn': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  minimax: 'https://api.minimax.io/v1', 'minimax-cn': 'https://api.minimax.cn/v1',
  // Volcengine Ark (China) and its international twin BytePlus ModelArk (Johor, Dublin).
  ark: 'https://ark.cn-beijing.volces.com/api/v3', byteplus: 'https://ark.ap-southeast.bytepluses.com/api/v3', 'byteplus-eu': 'https://ark.eu-west.bytepluses.com/api/v3',
  siliconflow: 'https://api.siliconflow.com/v1', 'siliconflow-cn': 'https://api.siliconflow.cn/v1',
  qianfan: 'https://api.baiduqianfan.ai/v1', 'qianfan-cn': 'https://qianfan.baidubce.com/v2',
  // Tencent shut Hunyuan's own API down on 2026-09-30; TokenHub is where its models are now (China only).
  hunyuan: 'https://tokenhub.tencentmaas.com/v1',
  stepfun: 'https://api.stepfun.ai/v1', 'stepfun-cn': 'https://api.stepfun.com/v1',
};
// Providers whose docs don't describe `stream_options.include_usage`: it isn't sent to them (Mistral refuses fields it
// doesn't know). Usage still counts wherever their last chunk carries it; a stream without it is booked at its worst case.
export const NO_STREAM_USAGE_OPTION: ReadonlySet<KeyProvider> = new Set<KeyProvider>(['mistral', 'cerebras', 'together', 'siliconflow', 'siliconflow-cn', 'stepfun', 'stepfun-cn', 'byteplus', 'byteplus-eu']);
export function isDirectProvider(p: KeyProvider): p is DirectProvider { return Object.hasOwn(DIRECT_HOSTS, p); }
// Where each provider's requests go, in one neutral line for /login (D51: words only, no logos). From the provider's own
// docs; "doesn't say" when its docs don't name a place.
export const PROVIDER_REGIONS: Readonly<Record<KeyProvider, string>> = {
  anthropic: 'the provider\'s own servers', openai: 'the provider\'s own servers', foundry: 'the Azure region of the endpoint you enter',
  xai: 'the provider\'s own servers', moonshot: 'Moonshot\'s international platform; its docs don\'t name a country', 'moonshot-cn': 'Moonshot\'s China platform (topping up needs Chinese real-name verification)',
  zai: 'Z.ai\'s international platform; its docs don\'t name a country', 'zai-cn': 'Zhipu\'s China platform',
  openrouter: 'many providers OpenRouter routes to, in several countries', bedrock: 'the AWS region you enter', vertex: 'the provider\'s own servers', ollama: 'this machine only',
  gemini: 'Google\'s servers; its docs don\'t name a country', mistral: 'Mistral\'s servers; it doesn\'t commit to a location for this endpoint', groq: 'Groq\'s servers; its docs don\'t name a country',
  cerebras: 'Cerebras\' servers; its docs don\'t name a country', together: 'Together\'s servers; its docs don\'t name a country', fireworks: 'Fireworks\' servers; its docs don\'t name a country',
  deepinfra: 'DeepInfra\'s servers; its docs don\'t name a country', huggingface: 'whichever provider Hugging Face routes each request to',
  deepseek: 'DeepSeek\'s servers; its privacy policy says your data is stored in China', qwen: 'Alibaba Cloud\'s Singapore region', 'qwen-cn': 'Alibaba Cloud\'s Beijing region (signing up needs Chinese real-name verification)',
  minimax: 'MiniMax\'s international platform; its docs don\'t name a country', 'minimax-cn': 'MiniMax\'s China platform', ark: 'Volcengine\'s Beijing region (China)',
  byteplus: 'BytePlus\' Johor region (Malaysia)', 'byteplus-eu': 'BytePlus\' Dublin region (Ireland)',
  siliconflow: 'SiliconFlow\'s international platform (a Singapore company; not for users in mainland China)', 'siliconflow-cn': 'SiliconFlow\'s China platform',
  qianfan: 'Baidu\'s international platform; its docs don\'t name a country', 'qianfan-cn': 'Baidu\'s China platform', hunyuan: 'Tencent\'s China platform (signing up needs Chinese real-name verification)',
  stepfun: 'StepFun\'s international platform; its docs don\'t name a country', 'stepfun-cn': 'StepFun\'s China platform (paying needs Chinese real-name verification)',
  lmstudio: 'this machine only', local: 'this machine only', custom: 'the host you enter',
};
export function regionLine(provider: KeyProvider): string { return `requests go to ${PROVIDER_REGIONS[provider]}`; }
// The providers the official CLIs can run a key for (D47's fallback); every other key runs only on AI Term's agent.
export const CLI_KEY_PROVIDERS: readonly KeyProvider[] = ['anthropic', 'openai', 'foundry'];
// Keys whose Keychain entry also holds the endpoint and model list (B12): Foundry, Bedrock and (Part A) a custom endpoint.
export function isBoundProvider(p: KeyProvider): p is 'foundry' | 'bedrock' | 'custom' { return p === 'foundry' || p === 'bedrock' || p === 'custom'; }
// Servers on this machine (http://127.0.0.1 only, no key, no Keychain entry): Ollama, and (Part A) LM Studio and any other
// OpenAI-compatible server. Their models come from the server's own list.
export type LocalProvider = 'ollama' | 'lmstudio' | 'local';
export function isLocalProvider(p: KeyProvider): p is LocalProvider { return p === 'ollama' || p === 'lmstudio' || p === 'local'; }
export const LOCAL_DEFAULT_ENDPOINTS: Readonly<Record<LocalProvider, string>> = { ollama: 'http://127.0.0.1:11434', lmstudio: 'http://127.0.0.1:1234', local: 'http://127.0.0.1:8080' };
// Keys that carry their own model list (typed when added, or listed by a local server) and are tested model by model.
export function hasModelList(p: KeyProvider): boolean { return p !== 'anthropic' && p !== 'openai'; }
export const PROVIDER_LABELS: Readonly<Record<KeyProvider, string>> = {
  anthropic: 'Anthropic', openai: 'OpenAI', foundry: 'Microsoft Foundry', xai: 'xAI', moonshot: 'Moonshot · international', 'moonshot-cn': 'Moonshot · China', zai: 'Z.ai · international', 'zai-cn': 'Zhipu (Z.ai) · China',
  openrouter: 'OpenRouter', bedrock: 'Amazon Bedrock', vertex: 'Google Vertex', ollama: 'Ollama',
  gemini: 'Google Gemini API', mistral: 'Mistral', groq: 'Groq', cerebras: 'Cerebras', together: 'Together AI', fireworks: 'Fireworks AI', deepinfra: 'DeepInfra', huggingface: 'Hugging Face',
  deepseek: 'DeepSeek', qwen: 'Qwen (Alibaba Model Studio) · international', 'qwen-cn': 'Qwen (Alibaba Model Studio) · China', minimax: 'MiniMax · international', 'minimax-cn': 'MiniMax · China',
  ark: 'Volcengine Ark (Doubao) · China', byteplus: 'BytePlus ModelArk · Asia Pacific', 'byteplus-eu': 'BytePlus ModelArk · Europe', siliconflow: 'SiliconFlow · international', 'siliconflow-cn': 'SiliconFlow · China',
  qianfan: 'Baidu Qianfan (ERNIE) · international', 'qianfan-cn': 'Baidu Qianfan (ERNIE) · China', hunyuan: 'Tencent TokenHub (Hunyuan) · China', stepfun: 'StepFun · international', 'stepfun-cn': 'StepFun · China',
  lmstudio: 'LM Studio', local: 'OpenAI-compatible server on this machine', custom: 'Custom OpenAI-compatible endpoint',
};

// A local server: plain http to this machine's loopback address only, an explicit port, nothing after it. `localhost` is
// refused because it is a name a hosts file or resolver can point anywhere.
export const OLLAMA_DEFAULT_ENDPOINT = LOCAL_DEFAULT_ENDPOINTS.ollama;
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
// How a key is named on cards, the start box and presets: by its last 4, except a local server, which has none.
export function keyAuthLabel(provider: KeyProvider, last4: string): string { return isLocalProvider(provider) ? 'local · no key' : `key ····${last4}`; }
// A model a key offers: for these providers, one whose own tiny test request (or Ollama's listing) succeeded.
export function testedModels(key: KeyView): string[] {
  return (key.deployments ?? []).filter(model => key.lastTest?.some(r => r.model === model && r.status === 'ready'));
}
