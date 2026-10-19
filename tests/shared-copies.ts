import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Part C: a build may leave shared add-on copies out (the public snapshot drops every copy whose source license doesn't
// allow sharing) and lists them, one path per line, in addons/_shared/LEFT_OUT.txt. A listed copy must be gone; every
// other copy must be there and name its source, license and changes.
export async function checkSharedCopy(definitions: string, asset: string): Promise<void> {
  let listed: string[] = [];
  try { listed = (await readFile(join(definitions, '_shared', 'LEFT_OUT.txt'), 'utf8')).split('\n').map(line => line.trim()).filter(Boolean); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  const full = join(definitions, '_shared', asset);
  if (listed.includes(asset)) { await lstat(full).then(() => { throw new Error(`${asset} is listed as left out but is there`); }, (error: unknown) => { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }); return; }
  const body = await readFile(full, 'utf8');
  if (!/\nSource: .+\nLicense: .+\nWhat changed: .+\n/.test(body)) throw new Error(`${asset} doesn't name its source, license and changes`);
}
