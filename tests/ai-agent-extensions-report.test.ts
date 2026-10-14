import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtensionReader } from '../src/agent/extensions/reader.js';
import { HttpReporter } from '../src/agent/report.js';

const response = vi.hoisted(() => ({ body: '' }));
// No HTTP server or home-directory access: feed the reporter the actual reader's serialized responses.
vi.mock('node:http', () => ({ request: (_options: unknown, callback: (res: EventEmitter & { statusCode: number }) => void) => {
  const req = new EventEmitter();
  return Object.assign(req, {
    end() { queueMicrotask(() => { const res = Object.assign(new EventEmitter(), { statusCode: 200 }); callback(res); res.emit('data', Buffer.from(response.body)); res.emit('end'); req.emit('close'); }); },
    destroy() { req.emit('close'); },
  });
} }));
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'ai-extension-report-'))); roots.push(home);
  const project = join(home, 'work'); await mkdir(project);
  const reporter = new HttpReporter({ port: 12345, status: 'a'.repeat(64) }, () => {});
  return { home, project, reporter };
}

it('loads a maximum-size command even when JSON escaping makes its response larger than 512 KiB', async () => {
  const { home, project, reporter } = await fixture();
  const root = join(home, '.claude/commands'); await mkdir(root, { recursive: true });
  await writeFile(join(root, 'large.md'), '\u0001'.repeat(64 * 1024));
  const reader = new ExtensionReader(home, project), catalog = reader.scan();
  const item = catalog.items[0]; if (!item) throw new Error('command missing');
  const file = reader.read(item.id); response.body = JSON.stringify({ extension: file });
  expect(Buffer.byteLength(response.body)).toBeGreaterThan(512 * 1024);
  expect(await reporter.read(project, item.id)).toEqual(file);
});

it('lists all 500 accepted agents with multibyte metadata over the former response limit', async () => {
  const { home, project, reporter } = await fixture();
  const root = join(home, '.claude/agents'); await mkdir(root, { recursive: true });
  for (let n = 0; n < 500; n++) await writeFile(join(root, `${n}.md`), `---\ndescription: ${'界'.repeat(240)}\nmodel: ${'界'.repeat(240)}\n---\nReview this`);
  const catalog = new ExtensionReader(home, project).scan(); expect(catalog.items).toHaveLength(500);
  response.body = JSON.stringify({ extensions: catalog });
  expect(Buffer.byteLength(response.body)).toBeGreaterThan(512 * 1024);
  expect(await reporter.list(project)).toEqual(catalog);
});
