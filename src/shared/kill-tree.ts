import { execFile } from 'node:child_process';
// Windows has no process groups to signal: taskkill /T stops a process and every process it started, /F without asking.
export function killTreeArgs(pid: number): string[] {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid process id');
  return ['/T', '/F', '/PID', String(pid)];
}
// Signals a process group: POSIX kill(-pid) (throws as process.kill does, ESRCH when it's gone). Windows: taskkill /T /F
// on the process, asynchronously; "not found" (exit 128) is what we wanted, anything else goes to onError.
export function killGroup(pid: number, signal: NodeJS.Signals, onError: (error: unknown) => void = () => {}, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') { process.kill(-pid, signal); return; }
  execFile(`${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\taskkill.exe`, killTreeArgs(pid), { windowsHide: true, timeout: 10_000 }, error => {
    if (error && !(typeof error.code === 'number' && error.code === 128)) onError(error);
  });
}
