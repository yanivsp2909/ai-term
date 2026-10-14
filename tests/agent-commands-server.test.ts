import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { DaemonServer } from '../src/daemon/server.js';
import { Connection } from '../src/client/connection.js';

it('retry, send and find round-trip over the socket with their fixed reasons', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-commands-socket-')), paths = getPaths(root); await preparePaths(paths);
  const log = new Logger(paths.log), m = new SessionManager(paths, log, { executable: '/bin/sh', args: ['-c', 'echo "find Me here"; read answer; echo "got $answer"; read again'], env: { PATH: '/usr/bin:/bin' } });
  const server = new DaemonServer(paths, m, log); let client: Connection | undefined;
  try {
    await m.load(); await server.listen(); client = await Connection.connect(paths, { entry: '/unused', autoStart: false });
    const live = await m.create({ cwd: root, title: 'shell one' });
    await expect.poll(async () => (await client?.request({ kind: 'sessions.find', text: 'FIND me' }))?.matches?.length).toBe(1);
    const found = await client.request({ kind: 'sessions.find', text: 'FIND me' });
    expect(found.matches?.[0]).toMatchObject({ sessionId: live.id, text: 'find Me here', start: 0, length: 7 }); expect(found.moreMatches).toBe(false);
    await expect(client.request({ kind: 'sessions.retry', sessionId: live.id })).rejects.toThrow('Retry needs a finished agent');
    await client.request({ kind: 'sessions.send', sessionId: live.id, text: 'yes' });
    await expect.poll(async () => (await client?.request({ kind: 'sessions.find', text: 'got yes' }))?.matches?.length).toBe(1);
    await m.stop(live.id);
    await expect(client.request({ kind: 'sessions.send', sessionId: live.id, text: 'late' })).rejects.toThrow('Agent has exited');
    const retried = await client.request({ kind: 'sessions.retry', sessionId: live.id });
    expect(retried.session).toMatchObject({ title: 'shell one', cwd: root }); expect(m.list().map(s => s.id)).toEqual([retried.session?.id]);
    expect(await import('node:fs/promises').then(fs => fs.readFile(paths.log, 'utf8'))).not.toContain('unexpected error');
  } finally { client?.close(); await server.close(); await m.shutdown(); await rm(root, { recursive: true, force: true }); }
});
