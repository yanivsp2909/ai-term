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
// Part A: by label, so a provider added to the list doesn't move what a test picks.
async function choose(p: CredentialsPanel, label: string) { const index = p.lines().slice(1).findIndex(line => line.slice(2) === label); if (index < 0) throw new Error(`no provider ${label}`); for (let i = 0; i < index; i++) await p.key('down'); await p.key('enter'); }

it('/login lists every provider; a new one goes straight to its form (no CLI login exists for it)', async () => {
  const { p } = panel('login');
  const listed = p.lines().slice(0, 40);
  expect(listed.slice(0, 5)).toEqual(['Connect a provider', '› Anthropic', '  OpenAI', '  Microsoft Foundry', '  xAI']);
  for (const label of ['Moonshot · international', 'Moonshot · China', 'Z.ai · international', 'Zhipu (Z.ai) · China', 'OpenRouter', 'Amazon Bedrock', 'Google Vertex', 'Ollama', 'LM Studio', 'Custom OpenAI-compatible endpoint']) expect(listed).toContain(`  ${label}`);
  // Part A: the highlighted provider's region, one neutral line.
  expect(p.lines()).toContain("requests go to the provider's own servers");
  await choose(p, 'xAI');
  expect(p.lines().slice(0, 5)).toEqual(['Add API key · xAI', "requests go to the provider's own servers", '› label: xAI', '  secret: ', '  models: ']);
});

it('xAI: key and models saved, then each model tested at once; the key never shows', async () => {
  const { p, sent } = panel('login');
  await choose(p, 'xAI'); await p.key('enter'); await type(p, KEY); await p.key('enter'); await type(p, 'grok-5, grok-x'); await p.key('enter');
  // The request carries the key once; the panel's own copy is blanked as soon as it is sent.
  expect(sent.find(b => b.kind === 'keys.add')).toEqual({ kind: 'keys.add', provider: 'xai', label: 'xAI', secret: KEY, deployments: ['grok-5', 'grok-x'] });
  expect(sent.map(b => b.kind)).toContain('keys.test');
  const text = p.lines().join('\n');
  expect(text).toContain('grok-5: ready'); expect(text).toContain('grok-x: error 404'); expect(text).not.toContain(KEY);
});

it('a model-list provider needs at least one model id before anything is sent', async () => {
  const { p, sent } = panel('login');
  await choose(p, 'OpenRouter'); await p.key('enter'); await type(p, KEY); await p.key('enter'); await p.key('enter');
  expect(sent.filter(b => b.kind === 'keys.add')).toEqual([]);
  expect(p.lines().join('\n')).toContain('Enter a key and model ids, comma separated');
});

it('Bedrock: a region becomes the runtime host; anything else is refused before sending', async () => {
  const { p, sent } = panel('login');
  await choose(p, 'Amazon Bedrock');
  expect(p.lines().slice(0, 6)).toEqual(['Add API key · Amazon Bedrock', 'requests go to the AWS region you enter', '› label: Bedrock', '  region: ', '  secret: ', '  models: ']);
  await p.key('enter'); await type(p, 'us-east-1/evil'); await p.key('enter'); await type(p, KEY); await p.key('enter'); await type(p, 'us.anthropic.claude-sonnet-5-v1:0'); await p.key('enter');
  expect(sent.filter(b => b.kind === 'keys.add')).toEqual([]); expect(p.lines().join('\n')).toContain('Enter a key, a region like us-east-1 and model ids');
  for (let i = 0; i < 2; i++) await p.key('up');
  for (let i = 0; i < 'us-east-1/evil'.length; i++) await p.key('backspace');
  await type(p, 'eu-west-1'); await p.key('down'); await p.key('down'); await p.key('enter');
  expect(sent.find(b => b.kind === 'keys.add')).toMatchObject({ provider: 'bedrock', endpoint: 'https://bedrock-runtime.eu-west-1.amazonaws.com', deployments: ['us.anthropic.claude-sonnet-5-v1:0'] });
});

