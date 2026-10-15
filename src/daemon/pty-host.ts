import pty from 'node-pty';
import { isFsError } from '../shared/paths.js';
import { killGroup } from '../shared/kill-tree.js';
export interface SpawnRecipe {
    executable: string;
    args: string[];
    env: NodeJS.ProcessEnv;
}
export class PtyHost {
    readonly pty: pty.IPty;
    private exited = false;
    // A signal death the user asked for is an exit; any other one is a crash.
    stopRequested = false;
    // Windows: taskkill reported a failure (it runs asynchronously, so it can't throw where the signal was sent).
    stopFailed = false;
    private exitPromise: Promise<void>;
    constructor(recipe: SpawnRecipe, cwd: string, cols: number, rows: number, umask?: number) {
        // The child inherits the umask at fork; give it the user's, not the daemon's private 077.
        const previous = umask === undefined ? undefined : process.umask(umask);
        try {
            this.pty = pty.spawn(recipe.executable, recipe.args, { name: 'xterm-256color', cwd, cols, rows, env: recipe.env });
        }
        finally {
            if (previous !== undefined)
                process.umask(previous);
        }
        this.exitPromise = new Promise(resolve => this.pty.onExit(() => { this.exited = true; resolve(); }));
    }
    write(data: string | Buffer): void { if (!this.exited)
        this.pty.write(data); }
    resize(cols: number, rows: number): void {
        if (this.exited)
            return;
        try {
            this.pty.resize(cols, rows);
        }
        catch (error) {
            // node-pty closes the PTY fd as soon as the child hangs up but reports the exit only later, so a resize
            // in between fails with EBADF. Nothing is left to resize, and onExit follows; any other failure is real.
            if (error instanceof Error && error.message.includes('EBADF'))
                return;
            throw error;
        }
    }
    pause(): void { this.pty.pause(); }
    resume(): void { this.pty.resume(); }
    private async waitForExit():Promise<void>{
        let timer:ReturnType<typeof setTimeout>|undefined;
        try{await Promise.race([this.exitPromise,new Promise<void>(resolve=>{timer=setTimeout(resolve,3000);})]);}
        finally{if(timer)clearTimeout(timer);}
    }
    async stop(): Promise<void> {
        if (this.exited)
            return;
        this.stopRequested = true;
        const signal = (name: NodeJS.Signals) => {
            if (this.exited)
                return;
            // node-pty creates the session/process group; never signal a stored PID on restart.
            // Windows: ConPTY has no process group; taskkill /T stops the CLI and what it started (kill-tree.ts).
            try {
                killGroup(this.pty.pid, name, () => { this.stopFailed = true; });
            }
            catch (error) {
                if (!isFsError(error, 'ESRCH')) {
                    // eslint-disable-next-line preserve-caught-error -- Process errors may contain private data; retain only the fixed operation cause.
                    throw new Error('Session stop signal failed');
                }
            }
        };
        signal('SIGTERM');
        await this.waitForExit();
        if (!this.exited) {
            signal('SIGKILL');
            await this.waitForExit();
            // Windows: taskkill's own failure (stopFailed) reads as the signal failing, not as a mere timeout (review).
            if(!this.exited)throw new Error(this.stopFailed?'Session stop signal failed':'Session stop timed out');
        }
    }
}
