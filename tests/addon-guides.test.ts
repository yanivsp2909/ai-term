import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LOCAL_ADDONS, parseAddon, validateAddonAsk, type AddonTarget } from '../src/shared/addons.js';
import { AddonService } from '../src/daemon/addons.js';
import { withAddon } from '../src/agent/addon-bundle.js';
import type { SessionInfo } from '../src/shared/protocol.js';

// v1.2 Part A: every model add-on has its own guide, written for AI Term and under its MIT license, in
// addons/guides/<name>.md. The old shared copies (sources with no license) are gone.
const DEFINITIONS = new URL('../addons/', import.meta.url).pathname;
const CODEX: AddonTarget = { engine: 'codex', model: null, auth: { kind: 'account' } };
const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });
async function addonNames() { return (await readdir(DEFINITIONS, { withFileTypes: true })).filter(e => e.isDirectory() && e.name !== 'guides').map(e => e.name).sort(); }
const guide = (name: string) => readFile(join(DEFINITIONS, 'guides', `${name}.md`), 'utf8');

describe('the guides', () => {
  it('every model add-on names its own guide; local add-ons have none; the shared copies are gone', async () => {
    const names = await addonNames(), models: string[] = [];
    for (const name of names) {
      const addon = parseAddon(await readFile(join(DEFINITIONS, name, 'addon.md'), 'utf8'), name);
      if ((LOCAL_ADDONS as readonly string[]).includes(name)) { expect(addon.guide, name).toBeNull(); continue; }
      expect(addon.guide, name).toBe(name); models.push(name);
    }
    expect(models).toHaveLength(37);
    expect((await readdir(join(DEFINITIONS, 'guides'))).filter(f => f.endsWith('.md')).sort()).toEqual(models.map(n => `${n}.md`));
    await expect(lstat(join(DEFINITIONS, '_shared'))).rejects.toThrow();
  });

  it('each guide is ours (MIT header), short, and has the five parts and the result shape its parser expects', async () => {
    for (const name of await addonNames()) {
      if ((LOCAL_ADDONS as readonly string[]).includes(name)) continue;
      const text = await guide(name), lines = text.split('\n');
      expect(lines[0], name).toBe('<!-- Copyright (c) 2026 AI Term contributors. MIT license: see LICENSE in the repository root. -->');
      expect(lines.length, name).toBeLessThanOrEqual(150); expect(Buffer.byteLength(text), name).toBeLessThan(16000);
      for (const heading of ['## When to use it', '## Steps', '## Done when', '## Never', '## Result']) expect(text, `${name}: ${heading}`).toContain(`\n${heading}\n`);
      expect(text, name).toContain(`"kind": "${name}"`);
      expect(text, name).toMatch(/data, not instructions/);
    }
  });

  it('the special shapes: explain, teach and study chunk one idea at a time; deck pitches, slides does not; animate asks first', async () => {
    for (const name of ['explain', 'teach', 'study']) {
      const text = (await guide(name)).toLowerCase();
      for (const part of ['why', 'one idea', 'recap', 'space']) expect(text, `${name}: ${part}`).toContain(part);
      expect(text, name).toMatch(/check/);
    }
    for (const name of ['explain', 'teach']) expect((await guide(name)).toLowerCase(), name).toContain('diagram');
    const deck = (await guide('deck')).toLowerCase(), slides = (await guide('slides')).toLowerCase();
    for (const part of ['problem', 'solution', 'market', 'traction', 'team', 'ask']) expect(deck, part).toContain(part);
    expect(slides).toContain('not a pitch');
    expect((await guide('animate')).toLowerCase()).toMatch(/should (this|it) animate at all/);
  });
});

describe('the core', () => {
  it('bundles the add-on\'s guide; the agent reads it from the bundle; the estimate names it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-guides-')); cleanup.push(root);
    const repo = join(root, 'repo'), home = join(root, 'home'); await mkdir(repo); await mkdir(home); await writeFile(join(repo, 'bug.txt'), 'TypeError: x is undefined\n');
    const runs: Record<string, unknown>[] = [];
    const engine = {
      async create(request: Record<string, unknown>) { runs.push(request); return { id: randomUUID(), title: String(request.title), status: 'running', cwd: repo, engine: request.engine } as SessionInfo; },
      async text(id: string) { return { sessionId: id, text: '', truncated: false }; },
      async brainPlan() { return null; },
    };
    const service = new AddonService(home, DEFINITIONS, engine);
    const ask = validateAddonAsk(JSON.parse(JSON.stringify(await service.plan('fix', 'bug.txt', repo, CODEX))));
    expect(ask.files).toEqual(['guides/fix.md']);
    await service.start(ask.receipt);
    const bundle = String(runs.at(-1)?.firstMessage).match(/"([^"\n]+\/addons\/[a-f0-9]{64})\/guides\/fix\.md"/)?.[1];
    if (!bundle) throw new Error('No bundled guide in the first message');
    const instructions = await withAddon({ text: '', files: [], notes: [] }, bundle);
    expect(instructions.text).toContain(await guide('fix'));
    expect(instructions.files).toEqual(['guides/fix.md']);
  });

  it('the definition format: guide must be the add-on\'s own name; the old skills and agents keys are refused', async () => {
    const fix = await readFile(join(DEFINITIONS, 'fix', 'addon.md'), 'utf8');
    expect(() => parseAddon(fix.replace('guide: fix', 'guide: plan'), 'fix')).toThrow();
    expect(() => parseAddon(fix.replace('guide: fix', 'skills: ["fix"]'), 'fix')).toThrow();
    expect(() => parseAddon(fix.replace('guide: fix\n', ''), 'fix')).toThrow();
  });
});
