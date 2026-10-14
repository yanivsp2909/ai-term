import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { Agent } from '../src/agent/agent.js';
import { AgentApp } from '../src/agent/app.js';
import { Screen } from '../src/agent/screen.js';
import { Transcript } from '../src/agent/transcript.js';
import { createTheme } from '../src/client/tui/theme.js';
import { parseAgentStatus } from '../src/daemon/agent-status.js';
import type { AgentStatus } from '../src/agent/report.js';
import type { ExtensionAccess } from '../src/shared/extensions.js';
import { stubFacts } from './fixtures/agent-facts.js';

// v0.4 gate (D50, S22): /send must never type into the agent's own popup, where its Enter could save and authorize an MCP
// server. While a popup is open the agent reports a question, so the daemon refuses /send; closing it reports done again.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('an open /skills or /mcp popup reports waiting, so /send is refused; closing it reports done with the last reply', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-gate-popup-'))); roots.push(root);
  const statuses: AgentStatus[] = [], model = new MockLanguageModelV4({ doStream: [] });
  const reporter = { status: async (s: AgentStatus) => { statuses.push(s); }, usage: async () => true, facts: async () => stubFacts() };
  const extensions: ExtensionAccess = { list: async () => ({ items: [], notes: [], tokens: 0 }), read: async () => { throw new Error('unused'); }, toggle: async () => ({ items: [], notes: [], tokens: 0 }) };
  let out = '';
  const app = new AgentApp({
    screen: new Screen({ write: t => { out += t; }, columns: 100, rows: 30 }, createTheme('graphite')), permission: 'ask', models: ['m1'], quit: vi.fn(), makeModel: async () => model,
    agent: io => new Agent({ root, permission: 'ask', model, modelId: 'm1', instructions: { text: '', files: [], notes: [] }, reporter, transcript: new Transcript(null, t => t, () => {}), io, redact: t => t, bashEnv: {}, rg: null, extensions }),
  });
  app.start();
  app.input('/skills\r');
  await vi.waitFor(() => expect(out).toContain('[Skills]'));
  expect(statuses.map(s => s.event)).toEqual(['paused']);
  expect(parseAgentStatus(statuses[0], 1, 'now')?.event).toMatchObject({ kind: 'waiting', reason: 'question' });
  app.input('\x1b');
  await vi.waitFor(() => expect(statuses.map(s => s.event)).toEqual(['paused', 'done']));
  expect(statuses[1]).toEqual({ event: 'done', reply: '' });
  app.close();
});
