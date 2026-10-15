import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isFsError } from '../shared/paths.js';

// v0.7.1 /export writes one file, only when you ask: into ~/Downloads, or the folder you name (a full path or ~/…).
// It never replaces a file: a name that exists gets -2, -3…; the file is created 0600 and never through a symlink.
export class ExportError extends Error {}
const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';
const two = (n: number) => String(n).padStart(2, '0');
export async function saveExport(html: string, options: { title: string; now: Date; home: string; folder?: string }): Promise<string> {
  const asked = options.folder ?? join(options.home, 'Downloads');
  if (!(isAbsolute(asked) || asked === '~' || asked.startsWith('~/')) || asked.includes('\0')) throw new ExportError('Export folder must be a full path or start with ~');
  const expanded = asked.startsWith('~') ? join(options.home, asked.slice(1)) : asked;
  let folder: string;
  try { folder = await realpath(resolve(expanded)); if (!(await stat(folder)).isDirectory()) throw new ExportError('Export folder is not a folder'); }
  catch (error) { if (error instanceof ExportError) throw error; if (isFsError(error, 'ENOENT')) throw new ExportError('Export folder not found'); if (isFsError(error, 'ENOTDIR')) throw new ExportError('Export folder is not a folder'); throw new ExportError('Export folder can\'t be read'); }
  const d = options.now, base = `ai-term-${slug(options.title)}-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
  for (let n = 1; n < 100; n++) {
    const path = join(folder, `${base}${n > 1 ? `-${n}` : ''}.html`);
    let file;
    try { file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (isFsError(error, 'EEXIST')) continue; throw new ExportError('Export could not be saved'); }
    try { await file.writeFile(html, 'utf8'); } catch { await file.close(); throw new ExportError('Export could not be saved'); }
    await file.close();
    return path;
  }
  throw new ExportError('Export could not be saved; too many exports with this name');
}
