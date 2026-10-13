import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { privateDirectory } from '../shared/paths.js';
import { isStatusCommandPath } from '../shared/validate.js';
import { sourceTsconfig, TSX_PIN } from './env.js';
// D43: a click with no ai client open starts ai in a new Terminal window, inside that agent. Terminal opens a .command
// file as a document through Launch Services, so no AppleScript and no Automation permission is involved.
export interface AiCommand { node: string; entry: string; loader?: string }
export type TerminalRunner = (file: string, args: readonly string[], done: (error: Error | null) => void) => void;
export type Delay = (callback: () => void) => void;
const OPEN = '/usr/bin/open', OPEN_TIMEOUT_MS = 10_000;
// Terminal reads the file after open returns (it types the path into a new shell), so the file can't be deleted at once.
// Its own first line removes it when it runs; this delayed cleanup catches a window that never ran it.
const CLEANUP_DELAY_MS = 60_000;
// The daemon makes session ids with randomUUID (lowercase); nothing else is ever written into the file.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const runOpen: TerminalRunner = (file, args, done) => {
    execFile(file, [...args], { timeout: OPEN_TIMEOUT_MS, env: { PATH: '/usr/bin:/bin' } }, error => done(error));
};
const later: Delay = callback => { setTimeout(callback, CLEANUP_DELAY_MS).unref(); };
// A fixed interpreter, the absolute node + ai CLI paths (strict path alphabet: no quotes, spaces or shell characters)
// and the validated UUID. Quoting is defence in depth; the alphabet already rules out anything the shell would expand.
export function terminalCommandFile(command: AiCommand, sessionId: string): string {
    const source = command.entry.endsWith('.ts'), tsconfig = sourceTsconfig(command.entry);
    if (!SESSION_ID.test(sessionId) || !isStatusCommandPath(command.node) || !isStatusCommandPath(command.entry)
        || !(command.entry.endsWith('.js') || source && isStatusCommandPath(command.loader) && isStatusCommandPath(tsconfig)))
        throw new Error('Invalid terminal command');
    // Source mode pins AI Term's tsconfig: Terminal starts the script in the home folder, whose tsconfig tsx would read.
    const pin = source ? `${TSX_PIN} 'TSX_TSCONFIG_PATH=${tsconfig}' ` : '', loader = source ? ` --import '${command.loader ?? ''}'` : '';
    return `#!/bin/sh\nrm -f -- "$0"\nexec ${pin}'${command.node}'${loader} '${command.entry}' --attach '${sessionId}'\n`;
}
export class TerminalLauncher {
    constructor(private readonly root: string, private readonly command: AiCommand, private readonly log: { info(text: string): void; error(text: string): void },
        private readonly runner: TerminalRunner = runOpen, private readonly delay: Delay = later) {}
    async open(sessionId: string): Promise<void> {
        // Built (and validated) before anything touches the disk.
        const contents = terminalCommandFile(this.command, sessionId), launch = join(this.root, 'launch');
        await privateDirectory(launch);
        const directory = await mkdtemp(join(launch, 'click-')), file = join(directory, 'ai.command');
        try {
            const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o700);
            try { await handle.writeFile(contents); await handle.chmod(0o700); } finally { await handle.close(); }
        } catch (error) { await this.remove(directory); throw error; }
        const failed = await new Promise<Error | null>(resolve => {
            try { this.runner(OPEN, ['-a', 'Terminal', file], resolve); } catch (error) { resolve(error instanceof Error ? error : new Error('open failed')); }
        });
        // open's error can carry the argv; only fixed text is logged.
        if (failed) { this.log.error('Notification click could not open Terminal'); await this.remove(directory); return; }
        this.delay(() => { void this.remove(directory); });
    }
    // Folders left by a daemon that stopped before its cleanup ran.
    async sweep(): Promise<void> {
        const launch = join(this.root, 'launch');
        await privateDirectory(launch);
        for (const name of await readdir(launch)) if (name.startsWith('click-')) await this.remove(join(launch, name));
    }
    private async remove(directory: string): Promise<void> {
        try { await rm(directory, { recursive: true, force: true }); } catch { this.log.error('Notification click file cleanup failed'); }
    }
}
