import { cp, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Part C: a build may leave shared add-on copies out (the public snapshot drops every copy whose source license doesn't
// allow sharing) and lists them, one path per line, in addons/_shared/LEFT_OUT.txt. A listed copy must be gone; every
// other copy must be there and name its source, license and changes.
const isMissing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
export async function leftOutCopies(definitions: string): Promise<string[]> {
  try { return (await readFile(join(definitions, '_shared', 'LEFT_OUT.txt'), 'utf8')).split('\n').map(line => line.trim()).filter(Boolean); }
  catch (error) { if (isMissing(error)) return []; throw error; }
}
export async function checkSharedCopy(definitions: string, asset: string): Promise<void> {
  const full = join(definitions, '_shared', asset);
  if ((await leftOutCopies(definitions)).includes(asset)) { await lstat(full).then(() => { throw new Error(`${asset} is listed as left out but is there`); }, (error: unknown) => { if (!isMissing(error)) throw error; }); return; }
  const body = await readFile(full, 'utf8');
  if (!/\nSource: .+\nLicense: .+\nWhat changed: .+\n/.test(body)) throw new Error(`${asset} doesn't name its source, license and changes`);
}
// Tests of the add-on machinery (bundles, prompts) need every guide an add-on names. Where this build leaves some out,
// they run on a temp copy of addons/ with a short stand-in for each one; with nothing left out, on addons/ itself.
// root: the temp folder to remove afterwards, or null.
export async function testDefinitions(definitions: string): Promise<{ path: string; root: string | null }> {
  const listed = await leftOutCopies(definitions);
  if (!listed.length) return { path: definitions, root: null };
  const root = await mkdtemp(join(tmpdir(), 'ai-addons-')), path = join(root, 'addons');
  await cp(definitions, path, { recursive: true });
  for (const asset of listed) {
    await mkdir(dirname(join(path, '_shared', asset)), { recursive: true });
    const name = asset.replace(/^skills\/|^agents\/|\/SKILL\.md$|\.md$/g, '');
    await writeFile(join(path, '_shared', asset), `---\nname: ${name}\ndescription: A stand-in for a guide this build leaves out.\n---\nSource: a test stand-in.\nLicense: MIT (test stand-in).\nWhat changed: everything; the real guide is not in this build.\n`);
  }
  return { path: `${path}/`, root };
}
