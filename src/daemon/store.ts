import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, basename } from 'node:path';
import { isFsError } from '../shared/paths.js';
export async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); }
  catch (error) { await file.close(); await unlink(temporary); throw error; }
  await file.close();
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary); throw error; }
  const folder = await open(dirname(path), constants.O_RDONLY);
  try { await folder.sync(); } finally { await folder.close(); }
}
export async function readState(path: string): Promise<unknown> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (isFsError(error, 'ENOENT')) return { sessions: [] }; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > 16 * 1024 * 1024) throw new Error('Unsafe or oversized state file');
    await file.chmod(0o600);
    return JSON.parse(await file.readFile('utf8')) as unknown;
  } finally { await file.close(); }
}
