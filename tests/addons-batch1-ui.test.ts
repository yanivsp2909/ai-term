import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import headless from '@xterm/headless';
import { AddonPanel } from '../src/client/tui/addon-panel.js';
import { AddonFlow } from '../src/client/tui/addon-flow.js';
import { Homepage } from '../src/client/tui/homepage.js';
import { commandRegistry, helpLines } from '../src/client/tui/commands.js';
import { AB_NO_SANDBOX, parseAddonResult } from '../src/shared/addon-results.js';
import type { AddonAsk } from '../src/shared/addons.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SessionInfo, SuccessResponse } from '../src/shared/protocol.js';
import { fixtures } from './fixtures/addon-results.js';

// v1.1 batch 1 in the one add-on popup: keys never start more than they say, and every status has a glyph and a word.
const panel = () => {
  const actions = { start: vi.fn(), build: vi.fn(), approve: vi.fn(), step: vi.fn(), copy: vi.fn(), choose: vi.fn(), apply: vi.fn(), ab: vi.fn() };
  return { actions, panel: new AddonPanel(() => {}, () => {}, actions) };
};
const result = (name: string) => parseAddonResult(JSON.stringify(name === 'security' || name === 'types' || name === 'failures' || name === 'review-deep' ? { ...fixtures[name], dropped: 0 } : fixtures[name]), name, true);
const ask = (over: Partial<AddonAsk>): AddonAsk => ({ receipt: randomUUID(), name: 'failures', summary: 'Hunt', cwd: '/tmp/repo', target: { engine: 'ai-term', model: 'm', auth: { kind: 'key', keyId: randomUUID() } }, brain: 'none', brainNeed: 'recommended', worktree: false, readOnly: true, files: [], inputTokens: { low: 1, high: 2 }, outputTokens: { low: 1, high: 2 }, priceUsd: { low: 0.01, high: 4.5 }, subscription: false, ...over });

it('/teach reveals one chunk per Space, then only offers the quiz: y starts it, n skips it, Space reveals each answer', () => {
  const { panel: p } = panel(); p.setResult(result('teach'));
  expect(p.lines.join('\n')).toContain('Example: src/a.ts');
  p.key('y'); expect(p.lines.join('\n')).not.toContain('Quiz 1/');
  p.key('space'); expect(p.lines.join('\n')).toContain('Quiz? 1 short scenario question'); expect(p.lines.join('\n')).not.toContain('You pass "" now');
  p.key('y'); expect(p.lines.join('\n')).toContain('You pass "" now'); expect(p.lines.join('\n')).not.toContain('It throws "empty".');
  p.key('space'); expect(p.lines.join('\n')).toContain('Answer: It throws "empty".');
  p.key('space'); expect(p.lines.join('\n')).toContain('✓ Quiz done');
  const { panel: skip } = panel(); skip.setResult(result('teach')); skip.key('space'); skip.key('n');
  expect(skip.lines.join('\n')).toContain('No quiz'); skip.key('y'); expect(skip.lines.join('\n')).not.toContain('Quiz 1/');
});

it('/refactor: Space picks, r starts only the picked items; /types f fixes the selected finding once', () => {
  const { panel: p, actions } = panel(); p.setResult(result('refactor'));
  p.key('r'); expect(actions.apply).not.toHaveBeenCalled();
  p.key('down'); p.key('space'); expect(p.lines.join('\n')).toContain('[x] Remove dead export'); expect(p.lines.join('\n')).toContain('[ ] Split parse()');
  p.key('r'); expect(actions.apply).toHaveBeenCalledWith([1]);
  const types = panel(); types.panel.setResult(result('types'));
  expect(types.panel.lines.join('\n')).toContain('✗ HIGH src/a.ts:3 status is a string');
  types.panel.key('f'); expect(types.actions.apply).toHaveBeenCalledWith([0]);
  types.panel.setApplied('✓ started /types fix'); types.panel.key('f'); expect(types.actions.apply).toHaveBeenCalledOnce();
});

