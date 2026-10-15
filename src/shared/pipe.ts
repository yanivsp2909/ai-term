import { createHash } from 'node:crypto';
// v0.8.2 Windows: the daemon listens on a named pipe instead of a Unix socket. The name holds a hash of your SID and AI
// Term's folder (so two users, or two AI_TERM_HOMEs, never meet) and a fresh random part per daemon start, written to
// run/daemon.pipe in the folder only you can read: nobody else can learn it, so nobody can be first to create it. libuv
// creates the pipe with FILE_FLAG_FIRST_PIPE_INSTANCE, so a name that already exists fails to bind and the daemon stops.
export function pipeName(sid: string, root: string, random: string): string {
  if (!/^[0-9a-f]{32}$/.test(random)) throw new Error('Invalid pipe name');
  return `\\\\.\\pipe\\ai-term-${createHash('sha256').update(`${sid}\0${root}`).digest('hex').slice(0, 16)}-${random}`;
}
export const isPipeName = (value: unknown): value is string => typeof value === 'string' && /^\\\\\.\\pipe\\ai-term-[0-9a-f]{16}-[0-9a-f]{32}$/.test(value);