it('Ollama: no key field, a local endpoint prefilled; any other URL is refused', async () => {
  const { p, sent } = panel('login');
  await choose(p, 'Ollama');
  expect(p.lines().slice(0, 4)).toEqual(['Add Ollama · this Mac, no key', 'requests go to this machine only', '› label: Ollama', '  endpoint: http://127.0.0.1:11434']);
  await p.key('enter'); for (let i = 0; i < 6; i++) await p.key('backspace'); await type(p, ':80'); await p.key('enter');
  // http://127.0.0.1:80 is still local; the request carries no secret at all.
  const added = sent.find(b => b.kind === 'keys.add');
  expect(added).toEqual({ kind: 'keys.add', provider: 'ollama', label: 'Ollama', endpoint: 'http://127.0.0.1:80' });
  const { p: q, sent: none } = panel('login');
  await choose(q, 'Ollama'); await q.key('enter'); for (let i = 0; i < 22; i++) await q.key('backspace'); await type(q, 'http://localhost:11434'); await q.key('enter');
  expect(none.filter(b => b.kind === 'keys.add')).toEqual([]); expect(q.lines().join('\n')).toContain('Ollama must be at http://127.0.0.1:<port>');
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

it('an Ollama agent\'s card and start box say "local · no key", never an empty key suffix', async () => {
  const { cardText } = await import('../src/client/tui/agent-card.js');
  const { presetAuthLabel } = await import('../src/client/tui/presets.js');
  const now = new Date().toISOString(), keyId = randomUUID();
  const session = { id: randomUUID(), title: 'local', engine: 'ai-term' as const, model: 'qwen3:8b', auth: { kind: 'key' as const, keyId, provider: 'ollama' as const, keyLabel: 'Ollama', last4: '' }, authMethod: 'api-key' as const, cwd: '/tmp', permission: 'ask' as const, status: 'done' as const, statusDetail: 'done', statusSince: now, createdAt: now, lastOutputAt: null, exitCode: null, ctxPercent: null, lastActivity: null };
  expect(cardText(session, Date.now(), 60).line3).toContain('local · no key'); expect(cardText(session, Date.now(), 60).line3).not.toContain('····');
  expect(presetAuthLabel({ auth: { kind: 'key', keyId } } as unknown as Parameters<typeof presetAuthLabel>[0], [{ id: keyId, provider: 'ollama', label: 'Ollama', last4: '', endpoint: 'http://127.0.0.1:11434' }])).toBe('local · no key');
});

// Part A in /login: every provider's region in one neutral line, LM Studio like Ollama, and a custom endpoint that needs
// the word add typed before its key goes anywhere.
it('Part A: moving through the list shows the highlighted provider\'s region', async () => {
  const { p } = panel('login');
  const at = async (label: string) => { while (!p.lines().includes(`› ${label}`)) await p.key('down'); return p.lines().find(line => line.startsWith('requests go to')); };
  expect(await at('Moonshot · China')).toBe('requests go to Moonshot\'s China platform (topping up needs Chinese real-name verification)');
  expect(await at('Qwen (Alibaba Model Studio) · international')).toBe('requests go to Alibaba Cloud\'s Singapore region');
  expect(await at('LM Studio')).toBe('requests go to this machine only');
});

it('Part A: LM Studio has no key field and its own local port prefilled', async () => {
  const { p, sent } = panel('login');
  await choose(p, 'LM Studio');
  expect(p.lines().slice(0, 4)).toEqual(['Add LM Studio · this Mac, no key', 'requests go to this machine only', '› label: LM Studio', '  endpoint: http://127.0.0.1:1234']);
  await p.key('enter'); await p.key('enter');
  expect(sent.find(b => b.kind === 'keys.add')).toEqual({ kind: 'keys.add', provider: 'lmstudio', label: 'LM Studio', endpoint: 'http://127.0.0.1:1234' });
});

it('Part A: a custom endpoint must be public https, and nothing is sent until add is typed', async () => {
  const { p, sent } = panel('login');
  await choose(p, 'Custom OpenAI-compatible endpoint');
  expect(p.lines().slice(0, 7)).toEqual(['Add API key · Custom OpenAI-compatible endpoint', 'requests and this key go to the https host you enter · type add to confirm', '› label: Custom OpenAI-compatible endpoint', '  endpoint: ', '  secret: ', '  models: ', '  type add: ']);
  await p.key('enter'); await type(p, 'https://10.0.0.7/v1'); await p.key('enter'); await type(p, KEY); await p.key('enter'); await type(p, 'm1'); await p.key('enter'); await p.key('enter');
  expect(sent.filter(b => b.kind === 'keys.add')).toEqual([]); expect(p.lines().join('\n')).toContain('The endpoint must be https on the public internet');
  for (let i = 0; i < 3; i++) await p.key('up');
  for (let i = 0; i < 'https://10.0.0.7/v1'.length; i++) await p.key('backspace');
  await type(p, 'https://llm.example.com/v1');
  expect(p.lines()[1]).toBe('requests and this key go to llm.example.com, a host AI Term doesn\'t know · type add to confirm');
  // One ⏎ after another on the last field without add never sends the key.
  for (let i = 0; i < 3; i++) await p.key('down');
  await p.key('enter'); await type(p, 'ad'); await p.key('enter');
  expect(sent.filter(b => b.kind === 'keys.add')).toEqual([]); expect(p.lines().join('\n')).toContain('Type add to send this key to that endpoint');
  await type(p, 'd'); await p.key('enter');
  expect(sent.find(b => b.kind === 'keys.add')).toEqual({ kind: 'keys.add', provider: 'custom', label: 'Custom OpenAI-compatible endpoint', secret: KEY, endpoint: 'https://llm.example.com/v1', deployments: ['m1'], confirm: 'add' });
  expect(p.lines().join('\n')).not.toContain(KEY);
});
