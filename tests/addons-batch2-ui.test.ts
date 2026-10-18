import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import headless from '@xterm/headless';
import { AddonPanel } from '../src/client/tui/addon-panel.js';
import { AddonFlow } from '../src/client/tui/addon-flow.js';
import { Homepage } from '../src/client/tui/homepage.js';
import { commandRegistry, helpLines } from '../src/client/tui/commands.js';
import { parseAddonResult } from '../src/shared/addon-results.js';
import type { AddonAsk } from '../src/shared/addons.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SessionInfo, SuccessResponse } from '../src/shared/protocol.js';
import { batch2 } from './fixtures/addon-results.js';

// v1.1 batch 2 in the one add-on popup.
const panel = () => {
  const actions = { start: vi.fn(), build: vi.fn(), approve: vi.fn(), step: vi.fn(), copy: vi.fn(), choose: vi.fn(), apply: vi.fn(), ab: vi.fn(), commit: vi.fn(), polish: vi.fn(), file: vi.fn() };
  return { actions, panel: new AddonPanel(() => {}, () => {}, actions) };
};
const kept = (name: string) => parseAddonResult(JSON.stringify(['pr-review', 'context', 'opensource'].includes(name) ? { ...batch2[name], dropped: 0 } : batch2[name]), name, true);
const ask = (over: Partial<AddonAsk>): AddonAsk => ({ receipt: randomUUID(), name: 'commit', summary: 'Commit message', cwd: '/tmp/repo', target: { engine: 'claude-code', model: null, auth: { kind: 'account' } }, brain: 'none', brainNeed: 'none', worktree: false, readOnly: true, files: [], inputTokens: { low: 1, high: 2 }, outputTokens: { low: 1, high: 2 }, priceUsd: { low: 0, high: 0 }, subscription: true, ...over });

it('AI Term\'s own facts show in the ask and above the result', () => {
  const { panel: p } = panel(); p.setAsk(ask({ name: 'opensource', facts: ['history: 1 secret-bearing line in 1 commit (masked)', 'LICENSE: missing'] }));
  expect(p.lines.join('\n')).toContain('LICENSE: missing');
  p.setResult(kept('opensource')); expect(p.lines.join('\n')).toContain('history: 1 secret-bearing line in 1 commit (masked)');
});

it('/commit: c copies the message; y commits only when it ran in an agent\'s worktree', () => {
  const { panel: p, actions } = panel(); p.setAsk(ask({ subject: 'agent: fixer (y commits there)', commits: true })); p.setResult(kept('commit'));
  expect(p.lines.join('\n')).toContain('fix(parser): refuse empty input');
  p.key('c'); expect(actions.copy).toHaveBeenCalledWith('fix(parser): refuse empty input\n\nEmpty input read past the end of the buffer.');
  p.key('y'); expect(actions.commit).toHaveBeenCalledOnce();
  const checkout = panel(); checkout.panel.setAsk(ask({})); checkout.panel.setResult(kept('commit'));
  expect(checkout.panel.lines.join('\n')).toContain('c copies it · AI Term never commits in your checkout');
  checkout.panel.key('y'); expect(checkout.actions.commit).not.toHaveBeenCalled();
});

it('/changelog c copies and w writes it in a worktree; /pr-review c copies the review; /standup m polishes', () => {
  const log = panel(); log.panel.setAsk(ask({ name: 'changelog' })); log.panel.setResult(kept('changelog'));
  log.panel.key('c'); expect(log.actions.copy).toHaveBeenCalledWith(String(batch2.changelog?.section)); log.panel.key('w'); expect(log.actions.apply).toHaveBeenCalledWith([0]);
  const review = panel(); review.panel.setAsk(ask({ name: 'pr-review' })); review.panel.setResult(kept('pr-review'));
  review.panel.key('c'); expect(review.actions.copy).toHaveBeenCalledWith(expect.stringContaining('HIGH src/a.ts:3 Null is not handled'));
  const standup = panel(); standup.panel.setAsk(ask({ name: 'standup', target: null, free: true }));
  standup.panel.setResult({ kind: 'standup', lines: ['fixer · done · 1 commit today'] });
  expect(standup.panel.lines.join('\n')).toContain('no model · no tokens'); standup.panel.key('m'); expect(standup.actions.polish).toHaveBeenCalledWith('fixer · done · 1 commit today');
});

it('/opensource f starts one fix of every finding that has one; /context lists its findings', () => {
  const { panel: p, actions } = panel(); p.setAsk(ask({ name: 'opensource' })); p.setResult(kept('opensource'));
  p.key('f'); expect(actions.apply).toHaveBeenCalledWith([1]);
  const ctx = panel(); ctx.panel.setAsk(ask({ name: 'context' })); ctx.panel.setResult(kept('context'));
  expect(ctx.panel.lines.join('\n')).toContain('● MEDIUM AGENTS.md:12 Contradicts CLAUDE.md:4');
});

