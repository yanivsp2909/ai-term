import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CredentialsPanel } from '../src/client/tui/credentials.js';
import type { RequestBody } from '../src/client/connection.js';
import type { KeyView, SuccessResponse } from '../src/shared/protocol.js';

// v0.6.5 in /login and /settings: every new provider is added, tested, shown (last 4 only) and removed like today's keys.
const KEY = 'AITERMCANARY-ui-0123456789abcdef';
function panel(kind: 'login' | 'settings', keys: KeyView[] = []) {
  const sent: RequestBody[] = [];
  const request = async (body: RequestBody): Promise<SuccessResponse> => {
    sent.push(structuredClone(body));
    if (body.kind === 'keys.add') { const key: KeyView = { id: randomUUID(), provider: body.provider, label: body.label, last4: body.secret ? 'cdef' : '', ...(body.endpoint ? { endpoint: body.endpoint } : {}), ...(body.deployments ? { deployments: body.deployments } : {}) }; keys.push(key); return { id: randomUUID(), ok: true, key }; }
    if (body.kind === 'keys.test') return { id: randomUUID(), ok: true, results: [{ model: 'grok-5', status: 'ready' }, { model: 'grok-x', status: 'error', httpStatus: 404 }] };
    if (body.kind === 'keys.list') return { id: randomUUID(), ok: true, keys };
    if (body.kind === 'settings.get') return { id: randomUUID(), ok: true, settings: { theme: 'graphite' } };
    return { id: randomUUID(), ok: true };
  };
  const p = new CredentialsPanel(kind, { request, changed() {}, close() {}, login: async () => {}, defaults() {}, theme: async () => {} });
  return { p, sent };
}
const type = async (p: CredentialsPanel, text: string) => { for (const char of text) await p.key(char); };
async function choose(p: CredentialsPanel, index: number) { for (let i = 0; i < index; i++) await p.key('down'); await p.key('enter'); }

it('/login lists every provider; a new one goes straight to its form (no CLI login exists for it)', async () => {
  const { p } = panel('login');
  expect(p.lines().slice(0, 11)).toEqual(['Connect a provider', '› Anthropic', '  OpenAI', '  Microsoft Foundry', '  xAI', '  Moonshot', '  Z.ai', '  OpenRouter', '  Amazon Bedrock', '  Google Vertex', '  Ollama']);
  await choose(p, 3);
  expect(p.lines().slice(0, 4)).toEqual(['Add API key · xAI', '› label: xAI', '  secret: ', '  models: ']);
});

it('xAI: key and models saved, then each model tested at once; the key never shows', async () => {
  const { p, sent } = panel('login');
  await choose(p, 3); await p.key('enter'); await type(p, KEY); await p.key('enter'); await type(p, 'grok-5, grok-x'); await p.key('enter');
  expect(sent.find(b => b.kind === 'keys.add')).toEqual({ kind: 'keys.add', provider: 'xai', label: 'xAI', secret: '', deployments: ['grok-5', 'grok-x'] });
  expect(sent.map(b => b.kind)).toContain('keys.test');
  const text = p.lines().join('\n');
  expect(text).toContain('grok-5: ready'); expect(text).toContain('grok-x: error 404'); expect(text).not.toContain(KEY);
});

it('a model-list provider needs at least one model id before anything is sent', async () => {
  const { p, sent } = panel('login');
  await choose(p, 6); await p.key('enter'); await type(p, KEY); await p.key('enter'); await p.key('enter');
  expect(sent.filter(b => b.kind === 'keys.add')).toEqual([]);
  expect(p.lines().join('\n')).toContain('Enter a key and model ids, comma separated');
});

it('Bedrock: a region becomes the runtime host; anything else is refused before sending', async () => {
  const { p, sent } = panel('login');
  await choose(p, 7);
  expect(p.lines().slice(0, 5)).toEqual(['Add API key · Amazon Bedrock', '› label: Bedrock', '  region: ', '  secret: ', '  models: ']);
  await p.key('enter'); await type(p, 'us-east-1/evil'); await p.key('enter'); await type(p, KEY); await p.key('enter'); await type(p, 'us.anthropic.claude-sonnet-5-v1:0'); await p.key('enter');
  expect(sent.filter(b => b.kind === 'keys.add')).toEqual([]); expect(p.lines().join('\n')).toContain('Enter a key, a region like us-east-1 and model ids');
  for (let i = 0; i < 3; i++) await p.key('up');
  for (let i = 0; i < 'us-east-1/evil'.length; i++) await p.key('backspace');
  await type(p, 'eu-west-1'); await p.key('down'); await p.key('down'); await p.key('enter');
  expect(sent.find(b => b.kind === 'keys.add')).toMatchObject({ provider: 'bedrock', endpoint: 'https://bedrock-runtime.eu-west-1.amazonaws.com', deployments: ['us.anthropic.claude-sonnet-5-v1:0'] });
});

it('Ollama: no key field, a local endpoint prefilled; any other URL is refused', async () => {
  const { p, sent } = panel('login');
  await choose(p, 9);
  expect(p.lines().slice(0, 3)).toEqual(['Add Ollama · this Mac, no key', '› label: Ollama', '  endpoint: http://127.0.0.1:11434']);
  await p.key('enter'); for (let i = 0; i < 5; i++) await p.key('backspace'); await type(p, ':80'); await p.key('enter');
  // http://127.0.0.1:80 is still local; the request carries no secret at all.
  const added = sent.find(b => b.kind === 'keys.add');
  expect(added).toEqual({ kind: 'keys.add', provider: 'ollama', label: 'Ollama', endpoint: 'http://127.0.0.1:80' });
  const { p: q, sent: none } = panel('login');
  await choose(q, 9); await q.key('enter'); for (let i = 0; i < 22; i++) await q.key('backspace'); await type(q, 'http://localhost:11434'); await q.key('enter');
  expect(none.filter(b => b.kind === 'keys.add')).toEqual([]); expect(q.lines().join('\n')).toContain('Ollama runs at http://127.0.0.1:<port>');
});

it('/settings shows each key by its last 4 (Ollama: no key) and removes and tests it like any other', async () => {
  const keys: KeyView[] = [{ id: randomUUID(), provider: 'xai', label: 'grok', last4: 'abcd', deployments: ['grok-5'] }, { id: randomUUID(), provider: 'ollama', label: 'local', last4: '', endpoint: 'http://127.0.0.1:11434', deployments: [] }];
  const { p, sent } = panel('settings', keys);
  await p.load();
  const text = p.lines().join('\n');
  expect(text).toContain('› grok · xAI · key ····abcd'); expect(text).toContain('  local · Ollama · no key · http://127.0.0.1:11434');
  await p.key('t'); expect(sent.at(-2)).toMatchObject({ kind: 'keys.test', keyId: keys[0]?.id });
  await p.key('down'); await p.key('x'); expect(sent.find(b => b.kind === 'keys.remove')).toMatchObject({ keyId: keys[1]?.id });
  expect(p.lines().join('\n')).toContain('Key removed');
});