it('/perf: a runs the A/B; Y works only after AI Term said there is no sandbox; the result shows both medians', () => {
  const { panel: p, actions } = panel(); p.setResult(result('perf'));
  p.key('Y'); expect(actions.ab).not.toHaveBeenCalled();
  p.key('a'); expect(actions.ab).toHaveBeenCalledWith(false);
  p.setAb({ state: 'failed', reason: AB_NO_SANDBOX }); p.key('a'); expect(actions.ab).toHaveBeenCalledOnce();
  p.key('Y'); expect(actions.ab).toHaveBeenLastCalledWith(true);
  p.setAb({ state: 'done', rounds: 5, beforeMs: 120, afterMs: 40, sandbox: true });
  expect(p.lines.join('\n')).toContain('✓ A/B · 5 runs each'); expect(p.lines.join('\n')).toContain('120 ms'); expect(p.lines.join('\n')).toContain('40 ms median · -67%');
});

it('/bisect asks with no model or price; without a sandbox only a capital Y starts it', () => {
  const bisect = { command: ['./check.sh'], good: 'a'.repeat(40), bad: 'b'.repeat(40), goodLabel: 'HEAD~32', commits: 32, sandbox: false };
  const { panel: p, actions } = panel(); p.setAsk(ask({ name: 'bisect', target: null, bisect, priceUsd: { low: 0, high: 0 } }));
  expect(p.lines.join('\n')).toContain('no model · no tokens · $0'); expect(p.lines.join('\n')).toContain('● no sandbox here');
  p.key('y'); p.key('enter'); expect(actions.start).not.toHaveBeenCalled();
  p.key('Y'); expect(actions.start).toHaveBeenCalledWith(true);
  const sandboxed = panel(); sandboxed.panel.setAsk(ask({ name: 'bisect', target: null, bisect: { ...bisect, sandbox: true }, priceUsd: { low: 0, high: 0 } }));
  sandboxed.panel.key('y'); expect(sandboxed.actions.start).toHaveBeenCalledWith(false);
});

it('/failures shows its worst-case price in dollars before anything else', () => {
  const { panel: p } = panel(); p.setAsk(ask({ cost: 'high' }));
  expect(p.lines[1]).toBe('● expensive: up to $4.50 at this model\'s price');
});

it('/security keeps the reproduction with each finding and says when one was dropped', () => {
  const { panel: p } = panel(); p.setResult(parseAddonResult(JSON.stringify({ ...fixtures.security, dropped: 1 }), 'security', true));
  const text = p.lines.join('\n');
  expect(text).toContain('Reproduction (this repository only):'); expect(text).toContain('1 finding dropped: the reproduction reached outside this repository');
});

it('a local add-on asks with no target and polls its run, not an agent', async () => {
  const sent: RequestBody[] = [], run = randomUUID(), started = vi.fn();
  const request = async (body: RequestBody): Promise<SuccessResponse> => {
    sent.push(body); const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'addons.plan') response.addonAsk = { ...ask({ name: 'bisect', target: null, priceUsd: { low: 0, high: 0 }, bisect: { command: ['./check.sh'], good: 'a'.repeat(40), bad: 'b'.repeat(40), goodLabel: 'HEAD~32', commits: 3, sandbox: true } }) };
    if (body.kind === 'addons.start') response.addonRun = run;
    if (body.kind === 'addons.result') response.addonResult = { kind: 'bisect', commit: 'c'.repeat(40), subject: 'planted', author: 'Test', date: '2026-10-17T00:00:00Z', steps: 2, diff: ['+broken'] };
    return response;
  };
  const flow = new AddonFlow('bisect', './check.sh', '/tmp', [], { request, started, changed: () => {}, close: () => {} }, true);
  try {
    await flow.open(); expect(sent[0]).toMatchObject({ kind: 'addons.plan', target: null });
    flow.panel.key('y'); await vi.waitFor(() => expect(flow.panel.lines.join('\n')).toContain('First bad commit: cccccccccccc planted'));
    expect(sent).toContainEqual({ kind: 'addons.result', sessionId: run }); expect(started).not.toHaveBeenCalled();
  } finally { flow.dispose(); }
});

