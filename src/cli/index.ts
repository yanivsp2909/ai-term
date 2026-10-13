#!/usr/bin/env node
import packageInfo from '../../package.json' with { type: 'json' };
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { lstat, open } from 'node:fs/promises';
import headless from '@xterm/headless';
import { Connection } from '../client/connection.js';
import { getPaths, preparePaths, isFsError } from '../shared/paths.js';
import { isUUID, validCwd } from '../shared/validate.js';
import { redact, Logger } from '../daemon/log.js';
import { AttachError } from '../client/attach.js';
import { ClientSignal } from '../client/signals.js';
import {aiSubcommands,debugActions} from '../client/tui/commands.js';
const args = process.argv.slice(2), entry = fileURLToPath(import.meta.url);
function usage(): void { process.stderr.write('Usage:\n'+aiSubcommands.map(command=>'  '+command).join('\n')+'\n'); process.exitCode = 2; }
async function main(): Promise<void> {
    if (args.length === 0) {
        const client = await Connection.connect(getPaths(), { entry });
        try { const { homepage } = await import('../client/tui/homepage.js'); await homepage(client); }
        finally { client.close(); }
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
    if(args.length===1&&args[0]==='status-line'){const {statusLine}=await import('./status-line.js');await statusLine();return;}
    if (args.length === 1 && args[0] === 'doctor') {
        const { doctor } = await import('./doctor.js');
        await doctor(entry);
        return;
    }
    const stopDaemon = args.length === 2 && args[0] === 'daemon' && args[1] === 'stop';
    const debug = args[0] === 'debug';
    const action = args[1];
    if(debug && action==='stats' && args.length===2){
        // A downstream pipe consumer may close between writes; stdout errors are asynchronous.
        process.stdout.on('error',(error:unknown)=>{
            if(isFsError(error,'EPIPE'))process.exit(0);
            process.stderr.write('Standard output failed\n');process.exit(1);
        });
        const {debugStats}=await import('./debug-stats.js');await debugStats();return;}
    if (!stopDaemon && (!debug || action==='stats' || !debugActions.includes(action ?? '') || args.length > 3)) {
        usage();
        return;
    }
    if (debug && ((['ls','usage'].includes(action??'') && args.length !== 2) || (['stop', 'peek','attach'].includes(action ?? '') && !isUUID(args[2])))) {
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
    let pathsReady=false;
    try {
        await preparePaths(paths);pathsReady=true;
        client = await Connection.connect(paths, { entry, autoStart: !stopDaemon&&action!=='usage', readOnly:true });
    }
    catch (error) {
        if (stopDaemon && isFsError(error, 'ENOENT')) {
            process.stdout.write('Daemon is not running.\n');
            return;
        }
        if(action==='attach'){
            const reason=isFsError(error,'ENOENT')||isFsError(error,'ECONNREFUSED')?'daemon gone':'error';
            process.stdout.write(`back in your shell (${reason})\n`);
            // Connection setup may have rejected these directories: never log through them.
            if(pathsReady&&process.env.AI_TERM_DEBUG==='1'){
                try{new Logger(paths.log).info(`attach reason=${reason} inputBytes=0`);}
                catch(logError){process.stderr.write(`Attach debug log failed: ${redact(logError instanceof Error?logError.message:'Log failed')}\n`);}
            }
        }
        throw error;
    }
    try {
        if (stopDaemon) {
            const hello = await client.hello;
            if (!hello.daemonPid || !Number.isSafeInteger(hello.daemonPid) || hello.daemonPid < 2)
                throw new Error('Daemon returned invalid PID');
            const lock = await open(paths.pid, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const stat = await lock.stat();
                if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > 32 || Number((await lock.readFile('utf8')).trim()) !== hello.daemonPid)
                    throw new Error('Daemon PID does not match its private lock');
            }
            finally {
                await lock.close();
            }
            client.close();
            process.kill(hello.daemonPid, 'SIGTERM');
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
        if(action==='usage'){const {debugUsage}=await import('./debug-usage.js');await debugUsage(client);}
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
        if(action==='attach'&&args[2]){
            const {attach}=await import('../client/attach.js');
            try{
                const reason=await attach(client,args[2],{debugLog:process.env.AI_TERM_DEBUG==='1'?new Logger(paths.log):undefined});
                process.stdout.write(`back in your shell (${reason})\n`);
            }catch(error){
                process.stdout.write(`back in your shell (${error instanceof AttachError?error.reason:'error'})\n`);
                throw error;
            }
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
await main().catch(error => { if (error instanceof ClientSignal) { process.exitCode = error.exitCode; return; } process.stderr.write(`${redact(error instanceof Error ? error.message : 'Command failed')}\n`); process.exitCode = 1; });
