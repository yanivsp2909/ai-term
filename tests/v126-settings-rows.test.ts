import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CredentialsPanel } from '../src/client/tui/credentials.js';
import { buildAgentArgs } from '../src/daemon/env.js';
import { parseAgentArgs } from '../src/agent/main.js';
import type { RequestBody } from '../src/client/connection.js';
import type { Settings, SuccessResponse } from '../src/shared/protocol.js';

// v1.2.6: /settings names the theme with its variant and has an app fonts row (F); AI Term's own agent draws its screen
// in the saved variant too.
function panel(settings: Partial<Settings>) {
  const requests: RequestBody[] = []; let saved: Settings = { theme: 'graphite', ...settings };
  const p = new CredentialsPanel('settings', { request: async body => { requests.push(body); const r: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.get') r.settings = saved;
    if (body.kind === 'settings.set') { saved = { ...saved, ...body.patch }; r.settings = saved; }
    if (body.kind === 'keys.list') r.keys = [];
    return r; }, changed: () => {}, close: () => {}, login: async () => {}, defaults: () => {}, theme: async () => {} });
  return { p, requests, text: () => p.lines().join('\n') };
}

it('the theme row names the theme and its variant; the app fonts row opens its form with F and saves through settings', async () => {
  const { p, requests, text } = panel({ theme: 'slate', themeVariant: 'light', appFonts: { terminal: 'Fira Code', terminalSize: 15 } });
  await p.load();
  expect(text()).toContain('theme: slate · light · ⇥ change · /theme previews');
  expect(text()).toContain('app fonts: terminal Fira Code 15 · chrome default 13 · ligatures off · the AI Term app only (F)');
  await p.key('F');
  expect(text()).toContain('App fonts · the AI Term app only; a terminal keeps its own font');
  await p.key('down'); await p.key('right');
  await p.key('enter');
  expect(requests.filter(r => r.kind === 'settings.set').map(r => r.kind === 'settings.set' ? r.patch : null)).toEqual([{ appFonts: { terminal: 'Fira Code', terminalSize: 16, chromeSize: 13, ligatures: false } }]);
  expect(text()).toContain('app fonts: terminal Fira Code 16');
  // Esc in the form goes back to /settings; it doesn't close the popup.
  await p.key('F'); await p.key('escape');
  expect(text()).toContain('app fonts: terminal Fira Code 16');
});

it('AI Term agent: the light variant reaches its screen as one argv element; dark adds nothing', () => {
  const command = { node: '/usr/local/bin/node', entry: '/opt/ai-term/dist/cli/index.js' };
  const base = { command, provider: 'foundry' as const, model: 'gpt-6.1-sol', models: ['gpt-6.1-sol'], permission: 'ask' as const, theme: 'dune', transcript: '/home/u/.ai-term/sessions/x/transcript.jsonl' };
  const light = buildAgentArgs({ ...base, themeVariant: 'light' }).args, dark = buildAgentArgs({ ...base, themeVariant: 'dark' }).args;
  expect(light).toContain('--theme=dune'); expect(light).toContain('--theme-variant=light');
  expect(dark.some(a => a.startsWith('--theme-variant'))).toBe(false);
  expect(() => buildAgentArgs({ ...base, themeVariant: 'system' as never })).toThrow('Invalid agent arguments');
  expect(parseAgentArgs(light.slice(2))).toMatchObject({ theme: 'dune', themeVariant: 'light' });
  expect(parseAgentArgs(dark.slice(2))).toMatchObject({ theme: 'dune', themeVariant: 'dark' });
});
