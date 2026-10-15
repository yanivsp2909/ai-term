import { createHash } from 'node:crypto';
// v0.8.2 Windows: the daemon listens on a named pipe instead of a Unix socket. The name holds a hash of your SID and AI
// Term's folder (two users, or two AI_TERM_HOMEs, never meet) and a fresh random part per daemon start. Pipe names can be
// listed by anyone, so the name is no secret: libuv creates it as the first instance (an existing name fails to bind and
// the daemon stops), the client must show the token from run/daemon.pipe, and the daemon must prove it knows that token
// before the client sends anything (pipe-server.ts helloProof). A stale run/daemon.pipe is removed once its daemon is gone.
export function pipeName(sid: string, root: string, random: string): string {
  if (!/^[0-9a-f]{32}$/.test(random)) throw new Error('Invalid pipe name');
  return `\\\\.\\pipe\\ai-term-${createHash('sha256').update(`${sid}\0${root}`).digest('hex').slice(0, 16)}-${random}`;
}
export const isPipeName = (value: unknown): value is string => typeof value === 'string' && /^\\\\\.\\pipe\\ai-term-[0-9a-f]{16}-[0-9a-f]{32}$/.test(value);
