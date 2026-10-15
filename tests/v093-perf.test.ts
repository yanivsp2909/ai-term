import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';

// v0.9.3 performance pass: an attached session's output reaches its client before the mirror's write (xterm calls back
// from a timer, ~1.2 ms of every typed key's echo), and never out of order.
const roots: string[] = [], managers: SessionManager[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.shutdown(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function manager(script: string) {
  const root = await mkdtemp(join(tmpdir(), 'ai-term-perf-')); roots.push(root);
  const paths = getPaths(root); await preparePaths(paths);
  const m = new SessionManager(paths, new Logger(paths.log), { executable: '/bin/sh', args: ['-c', script], env: { PATH: '/usr/bin:/bin' } }); managers.push(m); await m.load();
  return { m, root };
}
// What the attached client receives, in order: early bytes, and the mirror path's bytes it wasn't sent early.
function ownerStream(m: SessionManager, id: string) {
  const parts: { early: boolean; text: string }[] = [];
  m.on('ownerOutput', (sid: string, data: Buffer) => { if (sid === id) parts.push({ early: true, text: data.toString() }); });
  m.on('output', (sid: string, data: Buffer, ownerHasIt: boolean) => { if (sid === id && !ownerHasIt) parts.push({ early: false, text: data.toString() }); });
  return parts;
}

it('typed keys echo to the attached client before the mirror has written them', async () => {
  const { m, root } = await manager('stty -icanon; while true; do dd bs=1 count=1 2>/dev/null; done');
  const live = await m.create({ cwd: root }), parts = ownerStream(m, live.id);
  await m.attach(live.id, 80, 24, () => undefined);
  await new Promise(resolve => setTimeout(resolve, 300));
  parts.length = 0;
  m.input(live.id, Buffer.from('k'));
  await expect.poll(() => parts.map(p => p.text).join('')).toContain('k');
  expect(parts.find(p => p.text.includes('k'))?.early).toBe(true);
}, 20_000);

it('a flood that starts before attach reaches the client whole and in order', async () => {
  const { m, root } = await manager('sleep 0.2; seq 1 30000; read x');
  const live = await m.create({ cwd: root }), parts = ownerStream(m, live.id);
  let snapshot = '';
  await new Promise(resolve => setTimeout(resolve, 250));
  await m.attach(live.id, 80, 24, text => { snapshot = text; });
  await expect.poll(() => parts.map(p => p.text).join('').includes('30000'), { timeout: 10_000 }).toBe(true);
  const after = parts.map(p => p.text).join('').replace(/\r/g, '').split('\n').filter(line => /^\d+$/.test(line)).map(Number);
  // Strictly increasing after the snapshot, with nothing missing between the first and the last.
  for (let i = 1; i < after.length; i++) expect(after[i]).toBe((after[i - 1] ?? 0) + 1);
  expect(after.at(-1)).toBe(30000);
  expect(snapshot.length).toBeGreaterThan(0);
}, 30_000);
