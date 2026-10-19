import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CredentialsPanel } from '../src/client/tui/credentials.js';
import { CapsForm } from '../src/client/tui/usage-forms.js';
import { cardText } from '../src/client/tui/agent-card.js';
import { frameBar } from '../src/client/tui/frame-bar.js';
import { createTheme } from '../src/client/tui/theme.js';
import type { KeyView, SessionInfo, Settings } from '../src/shared/protocol.js';

// v0.4.2 client side: caps defaults, the context warning switch (D55), "this deployment is model X" picked from the
// catalog only, the card's 85% line and context % on the bar.
const foundry: KeyView = { id: randomUUID(), provider: 'foundry', label: 'work', last4: 'WXYZ', endpoint: 'https://example-resource.openai.azure.com/openai/v1', deployments: ['gpt-6.1-sol', 'my-kimi'] };
function panel(start: Settings = { theme: 'graphite' }) {
  let settings = start; const caps = vi.fn(), patches: unknown[] = [];
  const instance = new CredentialsPanel('settings', { request: async body => { if (body.kind === 'settings.set') { patches.push(body.patch); settings = { ...settings, ...body.patch }; } return { id: randomUUID(), ok: true, settings, keys: [foundry] }; }, changed() {}, close() {}, login: async () => {}, defaults() {}, theme: async () => {}, caps });
  return { instance, caps, patches, settings: () => settings };
}

it('/settings shows the caps and the context warning; c opens the caps form, k toggles the warning', async () => {
  const p = panel(); await p.instance.load();
  const text = p.instance.lines().join('\n');
  expect(text).toContain('agent caps: 100 turns · $5.00 per run (c)'); expect(text).toContain('context warning at 85%: on (k)');
  await p.instance.key('c'); expect(p.caps).toHaveBeenCalledWith(undefined);
  await p.instance.key('k'); expect(p.settings().contextWarning).toBe(false); expect(p.instance.lines().join('\n')).toContain('context warning at 85%: off (k)');
});

it('m on a Foundry key marks a deployment as a catalog model: typing only narrows the list, (not set) clears it', async () => {
  const p = panel(); await p.instance.load();
  await p.instance.key('m');
  expect(p.instance.lines().join('\n')).toContain('my-kimi · model not set');
  await p.instance.key('down'); await p.instance.key('enter');
  for (const char of 'not-a-real-model') await p.instance.key(char);
  // Typed text that matches nothing leaves only "(not set)": it can never become a model name.
  expect(p.instance.lines().filter(line => line.startsWith('›'))).toEqual(['› (not set)']);
  for (let i = 0; i < 16; i++) await p.instance.key('backspace');
  for (const char of 'kimi-k2.6') await p.instance.key(char);
  await p.instance.key('down'); await p.instance.key('enter');
  expect(p.settings().deploymentModels).toEqual({ 'my-kimi': 'kimi-k2.6' });
  await p.instance.key('m'); await p.instance.key('down'); await p.instance.key('enter'); await p.instance.key('enter');
  expect(p.settings().deploymentModels).toEqual({});
});

it('the caps form accepts whole turns and USD, empty for no cap, and refuses zero or junk', () => {
  const form = new CapsForm({ turns: 100, spendUsd: 5 });
  expect(form.values()).toEqual({ turns: 100, spendUsd: 5 });
  for (let i = 0; i < 3; i++) form.key('backspace'); form.key('4'); form.key('0'); form.key('down'); form.key('backspace');
  expect(form.values()).toEqual({ turns: 40, spendUsd: null });
  form.key('up'); for (let i = 0; i < 2; i++) form.key('backspace'); form.key('0');
  expect(() => form.values()).toThrow('a whole number above 0');
});

const now = new Date().toISOString();
const session = (engine: SessionInfo['engine'], ctxPercent: number | null, status: SessionInfo['status'] = 'running'): SessionInfo => ({ id: randomUUID(), title: 'a', engine, model: 'm', auth: { kind: 'account' }, cwd: '/tmp', permission: 'ask', status, statusDetail: status === 'waiting' ? 'permission' : status, statusSince: now, createdAt: now, lastOutputAt: now, exitCode: null, ctxPercent, lastActivity: null });

it('a card at 85% context says so (per engine), not when off, and never over a waiting agent', () => {
  expect(cardText(session('ai-term', 86), Date.now(), 60).activity).toEqual({ text: 'context 86% · /compact or /clear', color: 'status-waiting' });
  expect(cardText(session('claude-code', 90, 'done'), Date.now(), 60).activity?.text).toBe('context 90% · /compact or start fresh');
  expect(cardText(session('codex', 84), Date.now(), 60).activity?.text ?? '').not.toContain('context');
  expect(cardText(session('ai-term', 95), Date.now(), 60, { contextWarning: false }).activity?.text ?? '').not.toContain('context');
  expect(cardText(session('ai-term', 95, 'waiting'), Date.now(), 60).activity?.text).toBe('asks: permission');
});

it('the bar shows context %, dropping it before the model when narrow', () => {
  const plain = (cols: number, s: SessionInfo) => frameBar(cols, s, [], createTheme('graphite'))[0]?.map(c => c.char).join('') ?? '';
  expect(plain(120, session('ai-term', 42))).toContain('ai-term · m · ctx 42%');
  expect(plain(120, session('ai-term', null))).not.toContain('ctx');
  const narrow = plain(40, session('ai-term', 42));
  expect(narrow).not.toContain('ctx'); expect(narrow).toContain('running');
});
