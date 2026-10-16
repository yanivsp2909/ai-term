import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AddonFlow } from '../src/client/tui/addon-flow.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SuccessResponse } from '../src/shared/protocol.js';
import type { AddonTarget } from '../src/shared/addons.js';
const targets: AddonTarget[] = [{ engine: 'claude-code', model: null, auth: { kind: 'account' } }, { engine: 'claude-code', model: 'opus', auth: { kind: 'account' } }, { engine: 'codex', model: null, auth: { kind: 'account' } }];
it('engine/model changes refresh the receipt, b builds only the free brain first, and a prompt diff copies through a stub', async () => {
  const sent: RequestBody[] = [], copied: string[] = [], id = randomUUID(), now = new Date().toISOString();
  const request = async (body: RequestBody): Promise<SuccessResponse> => {
    sent.push(body); const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'addons.plan') response.addonAsk = { receipt: randomUUID(), name: 'prompt', summary: 'Audit', cwd: '/tmp', target: body.target, brain: 'none', brainNeed: 'recommended', readOnly: true, worktree: false, files: [], inputTokens: { low: 10, high: 20000 }, outputTokens: { low: 50, high: 1000 }, priceUsd: { low: 0, high: 0 }, subscription: true };
    if (body.kind === 'brain.plan') response.brainPlan = { repo: '/tmp', files: 1, changed: 1, removed: 0, skipped: { binary: 0, large: 0, secret: 0, env: 0 }, builtAt: null, summarize: 0, inputTokens: { low: 0, high: 0 }, outputTokens: { low: 0, high: 0 }, models: [], selected: 0, fingerprint: 'a'.repeat(64), agents: false };
    if (body.kind === 'addons.start') response.session = { id, engine: 'codex', title: 'Prompt', model: null, auth: { kind: 'account' }, cwd: '/tmp', permission: 'ask', status: 'done', statusDetail: 'done', statusSince: now, createdAt: now, exitCode: null, lastOutputAt: null, ctxPercent: null };
    if (body.kind === 'addons.result') response.addonResult = { kind: 'prompt', issues: ['Checkpoint missing'], diff: '--- original\n+++ improved\n@@ -1 +1 @@\n-build\n+Build and stop.' };
    return response;
  };
  const flow = new AddonFlow('prompt', 'Build', '/tmp', targets, { request, started: async () => {}, changed: () => {}, close: () => {}, copy: async s => { copied.push(s); } });
  try {
    await flow.open(); flow.panel.key('m'); await vi.waitFor(() => expect(flow.panel.lines.join('\n')).toContain('opus'));
    flow.panel.key('e'); await vi.waitFor(() => expect(flow.panel.lines.join('\n')).toContain('codex'));
    flow.panel.key('b'); await vi.waitFor(() => expect(sent.some(s => s.kind === 'brain.build')).toBe(true));
    expect(sent.find(s => s.kind === 'brain.build')).toEqual({ kind: 'brain.build', cwd: '/tmp', fingerprint: 'a'.repeat(64) });
    await vi.waitFor(() => expect(flow.panel.lines.join('\n')).toContain('y starts')); flow.panel.key('y');
    await vi.waitFor(() => expect(flow.panel.lines.join('\n')).toContain('c copies')); flow.panel.key('c');
    await vi.waitFor(() => expect(copied).toHaveLength(1)); expect(copied[0]).toContain('+++ improved');
  } finally { flow.dispose(); }
});
