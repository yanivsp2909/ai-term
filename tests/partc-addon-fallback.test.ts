import { afterEach, expect, it } from 'vitest';
import { cp, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddonTarget } from '../src/shared/addons.js';
import { AddonService } from '../src/daemon/addons.js';
import type { SessionInfo } from '../src/shared/protocol.js';

// An add-on whose guide is missing from a build still runs, on its own steps, and its prompt says so. Only a missing
// file falls back: a link or any other unsafe file is still refused.
const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });
const CODEX: AddonTarget = { engine: 'codex', model: null, auth: { kind: 'account' } };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ai-partc-addons-')); cleanup.push(root);
  const definitions = join(root, 'addons'), repo = join(root, 'repo'), home = join(root, 'home');
  await cp(new URL('../addons/', import.meta.url).pathname, definitions, { recursive: true });
  await mkdir(join(repo, 'src'), { recursive: true }); await mkdir(home); await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  const runs: Record<string, unknown>[] = [];
  const engine = {
    async create(request: Record<string, unknown>) { runs.push(request); return { id: randomUUID(), title: String(request.title), status: 'running', cwd: String(request.cwd), engine: request.engine } as SessionInfo; },
    async text(id: string) { return { sessionId: id, text: '', truncated: false }; },
    async brainPlan() { return null; },
  };
  return { definitions, repo, runs, service: new AddonService(home, definitions, engine) };
}

it('a guide this build leaves out: the add-on runs on its own steps, and its prompt says so', async () => {
  const d = await setup();
  await rm(join(d.definitions, 'guides', 'security.md'));
  const ask = await d.service.plan('security', 'src', d.repo, CODEX);
  expect(ask.files).toEqual([]);
  await d.service.start(ask.receipt);
  const message = String(d.runs.at(-1)?.firstMessage);
  expect(message).toContain("This build leaves out this add-on's guide (guides/security.md); follow the steps above.");
  expect(message).not.toContain('bundled guide first');
});

it('with the guide present nothing is said, and a link in its place is still refused', async () => {
  const d = await setup();
  const ask = await d.service.plan('security', 'src', d.repo, CODEX);
  expect(ask.files).toEqual(['guides/security.md']);
  await d.service.start(ask.receipt);
  expect(String(d.runs.at(-1)?.firstMessage)).not.toContain('This build leaves out');
  const guide = join(d.definitions, 'guides', 'security.md');
  await rm(guide); await symlink(join(d.definitions, 'security', 'addon.md'), guide);
  await expect(d.service.plan('security', 'src', d.repo, CODEX)).rejects.toThrow();
});

it('security LOW (Part C review): a guides folder that is a dangling link is refused, not taken as missing', async () => {
  const d = await setup();
  const guides = join(d.definitions, 'guides');
  await rm(guides, { recursive: true, force: true }); await symlink(join(d.definitions, 'nowhere'), guides);
  await expect(d.service.plan('security', 'src', d.repo, CODEX)).rejects.toThrow();
});

it('code LOW (v1.2 review): a build with no guides folder at all still runs the add-on on its own steps', async () => {
  const d = await setup();
  await rm(join(d.definitions, 'guides'), { recursive: true });
  const ask = await d.service.plan('security', 'src', d.repo, CODEX);
  expect(ask.files).toEqual([]);
});
