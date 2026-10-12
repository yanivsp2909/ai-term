import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir, lstat, readdir, symlink, truncate, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, readState } from '../src/daemon/store.js';
import { SettingsStore } from '../src/daemon/settings.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp() { const root = await mkdtemp(join(tmpdir(), 'ai-term-store-')); roots.push(root); return root; }
const temporaries = async (dir: string) => (await readdir(dir)).filter(name => name.endsWith('.tmp'));

describe('readState', () => {
  it('treats a missing file as no sessions', async () => {
    expect(await readState(join(await temp(), 'state.json'))).toEqual({ sessions: [] });
  });
  it('refuses a directory and a file over 16 MB', async () => {
    const root = await temp(), dir = join(root, 'state.json'), big = join(root, 'big.json');
    await mkdir(dir);
    await expect(readState(dir)).rejects.toThrow('Unsafe or oversized state file');
    await writeFile(big, '{"sessions":[]}', { mode: 0o600 });
    await truncate(big, 16 * 1024 * 1024 + 1);
    await expect(readState(big)).rejects.toThrow('Unsafe or oversized state file');
  });
  it('accepts a file of exactly 16 MB', async () => {
    const root = await temp(), path = join(root, 'state.json');
    const body = '{"sessions":[]}';
    await writeFile(path, body + ' '.repeat(16 * 1024 * 1024 - body.length), { mode: 0o600 });
    expect(await readState(path)).toEqual({ sessions: [] });
  });
  it('tightens a readable state file to 0600 when it loads it', async () => {
    const root = await temp(), path = join(root, 'state.json');
    await writeFile(path, '{"sessions":[]}'); await chmod(path, 0o644);
    await readState(path);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });
  it('surfaces malformed JSON instead of starting empty', async () => {
    const root = await temp(), path = join(root, 'state.json');
    await writeFile(path, '{"sessions":[', { mode: 0o600 });
    await expect(readState(path)).rejects.toThrow(SyntaxError);
  });
});

describe('atomicWrite', () => {
  it('leaves the old file and no temporary behind when the value cannot be serialized', async () => {
    const root = await temp(), path = join(root, 'state.json');
    await atomicWrite(path, { generation: 'old' });
    await expect(atomicWrite(path, { generation: 1n })).rejects.toThrow(TypeError);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ generation: 'old' });
    expect(await temporaries(root)).toEqual([]);
  });
  it('removes its temporary when the final rename fails', async () => {
    const root = await temp(), path = join(root, 'state.json');
    await mkdir(path); await writeFile(join(path, 'keep'), 'x');
    await expect(atomicWrite(path, { sessions: [] })).rejects.toMatchObject({ code: expect.stringMatching(/^(EISDIR|ENOTEMPTY|EEXIST)$/) });
    expect(await temporaries(root)).toEqual([]);
    expect(await readFile(join(path, 'keep'), 'utf8')).toBe('x');
  });
  it('replaces a symlink at the target instead of writing through it', async () => {
    const root = await temp(), outside = join(root, 'outside.json'), path = join(root, 'state.json');
    await writeFile(outside, 'untouched');
    await symlink(outside, path);
    await atomicWrite(path, { sessions: [] });
    expect(await readFile(outside, 'utf8')).toBe('untouched');
    expect((await lstat(path)).isSymbolicLink()).toBe(false);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });
  it('fails without creating anything when the folder is missing', async () => {
    const root = await temp();
    await expect(atomicWrite(join(root, 'missing', 'state.json'), {})).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(root)).toEqual([]);
  });
});

describe('SettingsStore', () => {
  it('refuses a settings path that is a directory or over 16 KiB', async () => {
    const root = await temp(), path = join(root, 'settings.json');
    await mkdir(path);
    await expect(new SettingsStore(root).get()).rejects.toThrow('Unsafe settings file');
    await rm(path, { recursive: true });
    await writeFile(path, JSON.stringify({ theme: 'ink', note: 'x'.repeat(16384) }), { mode: 0o600 });
    await expect(new SettingsStore(root).get()).rejects.toThrow('Unsafe settings file');
  });
  it('tightens a readable settings file to 0600 when it loads it', async () => {
    const root = await temp(), path = join(root, 'settings.json');
    await writeFile(path, '{"theme":"ink"}'); await chmod(path, 0o644);
    expect(await new SettingsStore(root).get()).toEqual({ theme: 'ink' });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });
  it('refuses an invalid patch before reading or writing anything', async () => {
    const root = await temp(), store = new SettingsStore(root);
    expect(() => store.set({ theme: 'neon' } as never)).toThrow('Invalid settings patch');
    expect(() => store.set({ secret: 'x' })).toThrow('Unknown settings patch field');
    expect(await readdir(root)).toEqual([]);
  });
  it('a failed write reaches its caller and does not block the next one', async () => {
    const root = await temp(), path = join(root, 'settings.json'), store = new SettingsStore(root);
    await mkdir(path);
    await expect(store.set({ theme: 'ink' })).rejects.toThrow('Unsafe settings file');
    await rm(path, { recursive: true });
    expect(await store.set({ theme: 'slate' })).toEqual({ theme: 'slate' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ theme: 'slate' });
  });
});
