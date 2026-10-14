import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CredentialsPanel } from '../src/client/tui/credentials.js';
import { cardText } from '../src/client/tui/agent-card.js';
import { drawAgentBox } from '../src/client/tui/agent-box.js';
import { renderHomepage } from '../src/client/tui/layout.js';
import { Grid, plainText } from '../src/client/tui/grid.js';
import { createTheme } from '../src/client/tui/theme.js';
import type { SessionInfo, Settings } from '../src/shared/protocol.js';

// D51: the engine is plain text ("ai term"), with a letter badge like the others; D47's fallback is one settings row.
const now = new Date().toISOString(), theme = createTheme('graphite');
const agent: SessionInfo = { id: randomUUID(), title: 'fix readme', engine: 'ai-term', model: 'gpt-6.1-sol', auth: { kind: 'key', keyId: randomUUID(), provider: 'foundry', keyLabel: 'narvis', last4: 'ITid' }, authMethod: 'api-key', cwd: '/tmp', permission: 'ask', status: 'waiting', statusDetail: 'permission', statusSince: now, createdAt: now, lastOutputAt: null, exitCode: null, ctxPercent: null, lastActivity: { tool: 'bash', at: now } };

it('cards and the start box name the engine "ai term"; the badge follows the model family', () => {
  expect(cardText(agent, Date.now(), 60)).toMatchObject({ model: 'gpt-6.1-sol · ai term', line3: 'asks: permission · API key ····ITid' });
  const text = plainText(renderHomepage({ cols: 130, rows: 45, sessions: [agent], selectedId: agent.id, input: '', note: '', previewVisible: true, cwd: '/tmp', now: 0, engine: 'ai-term', model: 'gpt-6.1-sol', authLabel: 'key ····ITid' }, theme));
  expect(text).toContain(' GP '); const families = plainText(renderHomepage({ cols: 130, rows: 45, sessions: [{ ...agent, model: 'kimi-k3' }, { ...agent, id: randomUUID(), model: 'mystery' }], selectedId: agent.id, input: '', note: '', previewVisible: true, cwd: '/tmp', now: 0 }, theme)); expect(families).toContain(' KI '); expect(families).toContain(' AT '); expect(text.split('\n').at(-1)).toContain('gpt-6.1-sol · ai term');
  const box = plainText(drawAgentBox(new Grid(130, 45, theme).cells, { kind: 'start', engine: 'ai-term', model: 'gpt-6.1-sol', cwd: '/tmp', permission: 'ask', message: 'fix it', error: '', checking: false, row: 0, filter: '', choices: [], choice: 0, path: '', completions: [], authLabel: 'key ····ITid' }, theme));
  expect(box).toContain('gpt-6.1-sol · ai term · key ····ITid');
});

it('/settings shows where keys run and r toggles it; Enter on the row does the same', async () => {
  let settings: Settings = { theme: 'graphite' };
  const panel = new CredentialsPanel('settings', { request: async body => { if (body.kind === 'settings.set') settings = { ...settings, ...body.patch }; return { id: randomUUID(), ok: true, settings }; }, changed() {}, close() {}, login: async () => {}, defaults() {}, theme: async () => {} });
  await panel.load(); expect(panel.lines().join('\n')).toContain('keys run on: ai term (r)');
  await panel.key('r'); expect(settings.keysRunOn).toBe('cli'); expect(panel.lines().join('\n')).toContain('keys run on: the cli (r)');
  for (let i = 0; i < 11; i++) await panel.key('down');
  await panel.key('enter'); expect(settings.keysRunOn).toBe('ai-term');
});