it('/issue says how to publish when it is done, and shows the sandboxed test result', () => {
  const { panel: p } = panel(); p.setAsk(ask({ name: 'issue', subject: 'issue #12 · OPEN' })); p.setResult(kept('issue')); p.setTests({ state: 'pass' });
  const text = p.lines.join('\n');
  expect(text).toContain('Empty titles are refused now'); expect(text).toContain('✓ tests pass'); expect(text).toContain('/pr <agent> opens a pull request when you\'re ready');
});

it('/standup asks for nothing: the flow starts it at once and shows the result', async () => {
  const sent: RequestBody[] = [], run = randomUUID();
  const request = async (body: RequestBody): Promise<SuccessResponse> => {
    sent.push(body); const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'addons.plan') response.addonAsk = ask({ name: 'standup', target: null, free: true });
    if (body.kind === 'addons.start') response.addonRun = run;
    if (body.kind === 'addons.result') response.addonResult = { kind: 'standup', lines: ['fixer · done'] };
    return response;
  };
  const flow = new AddonFlow('standup', '', '/tmp', [], { request, started: async () => {}, changed: () => {}, close: () => {} }, true);
  try { await flow.open(); await vi.waitFor(() => expect(flow.panel.lines.join('\n')).toContain('fixer · done'), { timeout: 10_000 }); expect(sent.map(s => s.kind)).toEqual(['addons.plan', 'addons.start', 'addons.result']); }
  finally { flow.dispose(); }
});

it('every batch-2 command is in the menu, /help, the README and the user guide', async () => {
  const names = ['/issue', '/pr-review', '/deps', '/commit', '/changelog', '/docs', '/handover', '/standup', '/adr', '/context', '/opensource'];
  for (const name of names) expect(commandRegistry.map(c => c.name), name).toContain(name);
  const context = { engine: 'claude-code' as const, model: null, cwd: '/tmp', theme: 'graphite' as const };
  const help = helpLines(context).join('\n'), readme = await readFile(new URL('../README.md', import.meta.url), 'utf8'), guide = await readFile(new URL('../docs/user-guide.md', import.meta.url), 'utf8');
  for (const name of names) { expect(readme, name).toContain(name); expect(guide, name).toContain(name); }
  for (const keys of ['/commit c / y', '/changelog c / w', '/pr-review c', '/standup m', '/opensource f']) { expect(help, keys).toContain(keys); expect(readme, keys).toContain(keys); }
});

class TTY extends EventEmitter { isTTY = true; columns = 130; rows = 45; output = ''; setRawMode() {} resume() {} pause() {} write(s: string | Buffer) { this.output += String(s); return true; } }
async function screen(tty: TTY) { const term = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true }); try { await new Promise<void>(r => term.write(tty.output, r)); return Array.from({ length: 45 }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n'); } finally { term.dispose(); } }
it('the homepage routes each batch-2 command with its argument; /commit names the selected agent, /standup sends no target', async () => {
  const requests: RequestBody[] = [], id = randomUUID(), now = new Date().toISOString();
  const agent: SessionInfo = { id, title: 'fixer', engine: 'claude-code', model: null, auth: { kind: 'account' }, cwd: '/tmp', permission: 'ask', status: 'done', statusDetail: 'ready', statusSince: now, exitCode: null, createdAt: now, lastOutputAt: null, ctxPercent: null, lastActivity: null };
  const client = Object.assign(new EventEmitter(), { async request(body: RequestBody): Promise<SuccessResponse> {
    requests.push(body); const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.get') response.settings = { theme: 'graphite' }; if (body.kind === 'sessions.list') response.sessions = [agent]; if (body.kind === 'keys.list') response.keys = [];
    if (body.kind === 'sessions.preview') { response.snapshot = ''; response.cols = 85; response.rows = 30; }
    if (body.kind === 'addons.plan') throw new Error('estimate stub');
    return response;
  } });
  const tty = new TTY(), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', terminalProgram: 'unknown' }); await home.start();
  const plans = () => requests.filter((r): r is Extract<RequestBody, { kind: 'addons.plan' }> => r.kind === 'addons.plan');
  try {
    for (const [typed, name, args] of [['/issue #12', 'issue', '#12'], ['/pr-review 3', 'pr-review', '3'], ['/deps', 'deps', ''], ['/commit fixer', 'commit', id], ['/changelog v1..HEAD', 'changelog', 'v1..HEAD'], ['/standup', 'standup', ''], ['/opensource', 'opensource', '']] as const) {
      tty.emit('data', Buffer.from(`${typed}\r`));
      await vi.waitFor(() => expect(plans().at(-1)).toMatchObject({ name, args }), { timeout: 10_000 });
      if (name === 'standup') expect(plans().at(-1)?.target).toBeNull();
      tty.emit('data', Buffer.from('\x1b')); await vi.waitFor(async () => expect(await screen(tty)).not.toContain('estimate stub'), { timeout: 10_000 });
    }
  } finally { await home.stop(); }
});
