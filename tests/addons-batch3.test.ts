import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { parseAddon, validateAddonAsk, type AddonTarget } from '../src/shared/addons.js';
import { parseAddonResult } from '../src/shared/addon-results.js';
import { AddonService } from '../src/daemon/addons.js';
import type { SessionInfo } from '../src/shared/protocol.js';
import { batch3 } from './fixtures/addon-results.js';

// v1.1 batch 3 (making things): every model add-on runs once on a stub engine.
const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });
const DEFINITIONS = new URL('../addons/', import.meta.url).pathname, CODEX: AddonTarget = { engine: 'codex', model: null, auth: { kind: 'account' } };
const KEYED: AddonTarget = { engine: 'ai-term', model: 'claude-sonnet-5-5', auth: { kind: 'key', keyId: randomUUID() } };
const NAMES = ['deck', 'slides', 'diagram', 'design', 'polish', 'a11y', 'e2e', 'animate', 'video', 'research', 'study'];
async function setup(answers: (name: string) => string | undefined = name => batch3[name] ? JSON.stringify(batch3[name]) : undefined) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-batch3-'))); cleanup.push(root);
  const repo = join(root, 'repo'), home = join(root, 'home'); await mkdir(join(repo, 'src', 'ui'), { recursive: true }); await mkdir(home);
  const runs: Record<string, unknown>[] = [], replies = new Map<string, string>(), files: unknown[][] = [];
  const runner = {
    async create(request: Record<string, unknown>, _c?: undefined, _f?: undefined, addon?: { readOnly: boolean; web?: boolean }, strict?: boolean) {
      runs.push({ ...request, addon, strict }); const id = randomUUID();
      const nonce = String(request.firstMessage).match(/RESULT_([a-f0-9]{32})_BEGIN/)?.[1], body = answers(String(request.title).slice(1));
      if (nonce && body) replies.set(id, `RESULT_${nonce}_BEGIN\n${body}\nRESULT_${nonce}_END`);
      return { id, title: String(request.title), status: 'running', cwd: String(request.cwd), engine: request.engine } as SessionInfo;
    },
    async text(id: string) { return { sessionId: id, text: replies.get(id) ?? '', truncated: false }; },
    async brainPlan() { return null; },
    async addonFile(id: string, file: string, action: 'open' | 'save') { files.push([id, file, action]); return action === 'save' ? `/Users/me/Downloads/${file.split('/').at(-1)}` : null; },
  };
  return { repo, home, runs, files, service: new AddonService(home, DEFINITIONS, runner) };
}
const started = (value: { session: SessionInfo } | { run: string }) => { if (!('session' in value)) throw new Error('expected an agent'); return value.session; };

it('every batch-3 definition parses and its shared copies name their source, license and changes', async () => {
  for (const name of [...NAMES, 'study-due']) {
    const addon = parseAddon(await readFile(join(DEFINITIONS, name, 'addon.md'), 'utf8'), name);
    for (const asset of [...addon.skills.map(s => `skills/${s}/SKILL.md`), ...addon.agents.map(a => `agents/${a}.md`)]) expect(await readFile(join(DEFINITIONS, '_shared', asset), 'utf8'), asset).toMatch(/\nSource: .+\nLicense: .+\nWhat changed: .+\n/);
  }
  const read = async (name: string) => parseAddon(await readFile(join(DEFINITIONS, name, 'addon.md'), 'utf8'), name);
  for (const name of ['deck', 'slides', 'diagram', 'design', 'research', 'study']) expect((await read(name)).brain, name).toBe('recommended');
  expect(await read('research')).toMatchObject({ web: true, engines: ['claude-code', 'codex'], worktree: true });
  expect(await read('e2e')).toMatchObject({ tests: true, worktree: true });
  expect(await read('a11y')).toMatchObject({ readOnly: true, input: 'path' });
  expect(await read('study')).toMatchObject({ readOnly: true, worktree: false });
  expect(await read('study-due')).toMatchObject({ local: 'study-due', input: 'none' });
});

it('each batch-3 model add-on runs once on a stub engine with its own isolation; research gets the web on Codex', async () => {
  const { repo, runs, service } = await setup();
  const args: Record<string, string> = { deck: 'AI Term seed round', slides: 'How add-ons work', diagram: 'the daemon processes', design: 'the settings screen', polish: 'src/ui', a11y: 'src/ui', e2e: 'sign in and save', animate: 'the dialog opening', video: 'a /plan demo', research: 'PTY limits on macOS', study: 'git worktrees' };
  for (const [name, arg] of Object.entries(args)) {
    const ask = validateAddonAsk(JSON.parse(JSON.stringify(await service.plan(name, arg, repo, CODEX))));
    const session = started(await service.start(ask.receipt)), addon = parseAddon(await readFile(join(DEFINITIONS, name, 'addon.md'), 'utf8'), name);
    expect(runs.at(-1), name).toMatchObject({ permission: 'ask', useWorktree: addon.worktree, addon: { readOnly: addon.readOnly } });
    expect((runs.at(-1)?.addon as { web?: boolean }).web === true, name).toBe(name === 'research');
    const result = await service.result(session.id);
    expect(result?.kind, name).toBe(name);
    expect(parseAddonResult(JSON.stringify(result), name, true)).toEqual(result);
    expect(service.wantsTests(session.id), name).toBe(addon.tests);
  }
});

it('/research refuses AI Term\'s own agent with a one-line reason', async () => {
  const { repo, service } = await setup();
  await expect(service.plan('research', 'PTY limits', repo, KEYED)).rejects.toThrow("/research needs an engine with its own web tools (Claude Code or Codex); AI Term's agent has none");
});

