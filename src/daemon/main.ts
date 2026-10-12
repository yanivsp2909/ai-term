import { getPaths, preparePaths } from '../shared/paths.js';
import { acquireLock } from './lock.js';
import { Logger } from './log.js';
import { SessionManager } from './session-manager.js';
import { UsageService } from './usage-service.js';
import { DaemonServer } from './server.js';
export async function runDaemon(): Promise<void> {
    // Private files for the daemon; sessions get the user's own umask back (session-manager).
    const userUmask = process.umask(0o077);
    const paths = getPaths();
    await preparePaths(paths);
    const log = new Logger(paths.log), release = await acquireLock(paths.pid);
    const usage=new UsageService(paths.root,log);
    const manager = new SessionManager(paths, log, undefined, userUmask,undefined,undefined,usage), server = new DaemonServer(paths, manager, log,undefined,undefined,usage);
    let closing = false;
    let idleSince: number | null = null;
    let idle: ReturnType<typeof setInterval> | undefined;
    let resolveDone: () => void = () => { };
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    const shutdown = async (error?: unknown) => {
        if (closing)
            return;
        closing = true;
        if (idle)
            clearInterval(idle);
        if (error) {
            try{log.error(`Daemon failed: ${error instanceof Error ? error.message : 'unknown'}`);}catch{process.stderr.write('Daemon logging failed\n');}
            process.exitCode = 1;
        }
        try {
            for(const cleanup of [()=>server.close(),()=>manager.shutdown(),()=>usage.close()]) {
                try{await cleanup();}catch(cleanupError){try{log.error(`Shutdown failed: ${cleanupError instanceof Error?cleanupError.message:'unknown'}`);}catch{process.stderr.write('Daemon logging failed\n');}process.exitCode=1;}
            }
        } finally {
            try{release();}catch{process.stderr.write('Daemon lock cleanup failed\n');process.exitCode=1;}finally{process.off('SIGTERM',onSignal);process.off('SIGINT',onSignal);process.off('uncaughtException',onFailure);process.off('unhandledRejection',onFailure);resolveDone();}
        }
    };
    const onSignal = () => { void shutdown(); };
    const onFailure = (error:unknown) => { void shutdown(error); };
    process.on('uncaughtException',onFailure);process.on('unhandledRejection',onFailure);
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    manager.on('fatal', (error: unknown) => { void shutdown(error); });
    try {
        await usage.start();
        await manager.load();
        if (!closing)
            await server.listen();
        if (!closing) {
            log.info('Daemon started');
            idle = setInterval(() => {
                if (manager.activeCount() === 0 && server.clientCount() === 0) {
                    idleSince ??= Date.now();
                    if (Date.now() - idleSince >= 10 * 60 * 1000)
                        void shutdown();
                }
                else
                    idleSince = null;
            }, 1000);
        }
    }
    catch (error) {
        await shutdown(error);
    }
    await done;
}
