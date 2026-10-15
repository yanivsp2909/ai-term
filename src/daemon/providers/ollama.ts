import { request } from 'node:http';
import { isLocalEndpoint } from '../../shared/providers.js';
import { isValidModelId } from '../../shared/validate.js';

// v0.6.5: Ollama's models, from the local server's own list (GET /api/tags). Only http://127.0.0.1:<port>; no key, no
// redirect (node's http client never follows one), a 5 s deadline and a 256 KiB cap on the reply. The names are
// untrusted text from another program, so only valid model ids pass, at most 40 (like a Foundry key's deployments).
export class OllamaError extends Error {}
export interface LocalReply { status: number; body: string }
export type LocalGet = (url: URL, timeout: number) => Promise<LocalReply>;
const MAX_REPLY = 256 * 1024, TIMEOUT_MS = 5000, MAX_MODELS = 40;
export const localGet: LocalGet = (url, timeout) => new Promise((resolve, reject) => {
  const req = request(url, { method: 'GET' }, res => {
    let bytes = 0, body = ''; res.setEncoding('utf8');
    res.on('data', (chunk: string) => { bytes += Buffer.byteLength(chunk); if (bytes > MAX_REPLY) { req.destroy(new OllamaError('Ollama reply too large')); return; } body += chunk; });
    res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode ?? 500, body }));
  });
  const timer = setTimeout(() => req.destroy(new OllamaError('Ollama timed out')), timeout);
  req.on('error', reject); req.on('close', () => clearTimeout(timer)); req.end();
});
export const OLLAMA_ERRORS = ['Ollama must be http://127.0.0.1:<port>', 'Ollama is not running', 'Ollama did not answer'] as const;
export async function listOllama(endpoint: string, get: LocalGet = localGet): Promise<string[]> {
  if (!isLocalEndpoint(endpoint)) throw new OllamaError('Ollama must be http://127.0.0.1:<port>');
  let reply: LocalReply;
  try { reply = await get(new URL(`${endpoint}/api/tags`), TIMEOUT_MS); }
  catch (error) { throw new OllamaError(error && typeof error === 'object' && 'code' in error && error.code === 'ECONNREFUSED' ? 'Ollama is not running' : 'Ollama did not answer'); }
  let value: unknown;
  try { value = reply.status === 200 ? JSON.parse(reply.body) : null; } catch { value = null; }
  const list = value && typeof value === 'object' && 'models' in value && Array.isArray(value.models) ? value.models as unknown[] : null;
  if (!list) throw new OllamaError('Ollama did not answer');
  const names = list.flatMap(entry => entry && typeof entry === 'object' && 'name' in entry && typeof entry.name === 'string' && isValidModelId(entry.name) ? [entry.name] : []);
  return [...new Set(names)].slice(0, MAX_MODELS);
}
