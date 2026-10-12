import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, lstat, symlink, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { validateRequest } from '../src/shared/validate.js';
import { atomicWrite, readState } from '../src/daemon/store.js';
import { Logger, redact } from '../src/daemon/log.js';
import { acquireLock } from '../src/daemon/lock.js';
import { buildShellEnv } from '../src/daemon/env.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { PtyHost } from '../src/daemon/pty-host.js';
import { ReplyBudget, REPLY_BURST_BYTES, REPLY_BYTES_PER_SECOND } from '../src/daemon/reply-budget.js';
const roots: string[] = [];
async function temp() { const root = await mkdtemp(join(tmpdir(), 'ai-term-core-')); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true }); });
const id = randomUUID();
const sessionId = randomUUID();
describe('request validators', () => {
    it('validates every supported message and rejects unimplemented commands', async () => {
        const cwd = await temp();
        for (const request of [
            { id, kind: 'hello', protocol: 1, version: '0.1.1' }, { id, kind: 'sessions.list' },
            { id, kind: 'sessions.create', engine: 'shell', cwd }, { id, kind: 'sessions.preview', sessionId },
            { id, kind: 'sessions.preview', sessionId: null }, { id, kind: 'sessions.stop', sessionId },
            { id, kind: 'sessions.remove', sessionId }, { id, kind: 'sessions.rename', sessionId, title: 'new title' },
            { id, kind: 'layout.previewSize', cols: 2, rows: 500 },
        ])
            expect(await validateRequest(request)).toEqual(request);
        for (const request of [null, {}, { id, kind: 'sessions.attach', sessionId },
            { id, kind: 'sessions.create', engine: 'codex', cwd }, { id, kind: 'sessions.create', engine: 'shell', cwd: 'relative' },
            { id, kind: 'sessions.create', engine: 'shell', cwd: '/nonexistent-ai-term-dir' },
            { id, kind: 'sessions.rename', sessionId, title: '\x1b[31m' },
            { id, kind: 'sessions.rename', sessionId: '-bad', title: 'ok' },
            { id, kind: 'layout.previewSize', cols: 1001, rows: 30 }, { id, kind: 'layout.previewSize', cols: 2, rows: 0 },
            { id, kind: 'sessions.list', unexpected: 'secret' },
        ])
            await expect(validateRequest(request)).rejects.toThrow();
    });
});
describe('private filesystem and store', () => {
    it('creates private directories/files and refuses symlinked root/run', async () => {
        const root = await temp(), paths = getPaths(root);
        await preparePaths(paths);
        expect((await lstat(paths.root)).mode & 0o777).toBe(0o700);
        expect((await lstat(paths.run)).mode & 0o777).toBe(0o700);
        const link = join(await temp(), 'link');
        await symlink(root, link);
        await expect(preparePaths(getPaths(link))).rejects.toThrow();
        const other = await temp();
        await symlink(paths.run, join(other, 'run'));
        await expect(preparePaths(getPaths(other))).rejects.toThrow();
    });
    it('writes atomically and keeps 0600 while readers see complete old/new content', async () => {
        const paths = getPaths(await temp());
        await preparePaths(paths);
        const old = { sessions: [], generation: 'old' }, next = { sessions: [], generation: 'new', data: 'x'.repeat(100000) };
        await atomicWrite(paths.state, old);
        const writing = atomicWrite(paths.state, next);
        for (let i = 0; i < 20; i++)
            expect(['old', 'new']).toContain((JSON.parse(await readFile(paths.state, 'utf8')) as {
                generation: string;
            }).generation);
        await writing;
        expect(await readState(paths.state)).toEqual(next);
        expect((await lstat(paths.state)).mode & 0o777).toBe(0o600);
    });
});
describe('lock, logger and shell environment', () => {
    it('refuses a second daemon and recovers a stale PID without signalling it', async () => {
        const paths = getPaths(await temp());
        await preparePaths(paths);
        const release = await acquireLock(paths.pid);
        await expect(acquireLock(paths.pid)).rejects.toThrow('Daemon already running');
        release();
        await writeFile(paths.pid, '2147483647\n', { mode: 0o600 });
        const again = await acquireLock(paths.pid);
        again();
        await expect(lstat(paths.pid)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('recovers a stale lock whose PID now belongs to a process that started after the lock was written', async () => {
        const paths = getPaths(await temp());
        await preparePaths(paths);
        // After a crash and reboot the old daemon PID can belong to any live process, even a root one.
        await writeFile(paths.pid, `${process.pid}\n`, { mode: 0o600 });
        const written = new Date('2001-01-01T00:00:00Z');
        await utimes(paths.pid, written, written);
        const release = await acquireLock(paths.pid);
        expect((await readFile(paths.pid, 'utf8')).trim()).toBe(String(process.pid));
        expect((await lstat(paths.pid)).mtimeMs).toBeGreaterThan(written.getTime());
        release();
        // PID 1 belongs to root: never this user's daemon, however old the lock.
        await writeFile(paths.pid, '1\n', { mode: 0o600 });
        (await acquireLock(paths.pid))();
    });
    it('never calls a lock stale when ps itself cannot run', async () => {
        const paths = getPaths(await temp());
        await preparePaths(paths);
        await writeFile(paths.pid, `${process.pid}\n`, { mode: 0o600 });
        const written = new Date('2001-01-01T00:00:00Z');
        await utimes(paths.pid, written, written);
        vi.resetModules();
        vi.doMock('node:child_process', async (original: () => Promise<object>) => ({ ...(await original()), execFile: (_file: string, _args: string[], _options: object, callback: (error: Error, stdout: string) => void) => callback(Object.assign(new Error('spawn /bin/ps ENOENT'), { code: 'ENOENT' }), '') }));
        try {
            const { acquireLock: lockWithoutPs } = await import('../src/daemon/lock.js');
            await expect(lockWithoutPs(paths.pid)).rejects.toThrow();
            expect((await readFile(paths.pid, 'utf8')).trim()).toBe(String(process.pid));
        }
        finally {
            vi.doUnmock('node:child_process');
            vi.resetModules();
        }
    });
    it('redacts canary and key assignments and rotates private logs', async () => {
        expect(redact('sk-ant-AITERMCANARY0000 OPENAI_API_KEY=dummy-value')).not.toContain('AITERMCANARY');
        expect(redact('OPENAI_API_KEY=dummy-value')).not.toContain('dummy-value');
        const paths = getPaths(await temp());
        await preparePaths(paths);
        const log = new Logger(paths.log, 100);
        log.info('sk-ant-AITERMCANARY0000');
        log.info('x'.repeat(120));
        log.info('rotate');
        expect(await readFile(paths.log, 'utf8')).not.toContain('AITERMCANARY');
        expect((await lstat(paths.log)).mode & 0o777).toBe(0o600);
    });
    it('applies only the always rules without mutating input or logging env', () => {
        const base = { SHELL: '/bin/zsh', npm_foo: 'bad', INIT_CWD: 'bad', NODE_ENV: 'bad', AI_TERM_HOME: 'bad', LANG: 'custom', unrelated: 'keep' };
        expect(buildShellEnv(base)).toEqual({ SHELL: '/bin/zsh', LANG: 'custom', unrelated: 'keep', TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'AITerm' });
        expect(base.npm_foo).toBe('bad');
    });
});
describe('real PTY lifecycle and mirror', () => {
    it('retains output on exit 3 and records an error', async () => {
        const paths = getPaths(await temp());
        await preparePaths(paths);
        const manager = new SessionManager(paths, new Logger(paths.log), { executable: '/bin/sh', args: ['-c', 'printf hi; exit 3'], env: { PATH: '/usr/bin:/bin' } });
        await manager.load();
        const session = await manager.create({ cwd: paths.root, title: 'test' });
        try {
            await expect.poll(() => manager.get(session.id).exitCode, { timeout: 5000 }).toBe(3);
            expect(manager.get(session.id).status).toBe('error');
            expect(await manager.snapshot(session.id)).toContain('hi');
        }
        finally {
            await manager.shutdown();
        }
    });
    it('answers detached cursor-position queries through the mirror', async () => {
        const paths = getPaths(await temp());
        await preparePaths(paths);
        const script = "stty raw -echo; printf '\\033[6n'; answer=$(dd bs=1 count=6 2>/dev/null); [ \"$answer\" = \"$(printf '\\033[1;1R')\" ] || exit 4; printf '\\r\\nREPLY:VALID\\r\\n'";
        const manager = new SessionManager(paths, new Logger(paths.log), { executable: '/bin/sh', args: ['-c', script], env: { PATH: '/usr/bin:/bin' } });
        await manager.load();
        const session = await manager.create({ cwd: paths.root });
        try {
            await expect.poll(async () => manager.snapshot(session.id), { timeout: 2000 }).toContain('REPLY:');
        }
        finally {
            await manager.shutdown();
        }
    });
    it('spawns sessions with the user umask, not the daemon private 077', async () => {
        const paths = getPaths(await temp());
        await preparePaths(paths);
        const previous = process.umask(0o077);
        const manager = new SessionManager(paths, new Logger(paths.log), { executable: '/bin/sh', args: ['-c', 'umask'], env: { PATH: '/usr/bin:/bin' } }, 0o022);
        try {
            await manager.load();
            const session = await manager.create({ cwd: paths.root });
            await expect.poll(() => manager.get(session.id).exitCode, { timeout: 5000 }).toBe(0);
            expect(await manager.snapshot(session.id)).toContain('0022');
            expect(process.umask()).toBe(0o077);
        }
        finally {
            process.umask(previous);
            await manager.shutdown();
        }
    });
    it('records an unrequested signal death as failed, while a requested stop stays exited', async () => {
        const paths = getPaths(await temp());
        await preparePaths(paths);
        const crashing = new SessionManager(paths, new Logger(paths.log), { executable: '/bin/sh', args: ['-c', 'printf up; kill -SEGV $$'], env: { PATH: '/usr/bin:/bin' } });
        await crashing.load();
        const crashed = await crashing.create({ cwd: paths.root });
        try {
            await expect.poll(() => crashing.get(crashed.id).status, { timeout: 5000 }).toBe('error');
            expect(crashing.get(crashed.id)).toMatchObject({ statusDetail: 'signal 11', exitCode: null });
        }
        finally {
            await crashing.shutdown();
        }
        const stopping = new SessionManager(paths, new Logger(paths.log), { executable: '/bin/sh', args: ['-c', 'printf up; read answer'], env: { PATH: '/usr/bin:/bin' } });
        await stopping.load();
        const stopped = await stopping.create({ cwd: paths.root });
        try {
            await expect.poll(() => stopping.get(stopped.id).status, { timeout: 5000 }).toBe('running');
            await stopping.stop(stopped.id);
            expect(stopping.get(stopped.id).status).toBe('exited');
        }
        finally {
            await stopping.shutdown();
        }
    });
    it('refills the reply budget with time but never above its burst', () => {
        let now = 0;
        const budget = new ReplyBudget(() => now);
        expect(budget.take(REPLY_BURST_BYTES)).toBe(true);
        expect(budget.take(1)).toBe(false);
        now = 1000;
        expect(budget.take(REPLY_BYTES_PER_SECOND)).toBe(true);
        expect(budget.take(1)).toBe(false);
        now = 1e9;
        expect(budget.take(REPLY_BURST_BYTES + 1)).toBe(false);
        expect(budget.take(REPLY_BURST_BYTES)).toBe(true);
    });
    it('bounds detached query replies when a session floods queries and never reads them', async () => {
        const paths = getPaths(await temp());
        await preparePaths(paths);
        // 20,000 cursor-position queries would otherwise queue ~120 KB of replies in node-pty's unbounded write queue.
        const script = "stty raw -echo; /usr/bin/perl -e 'print qq(\\e[6n) x 20000; print qq(FLOOD-DONE)'; exec /bin/sleep 30";
        const manager = new SessionManager(paths, new Logger(paths.log), { executable: '/bin/sh', args: ['-c', script], env: { PATH: '/usr/bin:/bin' } });
        const write = vi.spyOn(PtyHost.prototype, 'write');
        await manager.load();
        const session = await manager.create({ cwd: paths.root });
        try {
            await expect.poll(async () => manager.snapshot(session.id), { timeout: 5000 }).toContain('FLOOD-DONE');
            const written = write.mock.calls.reduce((total, [data]) => total + Buffer.byteLength(data), 0);
            expect(written).toBeGreaterThan(0);
            expect(written).toBeLessThan(32 * 1024);
        }
        finally {
            write.mockRestore();
            await manager.shutdown();
        }
    });
    it('keeps finished results on restart and only marks live records exited without killing saved PIDs', async () => {
        const paths = getPaths(await temp());
        await preparePaths(paths);
        const manager = new SessionManager(paths, new Logger(paths.log), { executable: '/bin/sh', args: ['-c', 'printf hi; exit 0'], env: { PATH: '/usr/bin:/bin' } });
        await manager.load();
        const session = await manager.create({ cwd: paths.root });
        await expect.poll(() => manager.get(session.id).exitCode, { timeout: 5000 }).toBe(0);
        await manager.shutdown();
        const restarted = new SessionManager(paths, new Logger(paths.log));
        await restarted.load();
        expect(restarted.get(session.id)).toMatchObject({ status: 'exited', statusDetail: 'exit 0', exitCode: 0 });
        await restarted.shutdown();
        const since = '2026-10-11T12:00:00.000Z';
        const records = ['error', 'exited', 'running'].map((status, i) => ({ ...session, id: randomUUID(), status, statusDetail: i === 0 ? 'exit 3' : i === 1 ? 'exit 0' : 'running', statusSince: since, exitCode: i === 0 ? 3 : i === 1 ? 0 : null, pid: process.pid }));
        await atomicWrite(paths.state, { sessions: records });
        const loaded = new SessionManager(paths, new Logger(paths.log));
        const kill = vi.spyOn(process, 'kill');
        try {
            await loaded.load();
            expect(loaded.list()[0]).toMatchObject({ status: 'error', exitCode: 3, statusDetail: 'exit 3', statusSince: since });
            expect(loaded.list()[1]).toMatchObject({ status: 'exited', exitCode: 0, statusDetail: 'exit 0', statusSince: since });
            expect(loaded.list()[2]).toMatchObject({ status: 'exited', exitCode: null, statusDetail: 'background service restarted' });
            expect(loaded.list()[2]?.statusSince).not.toBe(since);
            expect(loaded.list()[0]).not.toHaveProperty('pid');
            expect(loaded.list()[0]).not.toHaveProperty('recipe');
            expect(kill).not.toHaveBeenCalled();
        } finally { kill.mockRestore(); await loaded.shutdown(); }
    });
});
it('refuses directories owned by another UID before changing their mode',async()=>{
 const root=await temp();const uid=process.getuid?.();if(uid===undefined)throw new Error('UID unavailable');
 const getuid=vi.spyOn(process,'getuid').mockReturnValue(uid+1);
 try{await expect(preparePaths(getPaths(root))).rejects.toThrow('owned by this user');}finally{getuid.mockRestore();}
});
