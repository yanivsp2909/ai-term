import { constants, openSync, writeFileSync, fsyncSync, closeSync, readFileSync, lstatSync, unlinkSync } from 'node:fs';
import { isFsError } from '../shared/paths.js';
export function acquireLock(path: string): () => void {
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number;
    try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (!isFsError(error, 'EEXIST')) throw error;
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > 32) throw new Error('Unsafe daemon lock');
      const text = readFileSync(path, 'utf8').trim();
      if (!/^[1-9][0-9]{0,9}$/.test(text)) throw new Error('Invalid daemon PID; refusing to remove lock');
      const pid = Number(text);
      try { process.kill(pid, 0); }
      catch (probeError) {
        if (!isFsError(probeError, 'ESRCH')) throw new Error('Daemon PID is alive or inaccessible');
        const current = lstatSync(path);
        if (current.ino === stat.ino && current.dev === stat.dev) unlinkSync(path);
        continue;
      }
      throw new Error('Daemon already running');
    }
    try { writeFileSync(fd, `${process.pid}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    const owned = lstatSync(path);
    return () => {
      try { const current = lstatSync(path); if (current.ino === owned.ino && current.dev === owned.dev) unlinkSync(path); }
      catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
    };
  }
  throw new Error('Daemon lock changed repeatedly');
}
