import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// A stand-in for Ollama on 127.0.0.1 (no key, no network): GET /api/tags lists one model, and POST /v1/chat/completions
// answers in OpenAI's streaming format.
// - A user message with a line "LIVE run: <command>" gets one bash tool call with that command, and "LIVE read: <path>"
//   one read call (LIVE first: on an empty command bar a lowercase letter is a homepage key).
// - An add-on's first message (it asks for the result between RESULT_<nonce>_BEGIN and _END) gets the reply the check
//   queued with `addon()`: optionally one bash call first, then the result block with that nonce.
// - A tool result gets a short text answer; any other message gets "LIVE-STUB: hello.".
// Every tool result and user message it receives is kept, so a check can read exactly what an agent's command printed.
export const STUB_MODEL = 'live-stub';
export interface AddonReply { bash?: string; result: Record<string, unknown> }
// errors: requests the stub itself couldn't answer (a run fails on any: review, they were a bare 500 before).
export interface StubOllama { endpoint: string; toolResults: string[]; userMessages: string[]; requests: number; errors: string[]; addon(reply: AddonReply): void; close(): Promise<void> }
interface Message { role?: unknown; content?: unknown }
interface State { toolResults: string[]; userMessages: string[]; requests: number; calls: number; addons: AddonReply[]; pending: Map<string, AddonReply>; errors: string[] }
const text = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : '').join('') : '';
const NONCE = /RESULT_([0-9a-f]{32})_BEGIN/;

export async function startStubOllama(): Promise<StubOllama> {
  const state: State = { toolResults: [], userMessages: [], requests: 0, calls: 0, addons: [], pending: new Map(), errors: [] };
  const server: Server = createServer((req, res) => { handle(req, res, state).catch((error: unknown) => { state.errors.push(`${req.method ?? '?'} ${req.url ?? '?'}: ${error instanceof Error ? error.message : String(error)}`); if (!res.headersSent) res.writeHead(500); res.end(); }); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    get toolResults() { return state.toolResults; },
    get userMessages() { return state.userMessages; },
    get requests() { return state.requests; },
    get errors() { return state.errors; },
    addon: reply => { state.addons.push(reply); },
    close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }),
  };
}

async function body(req: IncomingMessage): Promise<string> {
  let data = '';
  for await (const chunk of req) { data += String(chunk); if (data.length > 8 * 1024 * 1024) throw new Error('too large'); }
  return data;
}
async function handle(req: IncomingMessage, res: ServerResponse, state: State): Promise<void> {
  if (req.method === 'GET' && req.url === '/api/tags') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: [{ name: STUB_MODEL }] })); return; }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
  state.requests++;
  const request = JSON.parse(await body(req)) as { messages?: Message[] };
  const messages = Array.isArray(request.messages) ? request.messages : [], last = messages.at(-1);
  // The add-on this conversation belongs to, by the nonce in its first user message.
  const nonce = messages.map(m => m.role === 'user' ? text(m.content).match(NONCE)?.[1] : undefined).find(Boolean);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) => res.write(`data: ${JSON.stringify({ id: 'live', object: 'chat.completion.chunk', created: 0, model: STUB_MODEL, choices, ...extra })}\n\n`);
  const end = (finish: 'stop' | 'tool_calls') => { chunk([{ index: 0, delta: {}, finish_reason: finish }]); chunk([], { usage: { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 } }); res.end('data: [DONE]\n\n'); };
  const say = (words: string) => { chunk([{ index: 0, delta: { role: 'assistant', content: words }, finish_reason: null }]); end('stop'); };
  const call = (name: string, input: Record<string, string>) => { state.calls++; chunk([{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${state.calls}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }, finish_reason: null }]); end('tool_calls'); };
  const bash = (command: string) => call('bash', { command });
  const result = (id: string, reply: AddonReply) => say(`RESULT_${id}_BEGIN\n${JSON.stringify(reply.result)}\nRESULT_${id}_END`);
  if (nonce) {
    let reply = state.pending.get(nonce);
    if (!reply) { reply = state.addons.shift() ?? { result: { kind: 'unknown' } }; state.pending.set(nonce, reply); if (reply.bash) { bash(reply.bash); return; } }
    if (last?.role === 'tool') state.toolResults.push(text(last.content));
    result(nonce, reply); return;
  }
  if (last?.role === 'tool') { state.toolResults.push(text(last.content)); say('LIVE-STUB: the command finished.'); return; }
  if (last?.role === 'user') state.userMessages.push(text(last.content));
  const command = text(last?.content).match(/^LIVE run: (.+)$/m)?.[1], read = text(last?.content).match(/^LIVE read: (.+)$/m)?.[1];
  if (last?.role === 'user' && command) { bash(command); return; }
  if (last?.role === 'user' && read) { call('read', { path: read }); return; }
  say('LIVE-STUB: hello.');
}
