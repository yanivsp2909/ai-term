import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink, writeFile } from 'node:fs/promises';
import type { Server } from 'node:net';
import { dirname, join } from 'node:path';
import { isFsError } from '../shared/paths.js';
import { isPipeName, pipeName } from '../shared/pipe.js';
import { currentSid } from '../shared/win-acl.js';
// v0.8.2 Windows: a named pipe's default ACL lets other users of the machine open it for reading, and Node can't set a
// tighter one. So the daemon answers nothing until a client's hello carries the token written, with the pipe's name, to
// run/daemon.pipe in the folder only you can read (its ACL). expected null: a Unix socket, whose 0600 mode is the check.
export function helloAllowed(given: unknown, expected: string | null): boolean {
  if (expected === null) return true;
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
export interface PipeInfo { name: string; token: string }
export const pipeFile = (socketPath: string): string => join(dirname(socketPath), 'daemon.pipe');
const isToken = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
// Binds a fresh pipe name (libuv creates it as the first instance, so a name someone already holds fails to bind and the
// daemon stops), then publishes its name and token in run/daemon.pipe, written whole under a temp name.
export async function listenPipe(server: Server, socketPath: string): Promise<PipeInfo> {
  const name = pipeName(await currentSid(), dirname(dirname(socketPath)), randomBytes(16).toString('hex')), token = randomBytes(32).toString('hex');
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(name, () => { server.off('error', reject); resolve(); }); });
  const file = pipeFile(socketPath), temp = `${file}.${randomBytes(4).toString('hex')}`;
  try { await writeFile(temp, JSON.stringify({ name, token }), { flag: 'wx', mode: 0o600 }); await rename(temp, file); }
  catch (error) {
    await unlink(temp).catch((cleanup: unknown) => { if (!isFsError(cleanup, 'ENOENT')) throw cleanup; });
    await new Promise<void>(resolve => server.close(() => resolve())); throw error;
  }
  return { name, token };
}
// The client's side: the pipe to dial and the token to show. A missing file reads as ENOENT (no daemon yet).
export async function readPipe(socketPath: string): Promise<PipeInfo> {
  const file = await open(pipeFile(socketPath), constants.O_RDONLY);
  try {
    const info = await file.stat(); if (!info.isFile() || info.size > 1024) throw new Error('Unsafe daemon pipe file');
    const value: unknown = JSON.parse(await file.readFile('utf8'));
    if (!value || typeof value !== 'object' || !('name' in value) || !isPipeName(value.name) || !('token' in value) || !isToken(value.token)) throw new Error('Unsafe daemon pipe file');
    return { name: value.name, token: value.token };
  } finally { await file.close(); }
}
// Closes the server and removes run/daemon.pipe only while it still names this pipe (never a newer daemon's).
export async function closePipe(server: Server, socketPath: string, info: PipeInfo | undefined): Promise<void> {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!info) return;
  try { if ((await readPipe(socketPath)).name === info.name) await unlink(pipeFile(socketPath)); }
  catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
}
// The daemon's half of the hello: HMAC-SHA256(token, the client's nonce). Only the daemon that wrote the token can make it;
// a squatter on a stale pipe name (pipe names can be listed) can't (security review).
export function helloProof(token: string, nonce: string): string { return createHmac('sha256', token).update(nonce).digest('hex'); }
export function proofValid(token: string, nonce: string, proof: unknown): boolean {
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false;
  return timingSafeEqual(Buffer.from(proof), Buffer.from(helloProof(token, nonce)));
}
// run/daemon.pipe of a daemon known to be gone: removed, so its old name leads nowhere.
export async function removeStalePipe(socketPath: string): Promise<void> {
  try { await unlink(pipeFile(socketPath)); } catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
}
