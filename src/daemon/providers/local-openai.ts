import { isLocalEndpoint } from '../../shared/providers.js';
import { isValidModelId } from '../../shared/validate.js';
import { localGet, OllamaError, type LocalGet, type LocalReply } from './ollama.js';

// Part A: LM Studio and any other OpenAI-compatible server on this machine. Like Ollama: only http://127.0.0.1:<port>, no
// key and no Authorization header, a 5 s deadline, a 256 KiB reply and at most 40 valid model ids, read from the server's
// own `GET /v1/models` ({"data":[{"id":…}]}). The ids are another program's text, so anything else is dropped.
// detail (for the daemon's log only): a status, an error code or a fixed word, never the reply.
export class LocalServerError extends Error { constructor(message: string, readonly detail = 'refused') { super(message); } }
export const LOCAL_SERVER_ERRORS = ['The server must be at http://127.0.0.1:<port>', 'Nothing answers there; start the server, then test again (t)', 'The server did not answer with a model list'] as const;
const TIMEOUT_MS = 5000, MAX_MODELS = 40;
export async function listLocalOpenAI(endpoint: string, get: LocalGet = localGet): Promise<string[]> {
  if (!isLocalEndpoint(endpoint)) throw new LocalServerError('The server must be at http://127.0.0.1:<port>', 'not local');
  let reply: LocalReply;
  try { reply = await get(new URL(`${endpoint}/v1/models`), TIMEOUT_MS); }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^E[A-Z]+$/.test(error.code) ? error.code : error instanceof OllamaError ? 'timeout or too large' : 'request failed';
    throw new LocalServerError(code === 'ECONNREFUSED' ? 'Nothing answers there; start the server, then test again (t)' : 'The server did not answer with a model list', code);
  }
  if (reply.status !== 200) throw new LocalServerError('The server did not answer with a model list', `status ${reply.status}`);
  let value: unknown;
  try { value = JSON.parse(reply.body); } catch { value = null; }
  const list = value && typeof value === 'object' && 'data' in value && Array.isArray(value.data) ? value.data as unknown[] : null;
  if (!list) throw new LocalServerError('The server did not answer with a model list', 'not a model list');
  const ids = list.flatMap(entry => entry && typeof entry === 'object' && 'id' in entry && typeof entry.id === 'string' && isValidModelId(entry.id) ? [entry.id] : []);
  return [...new Set(ids)].slice(0, MAX_MODELS);
}
