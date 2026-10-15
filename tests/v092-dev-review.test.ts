import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DevServers, appendTail, emptyTail } from '../src/daemon/dev-servers.js';
import { devLines, validateDevPlan } from '../src/shared/dev.js';
import { cardText } from '../src/client/tui/agent-card.js';
import type { SessionInfo } from '../src/shared/protocol.js';

// Part F review (typescript-reviewer, security-reviewer; fresh context): each failed before its fix.
const roots: string[] = [], servers: DevServers[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.stopAll(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-dev-rev-'))); roots.push(dir); return dir; }

it('HIGH (TS review): the tail keeps colored lines readable, breaks on \\r, joins split chunks, and keeps a last line without a newline', () => {
  let tail = emptyTail();
  tail = appendTail(tail, Buffer.from('\x1b[32mready\x1b[0m in 120 ms\n'));
  tail = appendTail(tail, Buffer.from('progress 10%\rprogress 100%\n'));
  tail = appendTail(tail, Buffer.from('\x1b[3')); tail = appendTail(tail, Buffer.from('1merror\x1b[0m: '));
  tail = appendTail(tail, Buffer.from([0xe2, 0x9c])); tail = appendTail(tail, Buffer.from([0x93, 0x0a]));
  tail = appendTail(tail, Buffer.from('address in use'), true);
  expect(tail.lines).toEqual(['ready in 120 ms', 'progress 10%', 'progress 100%', 'error: ✓', 'address in use']);
});

it('HIGH (TS review): a second start is refused and its sandbox folder is removed; a server that can\'t start says so to the caller; a stopped DevServers starts nothing', async () => {
  const dir = await temp(), dev = new DevServers({ error: vi.fn() }); servers.push(dev);
  const box = () => ({ prefix: [] as string[], env: {}, dispose: vi.fn(async () => {}) });
  await dev.start('a', { command: ['/bin/sleep', '30'], cwd: dir, port: 4190, sandbox: null, env: { PATH: '/usr/bin:/bin' } }, () => {});
  const second = box();
  await expect(dev.start('a', { command: ['/bin/sleep', '30'], cwd: dir, port: 4190, sandbox: second as never, env: { PATH: '/usr/bin:/bin' } }, () => {})).rejects.toThrow('already runs');
  expect(second.dispose).toHaveBeenCalled();
  await expect(dev.start('b', { command: ['/nonexistent/dev-server'], cwd: dir, port: 4191, sandbox: null, env: { PATH: '/usr/bin:/bin' } }, () => {})).rejects.toThrow("The dev server couldn't start");
  await dev.stopAll(); dev.close();
  await expect(dev.start('c', { command: ['/bin/sleep', '30'], cwd: dir, port: 4192, sandbox: null, env: { PATH: '/usr/bin:/bin' } }, () => {})).rejects.toThrow('AI Term is stopping');
});

it('MEDIUM (TS review): the card shows the dev server whatever the agent is doing', () => {
  const now = new Date().toISOString();
  const base = { id: randomUUID(), title: 'fixer', engine: 'codex', model: 'gpt', auth: { kind: 'account' }, cwd: '/w/a', worktree: '/w/a', branch: 'ai/fixer', permission: 'ask', statusDetail: '', statusSince: now, createdAt: now, lastOutputAt: now, exitCode: null, ctxPercent: null, lastActivity: null } as unknown as SessionInfo;
  for (const status of ['running', 'exited', 'waiting'] as const) expect(cardText({ ...base, status, statusDetail: status === 'waiting' ? 'question' : '', dev: { state: 'running', port: 4101 } }, Date.now(), 80).activity?.text, status).toContain('▶ dev :4101');
});

it('MEDIUM (TS review): the popup\'s lines come from shared code; a 60-character title of emoji validates', () => {
  expect(devLines({ title: 'fixer', command: ['npm', 'run', 'dev'], cwd: '/w', port: 4100, sandbox: true, fingerprint: 'a'.repeat(64), running: false, tail: [] })[1]?.text).toBe('$ npm run dev');
  expect(validateDevPlan({ title: '🚀'.repeat(60), command: ['npm'], cwd: '/w', port: 4100, sandbox: false, fingerprint: 'a'.repeat(64), running: false, tail: [] }).title).toHaveLength(120);
});

it('HIGH (security review): a tab in the server\'s output never breaks /dev; bidi and zero-width characters are dropped too', () => {
  let tail = emptyTail();
  tail = appendTail(tail, Buffer.from('Error: boom\n\tat main (server.js:1)\nsafe‮txt.exe​\n'));
  expect(tail.lines).toEqual(['Error: boom', '  at main (server.js:1)', 'safetxt.exe']);
  expect(validateDevPlan({ title: 'x', command: ['npm'], cwd: '/w', port: 4100, sandbox: true, fingerprint: 'a'.repeat(64), running: true, tail: tail.lines }).tail).toHaveLength(3);
});

it('MEDIUM (security review): a dev sandbox opens only its own port on 127.0.0.1, not every local service', async () => {
  const { sandboxProfile } = await import('../src/daemon/test-sandbox.js');
  const text = sandboxProfile({ worktree: '/w/a', temp: '/private/tmp/t', home: '/Users/me', private: [], loopback: true, ports: [4100] });
  expect(text).toContain('(local ip "localhost:4100")'); expect(text).toContain('(remote ip "localhost:4100")');
  expect(text).not.toContain('localhost:*');
});

it('MEDIUM (security review): without a sandbox the popup shows the script that runs and asks for a capital Y; the approval covers the script\'s files', async () => {
  const lines = devLines({ title: 'fixer', command: ['npm', 'run', 'dev'], cwd: '/w', port: 4100, sandbox: false, why: 'no sandbox: Windows has none AI Term can use', runs: 'vite --host', fingerprint: 'a'.repeat(64), running: false, tail: [] }).map(line => line.text);
  expect(lines).toContain('runs: vite --host');
  expect(lines.at(-1)).toBe('Y (capital) runs it without a sandbox · n or Esc starts nothing');
  const { DevAsk } = await import('../src/client/tui/dev-ask.js');
  const start = vi.fn();
  const ask = new DevAsk({ title: 'fixer', command: ['npm'], cwd: '/w', port: 4100, sandbox: false, fingerprint: 'a'.repeat(64), running: false, tail: [] }, () => {}, () => {}, start, () => {});
  ask.key('y'); expect(start).not.toHaveBeenCalled();
  ask.key('Y'); expect(start).toHaveBeenCalledTimes(1);
});
