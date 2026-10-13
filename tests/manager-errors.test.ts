import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { DaemonServer } from '../src/daemon/server.js';
import { Connection } from '../src/client/connection.js';
import { KeyError } from '../src/daemon/keys.js';

afterEach(() => vi.restoreAllMocks());
it('B16 exposes exact fixed manager reasons and never logs or returns raw causes', async () => {
  const root = await mkdtemp('/tmp/ai-b16-'), paths = getPaths(root); await preparePaths(paths);
  const log = new Logger(paths.log), manager = new SessionManager(paths, log), server = new DaemonServer(paths, manager, log);
  let client: Connection | undefined;
  try {
    await manager.load(); await server.listen(); client = await Connection.connect(paths, { entry: '/unused', autoStart: false });
    // The handler reads retained metadata before removing; the injected failure still belongs to remove().
    vi.spyOn(manager,'get').mockReturnValue({} as ReturnType<SessionManager['get']>);
    const remove = vi.spyOn(manager, 'remove');
    for (const text of ['Session not found', 'Only exited sessions can be removed', 'Resume needs a finished agent', 'Conversation already running', 'Session stop timed out']) {
      remove.mockRejectedValueOnce(new Error(text));
      await expect(client.request({ kind: 'sessions.remove', sessionId: randomUUID() })).rejects.toThrow(text);
    }
    for (const error of [new Error('Session not found AITERMCANARY'), new KeyError('AITERMCANARY'), new Error('AITERMCANARY')]) {
      remove.mockRejectedValueOnce(error);
      await expect(client.request({ kind: 'sessions.remove', sessionId: randomUUID() })).rejects.toThrow('Session operation failed');
    }
    expect(await readFile(paths.log, 'utf8')).not.toContain('AITERMCANARY');
  } finally { client?.close(); await server.close(); await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});
