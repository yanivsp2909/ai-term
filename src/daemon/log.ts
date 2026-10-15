import { constants, openSync, closeSync, writeSync, fstatSync, fchmodSync, lstatSync, renameSync, unlinkSync } from 'node:fs';
import { isFsError } from '../shared/paths.js';
import { EventEmitter } from 'node:events';
import { ownedByMe } from '../shared/owner.js';
export function redact(text: string): string {
    return text.replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
        .replace(/([A-Za-z0-9_-]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_-]*["\x27]?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
        .replace(/bearer\s+\S+/gi, 'Bearer [REDACTED]')
        // eslint-disable-next-line no-control-regex -- Logs discard terminal controls.
        .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}
export class Logger extends EventEmitter {
    private failed = false;
    constructor(private readonly path: string, private readonly maxBytes = 5 * 1024 * 1024) { super(); }
    info(message: string): void { this.write('info', message); }
    error(message: string): void { this.write('error', message); }
    private safe(path: string): boolean {
        try {
            const stat = lstatSync(path);
            if (!stat.isFile() || !ownedByMe(stat))
                throw new Error('Unsafe log file');
            return true;
        }
        catch (error) {
            if (isFsError(error, 'ENOENT'))
                return false;
            throw error;
        }
    }
    private write(level: string, message: string): void {
        try {
            this.append(level, message);
        } catch {
            // Reporting must not try the same broken writer, or propagate into a PTY handler.
            this.failed = true;
            this.emit('writeFailed');
            return;
        }
        if (this.failed) { this.failed = false; this.emit('writeRecovered'); }
    }
    private append(level: string, message: string): void {
        if (this.safe(this.path) && lstatSync(this.path).size >= this.maxBytes) {
            if (this.safe(`${this.path}.2`))
                unlinkSync(`${this.path}.2`);
            for (let i = 1; i >= 1; i--)
                if (this.safe(`${this.path}.${i}`))
                    renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
            renameSync(this.path, `${this.path}.1`);
        }
        const fd = openSync(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
        try {
            if (!ownedByMe(fstatSync(fd)))
                throw new Error('Log not owned by this user');
            fchmodSync(fd, 0o600);
            writeSync(fd, `${new Date().toISOString()} ${level} ${redact(message)}\n`);
        }
        finally {
            closeSync(fd);
        }
    }
}
