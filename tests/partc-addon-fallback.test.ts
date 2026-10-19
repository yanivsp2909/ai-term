import { afterEach, expect, it } from 'vitest';
import { cp, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddonTarget } from '../src/shared/addons.js';
import { AddonService } from '../src/daemon/addons.js';
import type { SessionInfo } from '../src/shared/protocol.js';
import { testDefinitions } from './shared-copies.js';

// Part C: the public snapshot leaves out every shared skill or agent copy whose source license isn't MIT, Apache-2.0 or
// BSD. An add-on whose copy is missing still runs, on its own steps, and its prompt says which guide this build lacks.
// Only a missing file falls back: a link or any other unsafe file is still refused.
const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });
const CODEX: AddonTarget = { engine: 'codex', model: null, auth: { kind: 'account' } };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ai-partc-addons-')); cleanup.push(root);
  const definitions = join(root, 'addons'), repo = join(root, 'repo'), home = join(root, 'home');
  // The real guides where this build has them, stand-ins where it leaves them out (shared-copies.ts).
  const source = await testDefinitions(new URL('../addons/', import.meta.url).pathname); if (source.root) cleanup.push(source.root);
  await cp(source.path, definitions, { recursive: true });
  await mkdir(join(repo, 'src'), { recursive: true }); await mkdir(home); await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  const runs: Record<string, unknown>[] = [];
  const engine = {
    async create(request: Record<string, unknown>) { runs.push(request); return { id: randomUUID(), title: String(request.title), status: 'running', cwd: String(request.cwd), engine: request.engine } as SessionInfo; },
    async text(id: string) { return { sessionId: id, text: '', truncated: false }; },
    async brainPlan() { return null; },
  };
  return { definitions, repo, runs, service: new AddonService(home, definitions, engine) };
}

it('a shared copy this build leaves out: the add-on runs on its own steps, and its prompt says which guide is missing', async () => {
  const d = await setup();
  await rm(join(d.definitions, '_shared', 'skills', 'security-bounty-hunter'), { recursive: true });
  await rm(join(d.definitions, '_shared', 'agents', 'security-reviewer.md'));
  const ask = await d.service.plan('security', 'src', d.repo, CODEX);
  expect(ask.files).toEqual([]);
  await d.service.start(ask.receipt);
  const message = String(d.runs.at(-1)?.firstMessage);
  expect(message).toContain("This build leaves out the shared guides skills/security-bounty-hunter/SKILL.md, agents/security-reviewer.md; follow this add-on's own steps.");
});

it('with every copy present nothing is said, and a link in a copy\'s place is still refused', async () => {
  const d = await setup();
  const ask = await d.service.plan('security', 'src', d.repo, CODEX);
  expect(ask.files.length).toBe(2);
  await d.service.start(ask.receipt);
  expect(String(d.runs.at(-1)?.firstMessage)).not.toContain('This build leaves out');
  const agent = join(d.definitions, '_shared', 'agents', 'security-reviewer.md');
  await rm(agent); await symlink(join(d.definitions, 'security', 'addon.md'), agent);
  await expect(d.service.plan('security', 'src', d.repo, CODEX)).rejects.toThrow();
});
