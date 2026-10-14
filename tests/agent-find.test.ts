import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mirror } from '../src/daemon/mirror.js';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { isFindQuery, validateFindMatches, validateRequest } from '../src/shared/validate.js';

const mirrors: Mirror[] = [], roots: string[] = [], managers: SessionManager[] = [];
afterEach(async () => { for (const m of mirrors.splice(0)) m.dispose(); for (const m of managers.splice(0)) await m.shutdown(); for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
async function mirror(text: string, cols = 40, rows = 5): Promise<Mirror> { const m = new Mirror(cols, rows, () => {}); mirrors.push(m); await m.write(text); return m; }
const SPECIAL = 'a.b*(c)[d]+?^$|\\{2}/';

it('matches special characters as plain text, never as a pattern', async () => {
  const m = await mirror(`axb ccc\r\n${SPECIAL} here\r\na.b*(c)\r\n`);
  const found = m.find(SPECIAL, 10);
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({ text: `${SPECIAL} here`, start: 0, length: SPECIAL.length });
  expect(m.find('.*', 10)).toEqual([]); expect(m.find('b*(', 10)).toHaveLength(2);
  expect(m.find('a.b', 10).map(f => f.text)).toEqual(['a.b*(c)', `${SPECIAL} here`]);
});

it('is case-insensitive, newest first, and names the row from the bottom of the buffer', async () => {
  const m = await mirror('Error one\r\nfine\r\nERROR two\r\n');
  const found = m.find('error', 10), buffer = m.terminal.buffer.active;
  expect(found.map(f => f.text)).toEqual(['ERROR two', 'Error one']);
  for (const f of found) expect(buffer.getLine(buffer.length - 1 - f.fromEnd)?.translateToString(true).slice(f.start, f.start + f.length).toLowerCase()).toBe('error');
});

it('finds a match across a soft wrap and points at the row it starts on', async () => {
  const m = await mirror(`${'x'.repeat(36)}needle-split\r\n`, 40);
  const [hit] = m.find('needle-split', 10), buffer = m.terminal.buffer.active;
  expect(hit).toBeDefined();
  expect(buffer.getLine(buffer.length - 1 - (hit?.fromEnd ?? 0))?.translateToString(true)).toContain('need');
  expect(hit?.text.slice(hit.start, hit.start + hit.length)).toBe('needle-split');
});

it('searches scrollback, clips context, and strips controls from what it returns', async () => {
  const m = await mirror(`${'early target line\r\n'}${'filler\r\n'.repeat(30)}\x1b[31mred target\x1b[0m ${'y'.repeat(300)}\r\n`, 400, 5);
  const found = m.find('target', 10);
  expect(found.map(f => f.text.slice(0, 18))).toEqual(['red target yyyyyyy', 'early target line']);
  expect(found[0]?.text.length).toBeLessThanOrEqual(160);
  expect(() => validateFindMatches(found.map(f => ({ sessionId: '0b0f43a2-8f5e-4d2c-9a7b-1c2d3e4f5a6b', ...f })))).not.toThrow();
});

it('caps results per agent and in total, and says there were more', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-find-')); roots.push(root);
  const paths = getPaths(root); await preparePaths(paths);
  const lines = Array.from({ length: 80 }, (_, i) => `hit ${i}`).join('; echo ');
  const m = new SessionManager(paths, new Logger(paths.log), { executable: '/bin/sh', args: ['-c', `echo ${lines}; read answer`], env: { PATH: '/usr/bin:/bin' } }); managers.push(m); await m.load();
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push((await m.create({ cwd: root })).id);
  await expect.poll(() => ids.every(id => m.find('hit 79').matches.some(match => match.sessionId === id))).toBe(true);
  const { matches, more } = m.find('HIT');
  expect(matches).toHaveLength(200); expect(more).toBe(true);
  for (const id of ids.slice(0, 4)) expect(matches.filter(match => match.sessionId === id)).toHaveLength(50);
  expect(m.find('hit 79')).toMatchObject({ more: false });
  expect(m.find('nothing like this').matches).toEqual([]);
});

it('queries are plain text of at most 200 characters without controls', async () => {
  expect(isFindQuery(SPECIAL)).toBe(true); expect(isFindQuery('x'.repeat(200))).toBe(true);
  for (const bad of ['', '  ', 'x'.repeat(201), 'a\x1bb', 'tab\t']) expect(isFindQuery(bad)).toBe(false);
  await expect(validateRequest({ id: crypto.randomUUID(), kind: 'sessions.find', text: 'a\nb' })).rejects.toThrow('Invalid find request');
  expect(() => validateFindMatches([{ sessionId: '0b0f43a2-8f5e-4d2c-9a7b-1c2d3e4f5a6b', fromEnd: 0, text: 'ab', start: 1, length: 2 }])).toThrow('Invalid find results');
});
