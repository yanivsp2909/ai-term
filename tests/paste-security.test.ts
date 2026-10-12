import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import pty from 'node-pty';
import { Homepage } from '../src/client/tui/homepage.js';
import { Connection } from '../src/client/connection.js';
import { DaemonServer } from '../src/daemon/server.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { Logger } from '../src/daemon/log.js';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import * as engines from '../src/daemon/engines.js';

class TTY extends EventEmitter {
  isTTY = true; isRaw = false; columns = 130; rows = 45; output = '';
  setRawMode(value: boolean) { this.isRaw = value; } resume() {} pause() {}
  write(value: string | Buffer) { this.output += value.toString(); return true; }
}
async function fileContents(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await fileContents(path));
    else if (entry.isFile()) files.push(await readFile(path, 'utf8'));
  }
  return files;
}
it.each(['claude-code', 'codex'] as const)('%s local stub receives pasted canary intact; drafts, copy text and first message stay off disk/logs/responses', async engine => {
  const root = await mkdtemp('/tmp/ai-paste-safe-'), paths = getPaths(join(root, 'home'));
  await preparePaths(paths);
  // The stub contains no canary and reports only a digest, so the test can check argv without echoing the prompt.
  const executable = join(root, 'stub-agent.cjs');
  await writeFile(executable, '#!/usr/bin/env node\nconst {createHash}=require("node:crypto");\nconst args=process.argv.slice(2);\nconst message=args[args.indexOf("--")+1];\nprocess.stdout.write("MESSAGE_DIGEST:"+createHash("sha256").update(message).digest("hex"));\nprocess.stdin.resume();\n', { mode: 0o700 });
  const status = vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: executable, version: '1.0.0', loggedIn: true, authMethod: 'subscription' });
  const manager = new SessionManager(paths, new Logger(paths.log)), server = new DaemonServer(paths, manager, new Logger(paths.log));
  const canary = ['PASTE', 'CANARY', randomUUID()].join(':'), message = 'safe intro\r\n\t' + 'x'.repeat(4500) + '\n' + canary + ' "quoted" \\slash 界🙂';
  const events: unknown[] = [], responses: unknown[] = [], copied: string[] = [], logs: string[] = [], tty = new TTY();
  let client: Connection | undefined, home: Homepage | undefined;
  try {
    await manager.load(); await server.listen(); client = await Connection.connect(paths, { entry: '/unused', autoStart: false });
    client.on('event', event => events.push(event));
    const request = client.request.bind(client);
    client.request = async body => { const response = await request(body); responses.push(response); return response; };
    await client.request({ kind: 'settings.set', patch: { defaultEngine: engine } });
    home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: root, copy: async text => { copied.push(text); }, copyLog: { error: text => logs.push(text) } });
    await home.start();
    const data = Buffer.from('\x1b[200~' + message + '\x1b[201~\r');
    for (let i = 0; i < data.length; i += 113) tty.emit('data', data.subarray(i, i + 113));
    await expect.poll(() => tty.output.includes('safe intro')).toBe(true); tty.emit('data', Buffer.from('\r'));
    // B10: waits on a real node process; a loaded machine can take over the default 1 s to start it.
    await expect.poll(() => manager.list()[0]?.status, { timeout: 10000 }).toBe('running');
    const id = manager.list()[0]?.id; if (!id) throw new Error('Stub agent missing');
    const expected = 'MESSAGE_DIGEST:' + createHash('sha256').update(message).digest('hex');
    // running starts at the first output chunk; the digest line may still be arriving.
    await expect.poll(async () => (await client?.request({ kind: 'sessions.text', sessionId: id }))?.copy?.text, { timeout: 10000 }).toBe(expected);
    tty.emit('data', Buffer.from('c')); await expect.poll(() => copied.length).toBe(1); expect(copied[0]).toBe(expected);
    await manager.stop(id);
    expect(tty.output.includes(canary)).toBe(false); expect(logs).toEqual([]);
    expect(JSON.stringify([...responses, ...events]).includes(canary)).toBe(false);
    expect((await fileContents(root)).some(text => text.includes(canary))).toBe(false);
  } finally { await home?.stop(); client?.close(); await server.close(); await manager.shutdown(); status.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
it('a PTY failure containing first-message text cannot leak that text through the account-session log', async () => {
  const root = await mkdtemp('/tmp/ai-paste-failure-'), paths = getPaths(root); await preparePaths(paths);
  const status = vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/stub/claude', version: '1.0.0', loggedIn: true, authMethod: 'subscription' });
  const canary = ['PASTE', 'CANARY', randomUUID()].join(':'), spawn = vi.spyOn(pty, 'spawn').mockImplementation(() => { throw new Error('spawn argv: ' + canary); });
  const manager = new SessionManager(paths, new Logger(paths.log));
  try {
    await manager.load();
    const result = await manager.create({ engine: 'claude-code', model: null, auth: { kind: 'account' }, permission: 'ask', cwd: root, firstMessage: canary });
    expect(result.status).toBe('error'); expect(JSON.stringify(result).includes(canary)).toBe(false);
    expect((await fileContents(root)).some(text => text.includes(canary))).toBe(false);
    expect(await readFile(paths.log, 'utf8')).toContain('PTY spawn failed');
  } finally { await manager.shutdown(); status.mockRestore(); spawn.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
