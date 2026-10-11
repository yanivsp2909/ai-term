import pty from 'node-pty';
import { isFsError } from '../shared/paths.js';
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
    resize(cols: number, rows: number): void { if (!this.exited)
        this.pty.resize(cols, rows); }
    pause(): void { this.pty.pause(); }
    resume(): void { this.pty.resume(); }
    async stop(): Promise<void> {
        if (this.exited)
            return;
        this.stopRequested = true;
        const signal = (name: NodeJS.Signals) => {
            if (this.exited)
                return;
            // node-pty creates the session/process group; never signal a stored PID on restart.
            try {
                process.kill(-this.pty.pid, name);
            }
            catch (error) {
                if (!isFsError(error, 'ESRCH'))
                    throw error;
            }
        };
        signal('SIGTERM');
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, 3000); });
        await Promise.race([this.exitPromise, timeout]);
        if (timer)
            clearTimeout(timer);
        if (!this.exited) {
            signal('SIGKILL');
            await this.exitPromise;
        }
    }
}
