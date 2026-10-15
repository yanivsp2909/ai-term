import { posix, win32 } from 'node:path';
// Whether path is root or lies inside it. Windows (v0.8.2): NTFS ignores case and takes either slash, so both are folded
// first (review: c:/users/… must still read as inside C:\Users\…).
export function pathInside(root: string, path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`) && posix.isAbsolute(path);
  const fold = (value: string) => win32.normalize(value).replace(/\\+$/, '').toLowerCase();
  const a = fold(root), b = fold(path);
  return b === a || b.startsWith(`${a}\\`);
}
