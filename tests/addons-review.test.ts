import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AddonService } from '../src/daemon/addons.js';
import { extractAddonResult } from '../src/shared/addons.js';
import type { CreateSession, SessionInfo } from '../src/shared/protocol.js';
import { AddonPanel } from '../src/client/tui/addon-panel.js';
import { Grid } from '../src/client/tui/grid.js';
import { createTheme } from '../src/client/tui/theme.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ai-addon-review-')); roots.push(root);
  const home = join(root, 'home'), repo = join(root, 'repo'); await mkdir(home); await mkdir(repo);
  const messages: string[] = [];
  const runner = { create: async (request: Exclude<CreateSession, { engine: 'shell' }>) => { messages.push(request.firstMessage ?? ''); return { id: randomUUID() } as SessionInfo; }, text: async (id: string) => ({ sessionId: id, text: '', truncated: false }), brainPlan: async () => null };
  const service = new AddonService(home, new URL('../addons/', import.meta.url).pathname, runner);
  const plan = (args = 'Audit this prompt') => service.plan('prompt', args, repo, { engine: 'codex', model: null, auth: { kind: 'account' } });
  return { root, home, repo, messages, service, plan };
}
it('HIGH review: entropy-only secrets detected by the scan never reach the first message', async () => {
  const f = await setup(), value = 'q7Lm2Pz9Vx4Nb8Kd5Rs3Ht6Wf1Ya0Cu';
  const ask = await f.plan(`opaque = "${value}"\nBuild one feature.`); await f.service.start(ask.receipt);
  expect(f.messages[0]).not.toContain(value); expect(f.messages[0]).toContain('secret detected');
});
it('MEDIUM review: echoed result instructions remain pending until a valid answer arrives', () => {
  const nonce = 'a'.repeat(32), echo = `RESULT_${nonce}_BEGIN\n(the JSON result goes here)\nRESULT_${nonce}_END`;
  expect(extractAddonResult(echo, nonce, 'prompt')).toBeNull();
  const answer = `RESULT_${nonce}_BEGIN\n${JSON.stringify({ kind: 'prompt', issues: [], diff: '--- original\n+++ improved\n@@ -1 +1 @@\n-a\n+b' })}\nRESULT_${nonce}_END`;
  expect(extractAddonResult(echo + '\n' + answer, nonce, 'prompt')?.kind).toBe('prompt');
});
it.each(['instructions', 'plugin', 'extra'])('security review: immutable bundles refuse changed %s metadata or unapproved files', async kind => {
  const f = await setup(), ask = await f.plan(); await f.service.start(ask.receipt);
  const bundle = f.messages[0]?.match(/"([^"\n]+\/addons\/[a-f0-9]{64})\/[^"\n]+"/)?.[1]; if (!bundle) throw new Error('No bundle');
  if (kind === 'instructions') await writeFile(join(bundle, 'instructions.json'), JSON.stringify([]));
  else if (kind === 'plugin') await writeFile(join(bundle, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'unapproved-plugin' }));
  else { await mkdir(join(bundle, 'hooks')); await writeFile(join(bundle, 'hooks/hooks.json'), JSON.stringify({ hooks: {} })); }
  const next = await f.plan(); await expect(f.service.start(next.receipt)).rejects.toThrow('bundle');
  expect(f.messages).toHaveLength(1);
});
it('MEDIUM review: template replacement keeps literal variables in submitted prompt data', async () => {
  const f = await setup(), literal = 'Keep {{brainIndex}} and {{args}} literally.';
  const ask = await f.plan(literal); await f.service.start(ask.receipt); expect(f.messages[0]).toContain(literal);
});
it('MEDIUM review: every selected plan step and approval hint remain visible, and long steps can page', () => {
  const panel = new AddonPanel(() => {}, () => {}, { start: () => {}, build: () => {}, approve: () => {}, step: () => {}, copy: () => {}, choose: () => {} });
  panel.setResult({ kind: 'plan', title: 'Twenty-four steps', steps: Array.from({ length: 24 }, (_, i) => ({ title: `Step ${i + 1}`, prompt: Array.from({ length: 30 }, (_, n) => `Detail ${n + 1}: inspect and test.`).join('\n') })) });
  const theme = createTheme('graphite'), draw = () => panel.draw(new Grid(100, 24, theme).cells, theme).map(r => r.map(c => c.char).join('')).join('\n');
  const first = draw(); panel.key('page-down'); expect(draw()).not.toBe(first);
  for (let n = 0; n < 23; n++) panel.key('down');
  expect(draw()).toContain('Step 24'); expect(draw()).toContain('a approves');
});
it('MEDIUM review: every pilot result shows actual reported usage, separately from the estimate', () => {
  const panel = new AddonPanel(() => {}, () => {}, { start: () => {}, build: () => {}, approve: () => {}, step: () => {}, copy: () => {}, choose: () => {} });
  panel.setResult({ kind: 'prompt', issues: [], diff: '--- original\n+++ improved\n@@ -1 +1 @@\n-a\n+b' });
  panel.setUsage({ tokens: 1234, costUsd: 0.023 }); expect(panel.lines.join('\n')).toContain('actual: 1234 tokens · $0.0230');
});
