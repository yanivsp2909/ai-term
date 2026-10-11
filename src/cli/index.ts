#!/usr/bin/env node
import packageInfo from '../../package.json' with { type: 'json' };
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { lstat, open } from 'node:fs/promises';
import headless from '@xterm/headless';
import { Connection } from '../client/connection.js';
import { getPaths, isFsError } from '../shared/paths.js';
import { isUUID, validCwd } from '../shared/validate.js';
import { redact } from '../daemon/log.js';
const args = process.argv.slice(2), entry = fileURLToPath(import.meta.url);
function usage(): void { process.stderr.write('Usage: ai [--version | daemon [stop] | doctor | debug ls|shell [cwd]|stop <id>|peek <id>]\n'); process.exitCode = 2; }
async function main(): Promise<void> {
    if (args.length === 0) {
        process.stdout.write('AI Term v0.1: not built yet. See PROGRESS.md.\n');
        return;
    }
    if (args.length === 1 && args[0] === '--version') {
        process.stdout.write(`${packageInfo.version}\n`);
        return;
    }
    if (args.length === 1 && args[0] === 'daemon') {
        const { runDaemon } = await import('../daemon/main.js');
        await runDaemon();
        return;
    }
    if (args.length === 1 && args[0] === 'doctor') {
        const { doctor } = await import('./doctor.js');
        await doctor(entry);
        return;
    }
    const stopDaemon = args.length === 2 && args[0] === 'daemon' && args[1] === 'stop';
    const debug = args[0] === 'debug';
    const action = args[1];
    if (!stopDaemon && (!debug || !['ls', 'shell', 'stop', 'peek'].includes(action ?? '') || args.length > 3)) {
        usage();
        return;
    }
    if (debug && ((action === 'ls' && args.length !== 2) || (['stop', 'peek'].includes(action ?? '') && !isUUID(args[2])))) {
        usage();
        return;
    }
    const cwd = action === 'shell' ? resolve(args[2] ?? process.cwd()) : null;
    if (cwd && !(await validCwd(cwd))) {
        process.stderr.write('cwd must be an existing directory\n');
        process.exitCode = 2;
        return;
    }
    const paths = getPaths();
    let client: Connection;
    try {
        client = await Connection.connect(paths, { entry, autoStart: !stopDaemon });
    }
    catch (error) {
        if (stopDaemon && isFsError(error, 'ENOENT')) {
            process.stdout.write('Daemon is not running.\n');
            return;
        }
        throw error;
    }
    try {
        if (stopDaemon) {
            const hello = await client.hello;
            if (!hello.pid || !Number.isSafeInteger(hello.pid) || hello.pid < 2)
                throw new Error('Daemon returned invalid PID');
            const lock = await open(paths.pid, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const stat = await lock.stat();
                if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > 32 || Number((await lock.readFile('utf8')).trim()) !== hello.pid)
                    throw new Error('Daemon PID does not match its private lock');
            }
            finally {
                await lock.close();
            }
            client.close();
            process.kill(hello.pid, 'SIGTERM');
            const end = Date.now() + 5000;
            while (Date.now() < end) {
                try {
                    await lstat(paths.pid);
                }
                catch (error) {
                    if (isFsError(error, 'ENOENT')) {
                        process.stdout.write('Daemon stopped.\n');
                        return;
                    }
                    throw error;
                }
                await new Promise(r => setTimeout(r, 50));
            }
            throw new Error('Daemon shutdown timed out');
        }
        if (action === 'ls') {
            const result = await client.request({ kind: 'sessions.list' });
            for (const session of result.sessions ?? [])
                process.stdout.write(`${session.id} ${session.status} ${redact(session.title)}\n`);
        }
        if (action === 'shell' && cwd) {
            const result = await client.request({ kind: 'sessions.create', engine: 'shell', cwd });
            if (!result.session || !isUUID(result.session.id))
                throw new Error('Daemon returned no session');
            process.stdout.write(`${result.session.id}\n`);
        }
        if (action === 'stop' && args[2]) {
            await client.request({ kind: 'sessions.stop', sessionId: args[2] });
            process.stdout.write('Session stopped.\n');
        }
        if (action === 'peek' && args[2]) {
            const result = await client.request({ kind: 'sessions.preview', sessionId: args[2] });
            const terminal = new headless.Terminal({ cols: result.cols ?? 85, rows: result.rows ?? 30, allowProposedApi: true });
            try {
                await new Promise<void>(r => terminal.write(result.snapshot ?? '', r));
                for (let y = 0; y < terminal.rows; y++) {
                    const line = terminal.buffer.active.getLine(terminal.buffer.active.viewportY + y)?.translateToString(true) ?? '';
                    process.stdout.write(line.replace(/[\p{C}]/gu, '') + '\n');
                }
            }
            finally {
                terminal.dispose();
            }
        }
    }
    finally {
        client.close();
    }
}
await main().catch(error => { process.stderr.write(`${redact(error instanceof Error ? error.message : 'Command failed')}\n`); process.exitCode = 1; });
