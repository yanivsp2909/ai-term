import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import pty from 'node-pty';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { UsageService } from '../src/daemon/usage-service.js';
import * as engines from '../src/daemon/engines.js';
import { cleanSendText, isSendText, validateRequest } from '../src/shared/validate.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
// A Claude agent on a stub PTY: `output` feeds its mirror, `writes` is what reached the PTY, `status` posts a hook body.
async function agent() {
  const root = await mkdtemp('/tmp/ai-send-'), paths = getPaths(root); await preparePaths(paths);
  const log = new Logger(paths.log), usage = new UsageService(root, log), m = new SessionManager(paths, log, undefined, undefined, undefined, undefined, usage, resolve('src/cli/index.ts'));
  const writes: string[] = [], exits: ((e: { exitCode: number }) => void)[] = []; let env: NodeJS.ProcessEnv = {}, output: (text: string) => void = () => {};
  vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/stub', version: '1', loggedIn: true, authMethod: 'subscription' });
  vi.spyOn(pty, 'spawn').mockImplementation((_file, _args, options) => { env = { ...options?.env }; return { pid: 900002, onData: (cb: (text: string) => void) => { output = cb; return { dispose() {} }; }, onExit: (cb: (e: { exitCode: number }) => void) => { exits.push(cb); return { dispose() {} }; }, write: (data: string) => { writes.push(data); }, resize() {}, pause() {}, resume() {} } as unknown as pty.IPty; });
  vi.spyOn(process, 'kill').mockImplementation(() => { for (const exit of exits) exit({ exitCode: 0 }); return true; });
  cleanups.push(async () => { await m.shutdown(); await usage.close(); await rm(root, { recursive: true, force: true }); });
  await usage.start(); await m.load();
  const session = await m.create({ engine: 'claude-code', model: 'sonnet', auth: { kind: 'account' }, cwd: root, permission: 'ask', title: 'alpha' });
  const feed = async (text: string) => { output(text); await m.snapshot(session.id); };
  const status = async (body: unknown) => { await fetch(`http://127.0.0.1:${env.AITERM_STATUS_PORT}/v1/status/claude`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ai-term-session': env.AITERM_STATUS_TOKEN ?? '' }, body: JSON.stringify(body) }); };
  return { m, session, writes, feed, status, exit: () => { for (const e of exits) e({ exitCode: 0 }); } };
}

it('multi-line /send arrives as one bracketed paste, then Enter as its own write', async () => {
  const { m, session, writes, feed, status } = await agent();
  await feed('\x1b[?2004hready'); await status({ hook_event_name: 'AITermContext', used_percentage: 3 });
  await m.send(session.id, 'first line\nsecond line\n  indented');
  expect(writes).toEqual(['\x1b[200~first line\nsecond line\n  indented\x1b[201~', '\r']);
});

it('refuses while the agent asks for permission or a question, and sends nothing', async () => {
  const { m, session, writes, feed, status } = await agent();
  await feed('\x1b[?2004hready'); await status({ hook_event_name: 'AITermContext', used_percentage: 3 });
  await status({ hook_event_name: 'PermissionRequest' }); expect(m.get(session.id).status).toBe('waiting');
  await expect(m.send(session.id, '1')).rejects.toThrow('Agent is asking for permission');
  await status({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  await status({ hook_event_name: 'Notification', notification_type: 'elicitation_dialog' });
  await expect(m.send(session.id, 'y')).rejects.toThrow('Agent is asking a question');
  expect(writes).toEqual([]);
});

it('refuses an agent that has not reported status yet (it may be at its folder-trust prompt)', async () => {
  const { m, session, writes, feed } = await agent();
  await feed('\x1b[?2004hDo you trust the files in this folder? 1. Yes 2. No');
  await expect(m.send(session.id, 'hello')).rejects.toThrow('Agent has not reported its status yet');
  expect(writes).toEqual([]);
});

it('refuses an attached agent (a session or split someone is typing in) and an exited one', async () => {
  const { m, session, writes, feed, status, exit } = await agent();
  await feed('\x1b[?2004hready'); await status({ hook_event_name: 'AITermContext', used_percentage: 3 });
  await m.attach(session.id, 80, 24, () => {});
  await expect(m.send(session.id, 'hello')).rejects.toThrow('Agent is open in a session');
  await m.detach(session.id, () => true);
  exit(); await m.snapshot(session.id);
  await expect(m.send(session.id, 'hello')).rejects.toThrow('Agent has exited');
  expect(writes).toEqual([]);
});

it('an Enter is not sent when a permission prompt appears between the paste and Enter', async () => {
  const { m, session, writes, feed, status } = await agent();
  await feed('\x1b[?2004hready'); await status({ hook_event_name: 'AITermContext', used_percentage: 3 });
  SessionManager.sendEnterDelayMs = 1000; cleanups.push(async () => { SessionManager.sendEnterDelayMs = 50; });
  const sending = m.send(session.id, 'do it');
  await status({ hook_event_name: 'PermissionRequest' });
  await expect(sending).rejects.toThrow('Text pasted but not sent; go inside');
  expect(writes).toEqual(['\x1b[200~do it\x1b[201~']);
});

it('without bracketed paste only one line may go; kitty flag 8 makes Enter CSI 13 u', async () => {
  const { m, session, writes, feed, status } = await agent();
  await feed('ready'); await status({ hook_event_name: 'AITermContext', used_percentage: 3 });
  await expect(m.send(session.id, 'one\ntwo')).rejects.toThrow('Agent does not accept pasted lines');
  await m.send(session.id, 'one line');
  await feed('\x1b[>9u');
  await m.send(session.id, 'again');
  expect(writes).toEqual(['one line', '\r', 'again', '\x1b[13u']);
});

it('text is capped at 16 KB and stripped of controls except newlines; the daemon rejects anything else', async () => {
  expect(cleanSendText('a\tb\r\nc\x1b[201~\x07d\re\u0085')).toBe('ab\nc[201~d\ne');
  expect(isSendText('x'.repeat(16 * 1024))).toBe(true); expect(isSendText('x'.repeat(16 * 1024 + 1))).toBe(false);
  for (const bad of ['', '   \n', 'a\x1b[201~b', 'a\rb', 'tab\there', 'bell\x07']) expect(isSendText(bad)).toBe(false);
  await expect(validateRequest({ id: crypto.randomUUID(), kind: 'sessions.send', sessionId: crypto.randomUUID(), text: 'x\x1b' })).rejects.toThrow('Invalid send request');
  await expect(validateRequest({ id: crypto.randomUUID(), kind: 'sessions.send', sessionId: crypto.randomUUID(), text: 'ok', extra: 1 })).rejects.toThrow('Unexpected request field');
  expect(await validateRequest({ id: crypto.randomUUID(), kind: 'sessions.send', sessionId: '0b0f43a2-8f5e-4d2c-9a7b-1c2d3e4f5a6b', text: 'two\nlines' })).toMatchObject({ kind: 'sessions.send' });
});