it('every batch-1 command is in the menu, /help and the README; /review takes deep', async () => {
  const names = ['/teach', '/fix', '/cover', '/bisect', '/refactor', '/perf', '/types', '/failures', '/security'];
  for (const name of names) expect(commandRegistry.map(c => c.name), name).toContain(name);
  const context = { engine: 'claude-code' as const, model: null, cwd: '/tmp', theme: 'graphite' as const };
  expect(commandRegistry.find(c => c.name === '/review')?.argumentHint?.(context)).toContain('deep');
  const { readFile } = await import('node:fs/promises');
  const help = helpLines(context).join('\n'), readme = await readFile(new URL('../README.md', import.meta.url), 'utf8'), guide = await readFile(new URL('../docs/user-guide.md', import.meta.url), 'utf8');
  for (const name of [...names, '/review <agent> deep']) { expect(readme, name).toContain(name); expect(guide, name).toContain(name); }
  for (const keys of ['/teach Space / y / n', '/refactor ↑↓ / Space / r', '/types f', '/perf a / Y', '/bisect y / Y']) { expect(help, keys).toContain(keys); expect(readme, keys).toContain(keys); }
});

class TTY extends EventEmitter { isTTY = true; columns = 130; rows = 45; output = ''; setRawMode() {} resume() {} pause() {} write(s: string | Buffer) { this.output += String(s); return true; } }
async function screen(tty: TTY) { const term = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true }); try { await new Promise<void>(r => term.write(tty.output, r)); return Array.from({ length: 45 }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n'); } finally { term.dispose(); } }
it('the homepage sends an agent\'s id for /teach and /review <agent> deep, a scope for /cover, and no target for /bisect', async () => {
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
    for (const [typed, name, args] of [['/teach fixer', 'teach', id], ['/review fixer deep', 'review-deep', id], ['/cover', 'cover', ''], ['/bisect ./check.sh', 'bisect', './check.sh']] as const) {
      tty.emit('data', Buffer.from(`${typed}\r`));
      await vi.waitFor(() => expect(plans().at(-1)).toMatchObject({ name, args }), { timeout: 10_000 });
      if (name === 'bisect') expect(plans().at(-1)?.target).toBeNull();
      tty.emit('data', Buffer.from('\x1b')); await vi.waitFor(async () => expect(await screen(tty)).not.toContain('estimate stub'), { timeout: 10_000 });
    }
    // /review without deep stays the keyed one-model review.
    tty.emit('data', Buffer.from('/review fixer\r')); await vi.waitFor(() => expect(requests.some(r => r.kind === 'sessions.reviewPlan')).toBe(true), { timeout: 10_000 });
  } finally { await home.stop(); }
});

it('/fix shows the root cause, the failing test first and the sandboxed test result; one that stopped says nothing was fixed', () => {
  const { panel: p } = panel(); p.setResult(result('fix')); p.setTests({ state: 'pass' });
  const text = p.lines.join('\n');
  expect(text).toContain('Root cause: parse() reads past the end'); expect(text).toContain('Failing test first: tests/a.test.ts › rejects empty input'); expect(text).toContain("tests (AI Term's sandbox): ✓ tests pass");
  const stopped = panel(); stopped.panel.setResult(parseAddonResult(JSON.stringify({ kind: 'fix', reproduced: false, rootCause: 'unknown', reason: 'No test failed.' }), 'fix', true));
  expect(stopped.panel.lines.join('\n')).toContain('■ stopped: no test reproduced the bug, so nothing was fixed');
  const cover = panel(); cover.panel.setResult(result('cover')); cover.panel.setTests({ state: 'fail', failing: 1 });
  expect(cover.panel.lines.join('\n')).toContain('fails if: the empty check were removed'); expect(cover.panel.lines.join('\n')).toContain('✗ 1 failing');
});

it('MEDIUM (TS review): /bisect and the /perf A/B say up front that the copy has only committed files', () => {
  const { panel: p } = panel(); p.setAsk(ask({ name: 'bisect', target: null, priceUsd: { low: 0, high: 0 }, bisect: { command: ['npm', 'test'], good: 'a'.repeat(40), bad: 'b'.repeat(40), goodLabel: 'HEAD~32', commits: 3, sandbox: true } }));
  expect(p.lines.join('\n')).toContain('only committed files: no installed dependencies or build output');
  const perf = panel(); perf.panel.setResult(result('perf'));
  expect(perf.panel.lines.join('\n')).toContain('only committed files: no installed dependencies or build output');
});
