import { constants, openSync, writeFileSync, fsyncSync, closeSync, readFileSync, lstatSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { isFsError } from '../shared/paths.js';
// When the process holding `pid` started, from ps's elapsed time (TZ/DST-proof); null if it is gone.
function processStart(pid: number): Promise<number | null> {
    return new Promise((resolve, reject) => execFile('/bin/ps', ['-o', 'etime=', '-p', String(pid)], { timeout: 3000, env: { LC_ALL: 'C' } }, (error, stdout) => {
        const now = Date.now(), text = stdout.trim();
        // ps exits 1 with no output only for "no such process"; any other failure must not free the lock.
        if (error && !text)
            return error.code === 1 ? resolve(null) : reject(new Error('Could not read daemon PID start time', { cause: error }));
        const match = text.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
        if (!match)
            return reject(new Error('Unreadable daemon PID start time', { cause: error ?? undefined }));
        const [days, hours, minutes, seconds] = match.slice(1).map(part => Number(part ?? 0));
        resolve(now - ((((days ?? 0) * 24 + (hours ?? 0)) * 60 + (minutes ?? 0)) * 60 + (seconds ?? 0)) * 1000);
    }));
}
export async function acquireLock(path: string): Promise<() => void> {
    for (let attempt = 0; attempt < 3; attempt++) {
        let fd: number;
        try {
            fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        }
        catch (error) {
            if (!isFsError(error, 'EEXIST'))
                throw error;
            const stat = lstatSync(path);
            if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > 32)
                throw new Error('Unsafe daemon lock', { cause: error });
            const text = readFileSync(path, 'utf8').trim();
            if (!/^[1-9][0-9]{0,9}$/.test(text))
                throw new Error('Invalid daemon PID; refusing to remove lock', { cause: error });
            const pid = Number(text);
            try {
                process.kill(pid, 0);
            }
            catch (probeError) {
                // EPERM: another user's process, which can never be this user's daemon.
                if (!isFsError(probeError, 'ESRCH') && !isFsError(probeError, 'EPERM'))
                    throw new Error('Daemon PID is alive or inaccessible', { cause: probeError });
                const current = lstatSync(path);
                if (current.ino === stat.ino && current.dev === stat.dev)
                    unlinkSync(path);
                continue;
            }
            // After a crash and reboot the stale PID can belong to any live process. A process that
            // started after the lock was written can't be its owner. ps rounds down to whole seconds,
            // so allow 2 s before calling it stale.
            const started = await processStart(pid);
            const current = lstatSync(path);
            if (current.ino !== stat.ino || current.dev !== stat.dev)
                continue;
            if (started === null || started > stat.mtimeMs + 2000) {
                unlinkSync(path);
                continue;
            }
            throw new Error('Daemon already running', { cause: error });
        }
        try {
            writeFileSync(fd, `${process.pid}\n`);
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        const owned = lstatSync(path);
        return () => {
            try {
                const current = lstatSync(path);
                if (current.ino === owned.ino && current.dev === owned.dev)
                    unlinkSync(path);
            }
            catch (error) {
                if (!isFsError(error, 'ENOENT'))
                    throw error;
            }
        };
    }
    throw new Error('Daemon lock changed repeatedly');
}
