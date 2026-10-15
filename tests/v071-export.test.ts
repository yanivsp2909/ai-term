import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { readTranscript } from '../src/daemon/session-export.js';
import { validateSessionExport, type SessionExport } from '../src/shared/session-export.js';
import { exportHtml } from '../src/client/tui/export-html.js';
import { saveExport } from '../src/client/export-file.js';
import { Homepage } from '../src/client/tui/homepage.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SessionInfo, SuccessResponse } from '../src/shared/protocol.js';

// v0.7.1 /export [agent] [folder]: one self-contained HTML file of a session (its screen text, plus the transcript for AI
// Term's own agent), keys, tokens and anything matching the redaction rules removed; ~/Downloads unless a folder is given.
const roots: string[] = [], managers: SessionManager[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.shutdown(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const temp = async () => { const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-export-'))); roots.push(root); return root; };
const SECRET = 'sk-ant-api03-EXPORTCANARY0123456789';

it('a session\'s export carries its screen text with secrets redacted', async () => {
  const root = await temp(), home = join(root, 'home'); await mkdir(home, { mode: 0o700 });
  const paths = getPaths(home); await preparePaths(paths);
  const m = new SessionManager(paths, new Logger(paths.log), { executable: '/bin/sh', args: ['-c', `printf 'ANTHROPIC_API_KEY=${SECRET}\\nbuild ok\\n'; sleep 30`], env: { PATH: '/usr/bin:/bin' } }); managers.push(m); await m.load();
  const shell = await m.create({ cwd: root, title: 'builder' });
  await expect.poll(async () => (await m.text(shell.id)).text).toContain('build ok');
  const data = await m.exportSession(shell.id);
  expect(data).toMatchObject({ title: 'builder', engine: 'shell', transcript: null });
  expect(data.text).toContain('ANTHROPIC_API_KEY=[redacted]'); expect(data.text).toContain('build ok'); expect(JSON.stringify(data)).not.toContain('EXPORTCANARY');
  expect(() => validateSessionExport(data)).not.toThrow();
});

it('AI Term\'s transcript is read safely: every entry, redacted, capped, never through a symlink', async () => {
  const root = await temp(), file = join(root, 'transcript.jsonl');
  const lines = [{ v: 1, at: '2026-10-15T10:00:00.000Z', kind: 'user', text: 'fix the build' }, { v: 1, at: '2026-10-15T10:00:01.000Z', kind: 'tool-call', tool: 'bash', input: `export TOKEN=${SECRET}` },
    { v: 1, at: '2026-10-15T10:00:02.000Z', kind: 'tool-result', tool: 'bash', ok: false, output: 'exit 1' }, { v: 1, at: '2026-10-15T10:00:03.000Z', kind: 'assistant', text: 'Done.' }, { v: 1, at: '2026-10-15T10:00:04.000Z', kind: 'model', model: 'gpt-6.1' }];
  await writeFile(file, lines.map(l => JSON.stringify(l)).join('\n') + '\nnot json\n', { mode: 0o600 });
  const read = await readTranscript(file);
  expect(read.entries.map(e => [e.kind, e.label])).toEqual([['user', 'you'], ['tool-call', 'bash'], ['tool-result', 'bash · failed'], ['assistant', 'agent'], ['model', 'model']]);
  expect(JSON.stringify(read)).not.toContain('EXPORTCANARY'); expect(read.entries[1]?.text).toContain('[redacted]');
  await symlink(file, join(root, 'link.jsonl'));
  await expect(readTranscript(join(root, 'link.jsonl'))).rejects.toThrow();
});

const data: SessionExport = { title: 'fixer <b>', engine: 'ai-term', model: 'gpt-6.1', cwd: '/tmp/x', branch: 'ai/fixer', createdAt: '2026-10-15T10:00:00.000Z', exportedAt: '2026-10-15T11:00:00.000Z', text: '<script>alert(1)</script>\n& done', truncated: false,
  transcript: [{ at: '2026-10-15T10:00:00.000Z', kind: 'user', label: 'you', text: 'hi "there"' }], transcriptTruncated: false };

it('the HTML is one self-contained, escaped page: no scripts, no outside requests', () => {
  const html = exportHtml(data);
  expect(html.startsWith('<!doctype html>')).toBe(true);
  expect(html).toContain('fixer &lt;b&gt;'); expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;'); expect(html).toContain('&amp; done'); expect(html).toContain('hi &quot;there&quot;');
  expect(html).not.toMatch(/<script|src=|href=|@import|url\(/i);
  expect(html).toContain("Content-Security-Policy"); expect(html).toContain('prefers-color-scheme');
});

it('the file goes to the folder asked for (~/Downloads by default), never over another file, private to you', async () => {
  const root = await temp(), home = join(root, 'home'), downloads = join(home, 'Downloads'); await mkdir(downloads, { recursive: true });
  const now = new Date('2026-10-15T11:05:00');
  const first = await saveExport('<!doctype html>a', { title: 'fixer', now, home });
  expect(first).toBe(join(downloads, 'ai-term-fixer-20261015-1105.html'));
  const second = await saveExport('<!doctype html>b', { title: 'fixer', now, home });
  expect(second).toBe(join(downloads, 'ai-term-fixer-20261015-1105-2.html'));
  expect(await readFile(first, 'utf8')).toBe('<!doctype html>a'); expect((await stat(second)).mode & 0o777).toBe(0o600);
  const other = join(root, 'out'); await mkdir(other);
  expect(await saveExport('x', { title: 'a/b ../c', now, home, folder: '~/../out' })).toBe(join(other, 'ai-term-a-b-c-20261015-1105.html'));
  await expect(saveExport('x', { title: 'fixer', now, home, folder: join(root, 'missing') })).rejects.toThrow('Export folder not found');
  await writeFile(join(root, 'file'), '');
  await expect(saveExport('x', { title: 'fixer', now, home, folder: join(root, 'file') })).rejects.toThrow('Export folder is not a folder');
  await expect(saveExport('x', { title: 'fixer', now, home, folder: 'relative/dir' })).rejects.toThrow('Export folder must be a full path or start with ~');
  expect((await readdir(downloads)).length).toBe(2);
});

it('/export on the homepage saves the selected agent, or a named one into a given folder', async () => {
  const root = await temp(), now = new Date().toISOString();
  const fixer: SessionInfo = { id: randomUUID(), title: 'fixer', engine: 'codex', model: 'gpt', auth: { kind: 'account' }, cwd: '/tmp', permission: 'ask', status: 'done', statusDetail: 'done', statusSince: now, createdAt: now, lastOutputAt: now, exitCode: null, ctxPercent: null, lastActivity: null };
  const requests: RequestBody[] = [];
  const client = Object.assign(new EventEmitter(), { async request(body: RequestBody): Promise<SuccessResponse> {
    requests.push(body); const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.get') response.settings = { theme: 'graphite' };
    if (body.kind === 'sessions.list') response.sessions = [fixer];
    if (body.kind === 'sessions.preview') { response.snapshot = ''; response.cols = 85; response.rows = 30; }
    if (body.kind === 'sessions.export') response.exportData = { ...data, title: 'fixer', engine: 'codex', transcript: null };
    return response;
  } });
  class TTY extends EventEmitter { isTTY = true; isRaw = false; columns = 130; rows = 45; output = ''; setRawMode(v: boolean) { this.isRaw = v; } resume() {} pause() {} write(d: string | Buffer) { this.output += d.toString(); return true; } }
  const tty = new TTY(), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', terminalProgram: 'unknown' });
  await home.start();
  try {
    for (const char of `/export fixer ${root}\r`) tty.emit('data', Buffer.from(char));
    await vi.waitFor(async () => expect((await readdir(root)).filter(n => n.endsWith('.html'))).toHaveLength(1));
    expect(requests).toContainEqual({ kind: 'sessions.export', sessionId: fixer.id });
    const [name] = (await readdir(root)).filter(n => n.endsWith('.html'));
    expect(await readFile(join(root, name ?? ''), 'utf8')).toContain('&lt;script&gt;');
  } finally { await home.stop(); }
});

// ---- Part C review findings ----
it('MEDIUM (TS review): an export always fits one protocol frame, whatever the text', async () => {
  const { fitExport } = await import('../src/daemon/session-export.js');
  const huge = { ...data, text: '日本語\x1b'.repeat(400_000), transcript: Array.from({ length: 2000 }, (_, i) => ({ at: data.createdAt, kind: 'note' as const, label: 'note', text: `"\\\n${i}`.repeat(200) })) };
  const fitted = fitExport(huge);
  expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(3 * 1024 * 1024);
  expect(fitted.truncated).toBe(true); expect(() => validateSessionExport(fitted)).not.toThrow();
});

it('LOW (security and TS reviews): metadata redacted, bidi controls gone from the page, a missing transcript isn\'t "capped"', async () => {
  const html = exportHtml({ ...data, title: `deploy ${SECRET}`.slice(0, 60), text: 'ok ‮evil⁦ done', transcript: [], transcriptTruncated: false });
  expect(html).not.toMatch(/[‪-‮⁦-⁩]/); expect(html).toContain('no transcript'); expect(html).not.toContain('capped');
  const { redactExportMeta } = await import('../src/daemon/session-export.js');
  expect(JSON.stringify(redactExportMeta({ ...data, title: `t ${SECRET}`, cwd: `/tmp/${SECRET}`, branch: 'ai/x', model: 'm' }))).not.toContain('EXPORTCANARY');
  const { transcriptFor } = await import('../src/daemon/session-export.js');
  expect(await transcriptFor(join(tmpdir(), `missing-${randomUUID()}.jsonl`))).toEqual({ entries: [], truncated: false });
});

it('LOW (fix review): an export trims the larger part first', async () => {
  const { fitExport } = await import('../src/daemon/session-export.js');
  const fitted = fitExport({ ...data, text: 'short screen', transcript: Array.from({ length: 4000 }, () => ({ at: data.createdAt, kind: 'note' as const, label: 'note', text: 'x'.repeat(1000) })) });
  expect(fitted.text).toBe('short screen'); expect(fitted.transcriptTruncated).toBe(true);
});