it('made files must stay under their command\'s folder; o opens and s saves only those, through the daemon', async () => {
  const { repo, files, service } = await setup();
  expect(() => parseAddonResult(JSON.stringify({ ...batch3.deck, files: ['../outside.html'] }), 'deck')).toThrow();
  expect(() => parseAddonResult(JSON.stringify({ ...batch3.deck, files: ['src/index.html'] }), 'deck')).toThrow();
  expect(() => parseAddonResult(JSON.stringify({ ...batch3.research, sources: ['javascript:alert(1)'] }), 'research')).toThrow();
  const deck = started(await service.start((await service.plan('deck', 'seed', repo, CODEX)).receipt)).id;
  await expect(service.file(deck, 0, 'open')).rejects.toThrow('Wait for the result');
  await service.result(deck);
  expect(await service.file(deck, 0, 'open')).toBeNull(); expect(await service.file(deck, 0, 'save')).toBe('/Users/me/Downloads/ai-term.html');
  await expect(service.file(deck, 3, 'open')).rejects.toThrow('No such file');
  const polish = started(await service.start((await service.plan('polish', 'src/ui', repo, CODEX)).receipt)).id; await service.result(polish);
  await expect(service.file(polish, 0, 'open')).rejects.toThrow('nothing to open');
  expect(files).toEqual([[deck, 'out/deck/ai-term.html', 'open'], [deck, 'out/deck/ai-term.html', 'save']]);
});

it('/a11y f fixes one finding in a worktree; /animate can decide not to animate', async () => {
  const { repo, runs, service } = await setup(name => name === 'animate' ? JSON.stringify({ kind: 'animate', verdict: 'skip', why: 'The command palette opens 100 times a day.', summary: 'No animation: an instant open is right', files: [] }) : batch3[name] ? JSON.stringify(batch3[name]) : undefined);
  const a11y = started(await service.start((await service.plan('a11y', 'src/ui', repo, CODEX)).receipt)).id; await service.result(a11y);
  await expect(service.apply(a11y, [0, 1])).rejects.toThrow('Pick items'); await service.apply(a11y, [0]);
  expect(runs.at(-1)).toMatchObject({ useWorktree: true, strict: true }); expect(String(runs.at(-1)?.firstMessage)).toContain('Add aria-label="Close".');
  const animate = started(await service.start((await service.plan('animate', 'command palette', repo, CODEX)).receipt)).id;
  expect(await service.result(animate)).toMatchObject({ verdict: 'skip', files: [] });
});

it('/study keeps a review schedule; /study alone lists what is due, with no model and no y', async () => {
  const { repo, home, runs, service } = await setup();
  const session = started(await service.start((await service.plan('study', 'git worktrees', repo, CODEX)).receipt)).id;
  await service.result(session);
  const schedule = JSON.parse(await readFile(join(home, 'study', 'schedule.json'), 'utf8')) as { topic: string; step: number }[];
  expect(schedule).toMatchObject([{ topic: 'git worktrees', step: 0 }]);
  const ask = await service.plan('study-due', '', repo, null);
  expect(ask).toMatchObject({ free: true, target: null });
  const run = await service.start(ask.receipt); if (!('run' in run)) throw new Error('expected a run');
  await vi.waitFor(async () => expect(await service.result(run.run)).toMatchObject({ kind: 'study-due' }), { timeout: 10_000 });
  expect(runs).toHaveLength(1);
});

it('HIGH/LOW (reviews): a result may name only viewable files, a rendered diagram or video must include its rendering, sources carry no userinfo', () => {
  expect(() => parseAddonResult(JSON.stringify({ ...batch3.deck, files: ['out/deck/run.command'] }), 'deck')).toThrow();
  expect(() => parseAddonResult(JSON.stringify({ ...batch3.research, files: ['docs/research/page.html'] }), 'research')).toThrow();
  expect(() => parseAddonResult(JSON.stringify({ ...batch3.diagram, rendered: true }), 'diagram')).toThrow();
  expect(parseAddonResult(JSON.stringify({ ...batch3.diagram, files: ['docs/diagrams/processes.mmd', 'docs/diagrams/processes.svg'], rendered: true }), 'diagram')).toMatchObject({ rendered: true });
  expect(() => parseAddonResult(JSON.stringify({ ...batch3.video, rendered: true }), 'video')).toThrow();
  expect(() => parseAddonResult(JSON.stringify({ ...batch3.research, sources: ['https://github.com@evil.example/x'] }), 'research')).toThrow();
});

it('MEDIUM (reviews): /study records a topic once, cleaned up; never an empty one; a repeat the same day does not jump ahead', async () => {
  const { repo, home, service } = await setup(), { recordStudy } = await import('../src/daemon/study.js');
  const session = started(await service.start((await service.plan('study', '  git\tworktrees\n', repo, CODEX)).receipt)).id;
  await Promise.all([service.result(session), service.result(session)]);
  const schedule = JSON.parse(await readFile(join(home, 'study', 'schedule.json'), 'utf8')) as { topic: string; step: number }[];
  expect(schedule).toEqual([expect.objectContaining({ topic: 'git worktrees', step: 0 })]);
  await recordStudy(home, 'git worktrees'); await recordStudy(home, '   ');
  expect(JSON.parse(await readFile(join(home, 'study', 'schedule.json'), 'utf8'))).toEqual([expect.objectContaining({ topic: 'git worktrees', step: 0 })]);
});

it('every batch-3 model add-on tells the engine the exact result shape it must return', async () => {
  const { repo, runs, service } = await setup();
  for (const name of NAMES) {
    started(await service.start((await service.plan(name, 'src/ui', repo, CODEX)).receipt));
    const first = String(runs.at(-1)?.firstMessage);
    expect(first, name).toContain(`kind="${name}"`); expect(first, name).not.toContain('Return the answer as text.');
  }
});
