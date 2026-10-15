import { getPaths, preparePaths } from '../shared/paths.js';
import { acquireLock } from './lock.js';
import { Logger } from './log.js';
import { SessionManager } from './session-manager.js';
import { UsageService } from './usage-service.js';
import { migratePrices } from './price-migration.js';
import { DaemonServer } from './server.js';
import { Notifier, notifierAppPath, notificationsSetting, launchNotifySend } from './notifier.js';
import { systemTool } from '../shared/executable.js';
import { warmAgentSandbox } from './agent-sandbox.js';
import { ClickReceiver, CLICK_SOCKET } from './click-receiver.js';
import { TerminalLauncher } from './terminal-launch.js';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { StatusState } from './status-reducer.js';
import type { SessionInfo } from '../shared/protocol.js';
// Fixed words for why clicks can't reach the daemon; never the raw error, which can carry paths.
const CLICK_ROUTE_REASONS: Record<string, string> = { 'Daemon socket already in use': 'socket in use', 'Unsafe socket path': 'unsafe socket path', 'Socket changed during stale check': 'socket changed during startup' };
export function clickRouteFailure(error: unknown): string {
    const reason = error instanceof Error ? CLICK_ROUTE_REASONS[error.message] : undefined;
    return `Notification click route unavailable: ${reason ?? 'setup failed'}`;
}
export async function runDaemon(entry?:string): Promise<void> {
    // Private files for the daemon; sessions get the user's own umask back (session-manager).
    const userUmask = process.umask(0o077);
    const paths = getPaths();
    await preparePaths(paths, { daemon: true });
    const log = new Logger(paths.log), release = await acquireLock(paths.pid);
    const usage=new UsageService(paths.root,log);
    // macOS: the signed helper app, with click-through. Linux (v0.8.1): notify-send when installed, no click-through.
    const mac = process.platform === 'darwin';
    const notifier = mac ? new Notifier(entry ? notifierAppPath(entry) : null, log, notificationsSetting(paths.root))
        : new Notifier(null, log, notificationsSetting(paths.root), launchNotifySend, undefined, undefined, undefined, { platform: process.platform, notifySend: process.platform === 'linux' ? await systemTool('notify-send') : null });
    const manager = new SessionManager(paths, log, undefined, userUmask,undefined,undefined,usage,entry), server = new DaemonServer(paths, manager, log,undefined,undefined,usage,notifier);
    manager.on('statusChanged', (session: SessionInfo, previous: StatusState, next: StatusState, attached: boolean) => notifier.transition(session, previous, next, attached));
    // Notification clicks: select the agent in an open homepage, otherwise open Terminal inside it (D43).
    const launcher = entry && mac ? new TerminalLauncher(paths.root, { node: process.execPath, entry, ...(entry.endsWith('.ts') ? { loader: createRequire(import.meta.url).resolve('tsx') } : {}) }, log) : null;
    const clicks = new ClickReceiver(join(paths.run, CLICK_SOCKET), {
        session: id => manager.list().find(session => session.id === id) ?? null,
        hasClient: () => server.clickClients() > 0,
        select: id => server.selectSession(id),
        openTerminal: async id => { if (!launcher) throw new Error('No ai entry for Terminal'); await launcher.open(id); },
    }, log);
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
            try{log.error('Daemon failed');}catch{process.stderr.write('Daemon logging failed\n');}
            process.exitCode = 1;
        }
        try {
            for(const cleanup of [()=>clicks.close(),()=>server.close(),()=>manager.shutdown(),()=>usage.close(),()=>notifier.close()]) {
                try{await cleanup();}catch{try{log.error('Shutdown cleanup failed');}catch{process.stderr.write('Daemon logging failed\n');}process.exitCode=1;}
            }
        } finally {
            try{release();}catch{process.stderr.write('Daemon lock cleanup failed\n');process.exitCode=1;}finally{process.off('SIGTERM',onSignal);process.off('SIGINT',onSignal);process.off('uncaughtException',onFailure);process.off('unhandledRejection',onFailure);resolveDone();}
        }
    };
    const onSignal = () => { void shutdown(); };
    server.onStop = onSignal;
    const onFailure = (error:unknown) => { void shutdown(error); };
    process.on('uncaughtException',onFailure);process.on('unhandledRejection',onFailure);
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    manager.on('fatal', (error: unknown) => { void shutdown(error); });
    try {
        warmAgentSandbox();
        notifier.start();
        await usage.start();
        // B27: old price records keyed by model id alone move to their one provider (nothing is lost either way).
        try { await migratePrices(paths.root); } catch { log.error('Price records could not be migrated; they keep applying as before'); }
        await manager.load();
        if (!closing)
            await server.listen();
        // Clicks are optional: a failure here is logged and AI Term runs on without click-through.
        if (!closing) {
            if (mac) try { await launcher?.sweep(); await clicks.listen(); }
            catch (error) { log.error(clickRouteFailure(error)); }
        }
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
