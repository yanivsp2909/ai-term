import { beforeEach, vi } from 'vitest';
import pty from 'node-pty';
import * as engines from '../../src/daemon/engines.js';
// Tests that start a Codex or Claude Code agent only for its worktree: the CLI is a shell that waits, so neither the real
// CLI nor its login is needed (before v0.8's CI these tests quietly started the real Codex installed on this Mac).
export function useFakeEngines(): void {
  beforeEach(() => {
    const real = pty.spawn;
    vi.spyOn(pty, 'spawn').mockImplementation((file, args, options) => file === '/bin/sh' ? real('/bin/sh', ['-c', 'sleep 300'], { ...options, env: { PATH: '/usr/bin:/bin' } }) : real(file, args, options));
    vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' });
  });
}
