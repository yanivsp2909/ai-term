import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { inside } from './jail.js';
import type { Instructions } from './instructions.js';

export function isAddonBundle(path: string): boolean { return path.length <= 4096 && /^(?:\/|[A-Za-z]:[\\/])/.test(path) && /[\\/]addons[\\/][a-f0-9]{64}$/.test(path) && !/[\p{C}]/u.test(path); }
// Shared with the daemon: no executable imports, no links outside the package, and a small text-only payload.
export async function addonFile(root: string, relative: string, cap = 16000): Promise<string> {
  const base = await realpath(root), full = join(base, relative);
  if (!inside(base, full) || await realpath(dirname(full)) !== dirname(full)) throw new Error('Unsafe add-on file');
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW);
  const file = await open(full, flags);
  try { const stat = await file.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size > cap) throw new Error('Unsafe add-on file'); const data = await file.readFile(); if (data.length > cap || data.includes(0)) throw new Error('Unsafe add-on file'); return data.toString('utf8'); }
  finally { await file.close(); }
}
export async function withAddon(instructions: Instructions, bundle: string): Promise<Instructions> {
  if (!isAddonBundle(bundle)) throw new Error('Invalid add-on bundle');
  const raw: unknown = JSON.parse(await addonFile(bundle, 'instructions.json'));
  if (!Array.isArray(raw) || raw.length > 20 || !raw.every(p => typeof p === 'string' && /^(?:skills\/[a-z][a-z0-9-]*\/SKILL|agents\/[a-z][a-z0-9-]*)\.md$/.test(p))) throw new Error('Invalid add-on instructions');
  const bodies = await Promise.all(raw.map(p => addonFile(bundle, p)));
  const files=raw.map((path,i)=>({path,text:bodies[i]}));
  if(createHash('sha256').update(JSON.stringify(files)).digest('hex')!==basename(bundle))throw new Error('Add-on bundle changed');
  if (bodies.reduce((n, s) => n + Buffer.byteLength(s), 0) > 64000) throw new Error('Add-on instructions too large');
  return { ...instructions, text: `${instructions.text}\n\n# Bundled add-on skills and roles\n${bodies.join('\n\n')}`, files: [...instructions.files, ...raw] };
}
