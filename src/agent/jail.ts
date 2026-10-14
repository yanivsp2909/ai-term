import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isFsError } from '../shared/paths.js';

// A tool path the agent's folder doesn't contain. The text goes back to the model, so it names no path.
export class JailError extends Error { constructor() { super('Path is outside the folder'); } }
const MAX_PATH = 4096;

export function inside(root: string, path: string): boolean { return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep); }

// Resolves a tool path (relative to the folder, or absolute) to the real path it names, which must lie inside `root`
// (itself a real path). `..` is folded first; then the deepest part that exists is resolved through every symlink, so a
// link anywhere on the way that leads out is refused, including one in front of a file that doesn't exist yet.
// The callers open the returned path with O_NOFOLLOW, so a last component swapped for a symlink afterwards fails too.
export async function resolveInside(root: string, path: string): Promise<string> {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.length > MAX_PATH) throw new JailError();
  const wanted = isAbsolute(path) ? resolve(path) : resolve(root, path);
  let existing = wanted;
  const missing: string[] = [];
  for (;;) {
    try { await lstat(existing); break; }
    catch (error) {
      if (!isFsError(error, 'ENOENT') && !isFsError(error, 'ENOTDIR')) throw error;
      const parent = dirname(existing);
      if (parent === existing) throw new JailError();
      missing.unshift(relative(parent, existing)); existing = parent;
    }
  }
  let resolved: string;
  // A dangling symlink can't be checked against the folder, so it is refused like one that leads out.
  try { resolved = await realpath(existing); } catch (error) { if (isFsError(error, 'ENOENT') || isFsError(error, 'ELOOP')) throw new JailError(); throw error; }
  const real = join(resolved, ...missing);
  if (!inside(root, real)) throw new JailError();
  return real;
}
