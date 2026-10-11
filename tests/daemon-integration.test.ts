import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, lstat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { FrameDecoder, encodeControl, decodeControl, MAX_FRAME_BYTES } from '../src/shared/protocol.js';
import { Connection } from '../src/client/connection.js';
import { getPaths } from '../src/shared/paths.js';
const children: ChildProcess[] = [];
const roots: string[] = [];
afterEach(async () => {
    for (const child of children.splice(0))
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            await new Promise<void>(r => child.once('exit', () => r()));
        }
    for (const root of roots.splice(0))
        await rm(root, { recursive: true, force: true });
});
const entry = resolve('src/cli/index.ts');
function run(root: string, args: string[]) { const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args], { env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', SHELL: '/bin/sh', AI_TERM_HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); return child; }
async function wait(child: ChildProcess) { let out = '', err = ''; child.stdout?.on('data', d => out += String(d)); child.stderr?.on('data', d => err += String(d)); const code = await new Promise<number | null>(r => child.once('exit', r)); return { code, out, err }; }
async function temp() { const root = await mkdtemp(join(tmpdir(), 'ai-term-int-')); roots.push(root); return root; }
async function raw(path: string): Promise<Socket> { const socket = createConnection(path); await new Promise<void>((r, j) => { socket.once('connect', r); socket.once('error', j); }); return socket; }
it('survives malformed clients, runs shell previews, and removes pid/socket on daemon stop', async () => {
    const root = await temp(), paths = getPaths(root);
    run(root, ['daemon']);
    await expect.poll(async () => { try {
        await lstat(paths.socket);
        return true;
    }
    catch {
        return false;
    } }, { timeout: 5000 }).toBe(true);
    const client = await Connection.connect(paths, { entry, autoStart: false });
    try {
        const created = await client.request({ kind: 'sessions.create', engine: 'shell', cwd: root });
        expect(created.session?.engine).toBe('shell');
        const id = created.session?.id;
        if (!id)
            throw new Error('Missing session');
        const listed = await client.request({ kind: 'sessions.list' });
        expect(listed.sessions?.some(s => s.id === id)).toBe(true);
        const preview = await client.request({ kind: 'sessions.preview', sessionId: id });
        expect(typeof preview.snapshot).toBe('string');
        await client.request({ kind: 'layout.previewSize', cols: 40, rows: 12 });
        expect((await client.request({ kind: 'sessions.rename', sessionId: id, title: 'renamed' })).session?.title).toBe('renamed');
        for (const data of [Buffer.from([0, 0, 0, 2, 1, 123]), encodeControl({ id: randomUUID(), kind: 'unknown' }), encodeControl({ id: randomUUID(), kind: 'layout.previewSize', cols: 1001, rows: 0 })]) {
            const socket = await raw(paths.socket);
            const decoder = new FrameDecoder();
            const reply = new Promise<unknown>(r => socket.on('data', d => { for (const frame of decoder.push(d))
                r(decodeControl(frame)); }));
            socket.write(data);
            expect(await reply).toMatchObject({ ok: false });
            socket.destroy();
        }
        const socket = await raw(paths.socket);
        const header = Buffer.alloc(4);
        header.writeUInt32BE(MAX_FRAME_BYTES + 1);
        socket.resume();
        socket.write(header);
        await new Promise<void>(r => socket.on('close', () => r()));
        const wrong = await raw(paths.socket);
        const decoder = new FrameDecoder();
        const mismatch = new Promise<unknown>(r => wrong.on('data', d => { for (const f of decoder.push(d))
            r(decodeControl(f)); }));
        wrong.write(encodeControl({ id: randomUUID(), kind: 'hello', protocol: 999, version: '0.1.1' }));
        expect(await mismatch).toMatchObject({ kind: 'helloMismatch', protocol: 1 });
        wrong.destroy();
        expect((await client.request({ kind: 'sessions.list' })).sessions).toHaveLength(1);
        await client.request({ kind: 'sessions.stop', sessionId: id });
        await expect.poll(async () => (await client.request({ kind: 'sessions.list' })).sessions?.[0]?.status, { timeout: 5000 }).not.toBe('running');
        await client.request({ kind: 'sessions.remove', sessionId: id });
        expect((await client.request({ kind: 'sessions.list' })).sessions).toEqual([]);
    }
    finally {
        client.close();
    }
    const stopped = await wait(run(root, ['daemon', 'stop']));
    expect(stopped.code).toBe(0);
    await expect.poll(async () => { try {
        await lstat(paths.socket);
        return false;
    }
    catch {
        return true;
    } }, { timeout: 5000 }).toBe(true);
    await expect(lstat(paths.pid)).rejects.toMatchObject({ code: 'ENOENT' });
}, 15000);
it('rejects a second daemon and recovers a stale lock', async () => {
    const root = await temp(), paths = getPaths(root);
    const first = run(root, ['daemon']);
    await expect.poll(async () => { try {
        await lstat(paths.socket);
        return true;
    }
    catch {
        return false;
    } }, { timeout: 5000 }).toBe(true);
    expect((await wait(run(root, ['daemon']))).code).toBe(1);
    first.kill('SIGTERM');
    await new Promise<void>(r => first.once('exit', () => r()));
    await writeFile(paths.pid, '2147483647\n', { mode: 0o600 });
    run(root, ['daemon']);
    await expect.poll(async () => { try {
        return (await lstat(paths.socket)).isSocket();
    }
    catch {
        return false;
    } }, { timeout: 5000 }).toBe(true);
    expect((await wait(run(root, ['daemon', 'stop']))).code).toBe(0);
}, 15000);
