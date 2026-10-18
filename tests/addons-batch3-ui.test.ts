import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import headless from '@xterm/headless';
import { AddonPanel } from '../src/client/tui/addon-panel.js';
import { Homepage } from '../src/client/tui/homepage.js';
import { commandRegistry, helpLines } from '../src/client/tui/commands.js';
import { parseAddonResult } from '../src/shared/addon-results.js';
import type { AddonAsk } from '../src/shared/addons.js';
import type { RequestBody } from '../src/client/connection.js';
import type { KeyView, SessionInfo, SuccessResponse } from '../src/shared/protocol.js';
import { batch3 } from './fixtures/addon-results.js';

// v1.1 batch 3 in the one add-on popup.
const panel = () => {
  const actions = { start: vi.fn(), build: vi.fn(), approve: vi.fn(), step: vi.fn(), copy: vi.fn(), choose: vi.fn(), apply: vi.fn(), ab: vi.fn(), commit: vi.fn(), polish: vi.fn(), file: vi.fn() };
  return { actions, panel: new AddonPanel(() => {}, () => {}, actions) };
};
const kept = (name: string) => parseAddonResult(JSON.stringify(name === 'a11y' ? { ...batch3[name], dropped: 0 } : batch3[name]), name, true);
const ask = (over: Partial<AddonAsk>): AddonAsk => ({ receipt: randomUUID(), name: 'deck', summary: 'Deck', cwd: '/tmp/repo', target: { engine: 'claude-code', model: null, auth: { kind: 'account' } }, brain: 'none', brainNeed: 'recommended', worktree: true, readOnly: false, files: [], inputTokens: { low: 1, high: 2 }, outputTokens: { low: 1, high: 2 }, priceUsd: { low: 0, high: 0 }, subscription: true, ...over });

it('a made file opens with o and is saved to Downloads with s, only when pressed; the deck lists its TODOs', () => {
  const { panel: p, actions } = panel(); p.setAsk(ask({})); p.setResult(kept('deck'));
  const text = p.lines.join('\n');
  expect(text).toContain('› out/deck/ai-term.html'); expect(text).toContain('TODO: paying users'); expect(text).toContain('o opens it · s saves a copy to Downloads');
  expect(actions.file).not.toHaveBeenCalled();
  p.key('o'); expect(actions.file).toHaveBeenLastCalledWith(0, 'open');
  p.key('s'); expect(actions.file).toHaveBeenLastCalledWith(0, 'save');
  const design = panel(); design.panel.setAsk(ask({ name: 'design' })); design.panel.setResult(kept('design'));
  design.panel.key('down'); design.panel.key('o'); expect(design.actions.file).toHaveBeenCalledWith(1, 'open');
  const polish = panel(); polish.panel.setAsk(ask({ name: 'polish' })); polish.panel.setResult(kept('polish'));
  polish.panel.key('o'); expect(polish.actions.file).not.toHaveBeenCalled();
});

it('/animate says its verdict first; /video says what is missing to render; /research lists its sources', () => {
  const skip = panel(); skip.panel.setAsk(ask({ name: 'animate' })); skip.panel.setResult(parseAddonResult(JSON.stringify({ kind: 'animate', verdict: 'skip', why: 'It opens 100 times a day.', summary: 'Instant is right', files: [] }), 'animate', true));
  expect(skip.panel.lines.join('\n')).toContain('■ no animation: It opens 100 times a day.');
  const yes = panel(); yes.panel.setAsk(ask({ name: 'animate' })); yes.panel.setResult(kept('animate'));
  expect(yes.panel.lines.join('\n')).toContain('✓ animate: A dialog opens a few times a day');
  const video = panel(); video.panel.setAsk(ask({ name: 'video' })); video.panel.setResult(kept('video'));
  expect(video.panel.lines.join('\n')).toContain('not rendered · missing: vhs (brew install vhs)');
  const research = panel(); research.panel.setAsk(ask({ name: 'research' })); research.panel.setResult(kept('research'));
  expect(research.panel.lines.join('\n')).toContain('https://man7.org/linux/man-pages/man7/pty.7.html');
});

