import { execFile } from 'node:child_process';
// v0.8.2 Windows: the AI Term folder (%USERPROFILE%\.ai-term) is made yours alone with icacls (argv only): inherited
// entries removed, one entry granting your SID full control, inherited by everything inside. At each start the owner and
// the entries are read back (PowerShell, a fixed script; the path comes in an environment variable, never in the text).
const SID = /^S-1-5-21(?:-\d{1,10}){3,5}$|^S-1-5-(?:18|19|20)$|^S-1-12-1(?:-\d{1,10}){4}$/;
export function parseWhoamiSid(text: string): string | null {
  const sid = text.trim().match(/^"[^"]*","(S-[0-9-]+)"$/)?.[1];
  return sid && SID.test(sid) ? sid : null;
}
export function aclArgs(path: string, sid: string): string[] {
  if (!SID.test(sid)) throw new Error('Invalid SID');
  return [path, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/q'];
}
export const ownerScript = "$a = Get-Acl -LiteralPath $env:AITERM_ACL_PATH; $s = [System.Security.Principal.SecurityIdentifier]; $a.GetOwner($s).Value; $a.GetAccessRules($true, $true, $s) | ForEach-Object { $_.IdentityReference.Value }";
export function parseAcl(text: string): { owner: string; entries: string[] } | null {
  const [owner, ...entries] = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return owner && SID.test(owner) && entries.every(entry => SID.test(entry)) ? { owner, entries: [...new Set(entries)] } : null;
}
const system32 = (name: string): string => `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\${name}`;
const run = (file: string, args: readonly string[], env: Record<string, string> = {}): Promise<string> => new Promise((resolve, reject) => {
  execFile(file, [...args], { timeout: 30_000, windowsHide: true, env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', ...env } }, (error, stdout) => { if (error) reject(new Error('Windows ACL command failed')); else resolve(stdout); });
});
let sid: Promise<string> | null = null;
export function currentSid(): Promise<string> {
  sid ??= run(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh']).then(text => { const found = parseWhoamiSid(text); if (!found) throw new Error('Your Windows account could not be read'); return found; });
  return sid;
}
// Makes the folder yours alone (its contents inherit it).
export async function restrictToMe(path: string): Promise<void> { await run(system32('icacls.exe'), aclArgs(path, await currentSid())); }
// Yours alone: you own it and every entry is yours.
export async function checkMine(path: string): Promise<boolean> {
  const acl = parseAcl(await run(system32('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', ownerScript], { AITERM_ACL_PATH: path }));
  const me = await currentSid();
  return acl !== null && acl.owner === me && acl.entries.length > 0 && acl.entries.every(entry => entry === me);
}
