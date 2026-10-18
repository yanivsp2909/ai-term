import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { REMOTE_HTTPS_PORT } from '../../shared/remote.js';

// v1.0.8 /remote: the tailscale CLI, run with execFile and argv only. AI Term reads `status --json` (logged in, the Mac's
// tailnet name, your login) and `serve status --json`, and runs `serve --bg --https=<port> <backend>` and `serve
// --https=<port> off` for its own port alone. It never reads Tailscale's credentials, never uses Funnel (the internet),
// and never changes a serve entry that isn't its own.
export const TAILSCALE_PATHS: readonly string[] = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/usr/bin/tailscale'];
export class TailscaleError extends Error {}
export const TAILSCALE_ERRORS = [
  "Tailscale isn't installed · install it from tailscale.com and log in, then /remote on",
  "Tailscale isn't logged in or connected · open Tailscale and log in, then /remote on",
  `Tailscale serve already uses port ${REMOTE_HTTPS_PORT} for something else · AI Term leaves it alone`,
  "The installed tailscale can't serve in the background (serve --bg, --https) · update Tailscale",
  "Tailscale's status couldn't be read · /remote stays off",
  "tailscale serve didn't publish AI Term's page · /remote stays off",
] as const;
export async function findTailscale(candidates: readonly string[] = TAILSCALE_PATHS): Promise<string | null> {
  for (const path of candidates) {
    try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) return path; } catch (error) { if (!(error instanceof Error && 'code' in error && ['ENOENT', 'EACCES', 'ENOTDIR'].includes(String(error.code)))) throw error; }
  }
  return null;
}
const object = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
export interface TailnetSelf { host: string; login: string }
export class Tailscale {
  constructor(private program: string) {}
  // help: tailscale prints usage to stderr and may exit non-zero; it is read, never trusted for anything but flag names.
  private run(args: readonly string[], help = false): Promise<string> {
    return new Promise((done, fail) => execFile(this.program, [...args], { timeout: 20_000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: homedir() } }, (error, stdout, stderr) => {
      if (error && !help) { fail(new TailscaleError(TAILSCALE_ERRORS[4])); return; }
      done(help ? `${stdout}\n${stderr}` : stdout);
    }));
  }
  private async json(args: readonly string[]): Promise<Record<string, unknown>> {
    let parsed: unknown; try { parsed = JSON.parse(await this.run(args)) as unknown; } catch (error) { if (error instanceof TailscaleError) throw error; throw new TailscaleError(TAILSCALE_ERRORS[4]); }
    const value = object(parsed); if (!value) throw new TailscaleError(TAILSCALE_ERRORS[4]);
    return value;
  }
  // The Mac's own tailnet name (MagicDNS, without the final dot) and the login of the user it belongs to.
  async self(): Promise<TailnetSelf> {
    const status = await this.json(['status', '--json']), me = object(status.Self);
    if (status.BackendState !== 'Running' || !me) throw new TailscaleError(TAILSCALE_ERRORS[1]);
    const name = typeof me.DNSName === 'string' ? me.DNSName.replace(/\.$/, '').toLowerCase() : '';
    const login = object(object(status.User)?.[String(me.UserID)])?.LoginName;
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name) || name.length > 253 || typeof login !== 'string' || !login || login.length > 320 || /[\p{C}\s]/u.test(login)) throw new TailscaleError(TAILSCALE_ERRORS[1]);
    return { host: name, login };
  }
  // Who serves on this HTTPS port: null when nobody, else the proxy target of its root handler ('' when not a proxy).
  private async user(port: number): Promise<string | null> {
    const status = await this.json(['serve', 'status', '--json']), tcp = object(status.TCP), web = object(status.Web);
    const entries = Object.entries(web ?? {}).filter(([key]) => key.endsWith(`:${port}`));
    if (!tcp?.[String(port)] && !entries.length) return null;
    const proxy = entries.map(([, value]) => object(object(object(value)?.Handlers)?.['/'])?.Proxy).find(p => typeof p === 'string');
    return typeof proxy === 'string' ? proxy : '';
  }
  async on(port: number, backend: string): Promise<void> {
    const help = await this.run(['serve', '--help'], true);
    if (!/--bg\b/.test(help) || !/--https\b/.test(help)) throw new TailscaleError(TAILSCALE_ERRORS[3]);
    if (await this.user(port) !== null) throw new TailscaleError(TAILSCALE_ERRORS[2]);
    await this.run(['serve', '--bg', `--https=${port}`, backend]);
    if (await this.user(port) !== backend) throw new TailscaleError(TAILSCALE_ERRORS[5]);
  }
  // Only AI Term's own entry (this port, proxying to this backend) is removed; true when it was.
  async off(port: number, backend: string): Promise<boolean> {
    if (await this.user(port) !== backend) return false;
    await this.run(['serve', `--https=${port}`, 'off']);
    return true;
  }
}