it('/study shows one chunk per Space and its check question, then the recap; /study alone lists what is due', () => {
  const { panel: p } = panel(); p.setAsk(ask({ name: 'study', readOnly: true, worktree: false })); p.setResult(kept('study'));
  expect(p.lines.join('\n')).toContain('Check: two agents edit a.ts');
  p.key('space'); expect(p.lines.join('\n')).toContain('Worktrees isolate agents.');
  const due = panel(); due.panel.setAsk(ask({ name: 'study-due', target: null, free: true })); due.panel.setResult({ kind: 'study-due', topics: [{ topic: 'git worktrees', due: '2026-10-19', step: 1 }] });
  expect(due.panel.lines.join('\n')).toContain('git worktrees · review 2 · due 2026-10-19'); expect(due.panel.lines.join('\n')).toContain('/study <topic> starts a session');
});

it('/a11y f fixes the selected finding', () => {
  const { panel: p, actions } = panel(); p.setAsk(ask({ name: 'a11y' })); p.setResult(kept('a11y'));
  expect(p.lines.join('\n')).toContain('✗ HIGH src/ui/button.tsx:4 Icon button has no name');
  p.key('f'); expect(actions.apply).toHaveBeenCalledWith([0]);
});

it('every batch-3 command is in the menu, /help, the README and the user guide', async () => {
  const names = ['/deck', '/slides', '/diagram', '/design', '/polish', '/a11y', '/e2e', '/animate', '/video', '/research', '/study'];
  for (const name of names) expect(commandRegistry.map(c => c.name), name).toContain(name);
  const context = { engine: 'claude-code' as const, model: null, cwd: '/tmp', theme: 'graphite' as const };
  const help = helpLines(context).join('\n'), readme = await readFile(new URL('../README.md', import.meta.url), 'utf8'), guide = await readFile(new URL('../docs/user-guide.md', import.meta.url), 'utf8');
  for (const name of names) { expect(readme, name).toContain(name); expect(guide, name).toContain(name); }
  for (const keys of ['Made files o / s', '/a11y f', '/study Space']) { expect(help, keys).toContain(keys); expect(readme, keys).toContain(keys); }
});

class TTY extends EventEmitter { isTTY = true; columns = 130; rows = 45; output = ''; setRawMode() {} resume() {} pause() {} write(s: string | Buffer) { this.output += String(s); return true; } }
async function screen(tty: TTY) { const term = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true }); try { await new Promise<void>(r => term.write(tty.output, r)); return Array.from({ length: 45 }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n'); } finally { term.dispose(); } }
it('the homepage sends /study alone as its due list with no target, and offers /research only engines with web tools', async () => {
  const requests: RequestBody[] = [], now = new Date().toISOString();
  const key = { id: randomUUID(), provider: 'anthropic', label: 'work', last4: 'abcd', createdAt: now, lastTest: [{ model: 'claude-sonnet-5-5', ok: true, testedAt: now }] } as unknown as KeyView;
  const client = Object.assign(new EventEmitter(), { async request(body: RequestBody): Promise<SuccessResponse> {
    requests.push(body); const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.get') response.settings = { theme: 'graphite' }; if (body.kind === 'sessions.list') response.sessions = [] as SessionInfo[]; if (body.kind === 'keys.list') response.keys = [key];
    if (body.kind === 'sessions.preview') { response.snapshot = ''; response.cols = 85; response.rows = 30; }
    if (body.kind === 'addons.plan') throw new Error('estimate stub');
    return response;
  } });
  const tty = new TTY(), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', terminalProgram: 'unknown' }); await home.start();
  const plans = () => requests.filter((r): r is Extract<RequestBody, { kind: 'addons.plan' }> => r.kind === 'addons.plan');
  try {
    tty.emit('data', Buffer.from('/study\r')); await vi.waitFor(() => expect(plans().at(-1)).toMatchObject({ name: 'study-due', args: '', target: null }), { timeout: 10_000 });
    tty.emit('data', Buffer.from('\x1b')); await vi.waitFor(async () => expect(await screen(tty)).not.toContain('estimate stub'), { timeout: 10_000 });
    tty.emit('data', Buffer.from('/study git worktrees\r')); await vi.waitFor(() => expect(plans().at(-1)).toMatchObject({ name: 'study', args: 'git worktrees' }), { timeout: 10_000 });
    tty.emit('data', Buffer.from('\x1b')); await vi.waitFor(async () => expect(await screen(tty)).not.toContain('estimate stub'), { timeout: 10_000 });
    tty.emit('data', Buffer.from('/research PTY limits\r')); await vi.waitFor(() => expect(plans().at(-1)).toMatchObject({ name: 'research' }), { timeout: 10_000 });
    expect(plans().at(-1)?.target?.engine).not.toBe('ai-term');
  } finally { await home.stop(); }
});
