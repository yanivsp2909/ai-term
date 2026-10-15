import { execFile } from 'node:child_process';
// v0.8.2 Windows: the AI Term folder (%USERPROFILE%\.ai-term) is made yours alone with icacls (argv only): inherited
// entries removed, one entry granting your SID full control, inherited by everything inside. At each start the owner and
// the entries are read back (PowerShell, a fixed script; the path comes in an environment variable, never in the text).
const SID = /^S-1-5-21(?:-\d{1,10}){3,5}$|^S-1-5-(?:18|19|20)$|^S-1-5-32-544$|^S-1-12-1(?:-\d{1,10}){4}$/;
// An elevated process makes folders owned by Administrators (or SYSTEM): still yours when every entry is yours (review).
const OWNERS_TOO = ['S-1-5-32-544', 'S-1-5-18'];
export function parseWhoamiSid(text: string): string | null {
  const sid = text.trim().match(/^"[^"]*","(S-[0-9-]+)"$/)?.[1];
  return sid && SID.test(sid) ? sid : null;
}
export function aclArgs(path: string, sid: string): string[] {
  if (!SID.test(sid)) throw new Error('Invalid SID');
  return [path, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/q'];
}
// One run for several folders (AITERM_ACL_PATHS, split on |, which a Windows path can't hold): '#', the owner, the entries.
export const ownerScript = "$s = [System.Security.Principal.SecurityIdentifier]; foreach ($p in ($env:AITERM_ACL_PATHS -split '\\|')) { $a = Get-Acl -LiteralPath $p; '#'; $a.GetOwner($s).Value; $a.GetAccessRules($true, $true, $s) | ForEach-Object { $_.IdentityReference.Value } }";
export interface Acl { owner: string; entries: string[] }
export function parseAcls(text: string): (Acl | null)[] {
  return text.split(/^#\r?$/m).slice(1).map(part => parseAcl(part));
}
export function aclIsMine(acl: Acl | null, me: string): boolean {
  return acl !== null && (acl.owner === me || OWNERS_TOO.includes(acl.owner)) && acl.entries.length > 0 && acl.entries.every(entry => entry === me);
}
export function parseAcl(text: string): Acl | null {
  const [owner, ...entries] = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return owner && SID.test(owner) && entries.every(entry => SID.test(entry)) ? { owner, entries: [...new Set(entries)] } : null;
}
const system32 = (name: string): string => `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\${name}`;
// What whoami, icacls and PowerShell need: the system folder, its tools on PATH, PowerShell's own modules (Get-Acl lives
// in one; without PSModulePath it isn't found, as the v0.8 CI showed) and a temp folder. Nothing else of AI Term's env.
export function aclToolEnv(base: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const root = base.SystemRoot ?? 'C:\\Windows';
  return { SystemRoot: root, PATH: `${root}\\System32`, PSModulePath: `${root}\\System32\\WindowsPowerShell\\v1.0\\Modules`, ...base.TEMP ? { TEMP: base.TEMP } : {}, ...base.TMP ? { TMP: base.TMP } : {} };
}
// Which tool failed, in fixed words (its own output can carry paths).
const run = (file: string, args: readonly string[], env: Record<string, string> = {}): Promise<string> => new Promise((resolve, reject) => {
  execFile(file, [...args], { timeout: 60_000, windowsHide: true, env: { ...aclToolEnv(process.env), ...env } }, (error, stdout) => {
    if (error) reject(new Error(`Windows ACL command failed (${/whoami/i.test(file) ? 'whoami' : /icacls/i.test(file) ? 'icacls' : 'PowerShell'}${typeof error.code === 'number' ? ` exit ${error.code}` : ''})`)); else resolve(stdout);
  });
});
let sid: Promise<string> | null = null;
export function currentSid(): Promise<string> {
  sid ??= run(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh']).then(text => { const found = parseWhoamiSid(text); if (!found) throw new Error('Your Windows account could not be read'); return found; });
  return sid;
}
// Makes the folder yours alone (its contents inherit it).
export async function restrictToMe(path: string): Promise<void> { await run(system32('icacls.exe'), aclArgs(path, await currentSid())); }
// Yours alone, every one of them: owned by you (or Administrators, when elevated) and every entry is yours.
export async function checkMine(paths: string | readonly string[]): Promise<boolean> {
  const list = typeof paths === 'string' ? [paths] : [...paths];
  if (!list.length || list.some(path => path.includes('|'))) return false;
  const acls = parseAcls(await run(system32('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', ownerScript], { AITERM_ACL_PATHS: list.join('|') }));
  const me = await currentSid();
  return acls.length === list.length && acls.every(acl => aclIsMine(acl, me));
}
