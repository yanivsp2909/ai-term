import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { QueueService } from '../src/daemon/queue.js';
import { QueuePanel } from '../src/client/tui/queue-panel.js';
import { validateQueueUnreadable } from '../src/shared/queue.js';

// Backlog F6 (v0.9+v1.0 gate LOW): queue items AI Term couldn't read are kept aside and logged, and now /queue says so
// too: how many, and the name of the file kept as it was.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-f6-'))); roots.push(dir); return dir; }
const manager = () => ({ create: vi.fn(async () => ({ id: randomUUID() })), on: vi.fn(), setQueueLimit: vi.fn(), stop: vi.fn() });
const good = () => ({ id: randomUUID(), createdAt: new Date().toISOString(), trigger: { kind: 'after', agent: 'fixer' }, limit: { until: '23:59' }, request: { engine: 'codex', model: null, auth: { kind: 'account' }, cwd: '/tmp', permission: 'ask', effort: null }, state: 'waiting' });
const panelText = (panel: QueuePanel) => ((panel as unknown as { panel: { lines: { text: string }[] | null } }).panel.lines ?? []).map(line => line.text).join('\n');

it('the queue service says how many items it could not read and which file kept them', async () => {
  const root = await temp();
  await writeFile(join(root, 'queue.json'), JSON.stringify([good(), { id: 'not-a-uuid' }, good(), 7]));
  const queue = new QueueService(root, manager() as never, { error: vi.fn(), info: vi.fn() }, () => new Date(2026, 9, 15, 12, 0), async () => true);
  await queue.load();
  expect(queue.list()).toHaveLength(2);
  const unreadable = queue.unreadable();
  expect(unreadable?.items).toBe(2);
  expect(unreadable?.file).toMatch(/^queue\.json\.unreadable-\d+$/);
  expect(await readdir(root)).toContain(unreadable?.file);
  await queue.close();
  // A queue file that isn't a list at all: nothing could be counted.
  const other = await temp();
  await writeFile(join(other, 'queue.json'), '{"not":"a list"}');
  const whole = new QueueService(other, manager() as never, { error: vi.fn(), info: vi.fn() }, () => new Date(2026, 9, 15, 12, 0), async () => true);
  await whole.load();
  expect(whole.unreadable()).toMatchObject({ items: null });
  await whole.close();
  // A clean queue has nothing to say.
  const clean = new QueueService(await temp(), manager() as never, { error: vi.fn(), info: vi.fn() }, () => new Date(), async () => true);
  await clean.load(); expect(clean.unreadable()).toBeNull(); await clean.close();
});

it('/queue names what it could not read, and the client accepts only that shape', () => {
  const panel = new QueuePanel(() => {}, () => {}, async () => [], true);
  panel.set([]);
  expect(panelText(panel)).not.toContain("couldn't be read");
  panel.setUnreadable({ items: 2, file: 'queue.json.unreadable-1760000000000' });
  expect(panelText(panel)).toContain("! 2 queued items couldn't be read and were left out · the file as it was: queue.json.unreadable-1760000000000 in AI Term's folder");
  panel.setUnreadable({ items: null, file: 'queue.json.unreadable-1760000000000' });
  expect(panelText(panel)).toContain("! the queue file couldn't be read · the file as it was: queue.json.unreadable-1760000000000 in AI Term's folder");
  expect(validateQueueUnreadable({ items: 1, file: 'queue.json.unreadable-12' })).toEqual({ items: 1, file: 'queue.json.unreadable-12' });
  expect(validateQueueUnreadable(undefined)).toBeNull();
  for (const bad of [{ items: 1, file: '../etc/passwd' }, { items: -1, file: 'queue.json.unreadable-1' }, { items: 1, file: 'queue.json.unreadable-1', more: true }, 'x'])
    expect(() => validateQueueUnreadable(bad)).toThrow();
});
