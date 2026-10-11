import { constants, openSync, closeSync, writeSync, fstatSync, fchmodSync, lstatSync, renameSync, unlinkSync } from 'node:fs';
import { isFsError } from '../shared/paths.js';
export function redact(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/([A-Za-z0-9_-]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_-]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/[\x00-\x1f\x7f]/g, ' ');
}
export class Logger {
  constructor(private readonly path: string, private readonly maxBytes = 5 * 1024 * 1024) {}
  info(message: string): void { this.write('info', message); }
  error(message: string): void { this.write('error', message); }
  private safe(path: string): boolean {
    try { const stat = lstatSync(path); if (!stat.isFile() || stat.uid !== process.getuid?.()) throw new Error('Unsafe log file'); return true; }
    catch (error) { if (isFsError(error, 'ENOENT')) return false; throw error; }
  }
  private write(level: string, message: string): void {
    if (this.safe(this.path) && lstatSync(this.path).size >= this.maxBytes) {
      if (this.safe(`${this.path}.3`)) unlinkSync(`${this.path}.3`);
      for (let i = 2; i >= 1; i--) if (this.safe(`${this.path}.${i}`)) renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
      renameSync(this.path, `${this.path}.1`);
    }
    const fd = openSync(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      if (fstatSync(fd).uid !== process.getuid?.()) throw new Error('Log not owned by this user');
      fchmodSync(fd, 0o600); writeSync(fd, `${new Date().toISOString()} ${level} ${redact(message)}\n`);
    } finally { closeSync(fd); }
  }
}
