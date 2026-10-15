// Who owns a file and whether only its owner can use it. POSIX: the uid and the 0o077 bits. Windows (v0.8.2): stat has
// no owner (uid is 0) and invented modes, so the check there is the AI Term folder's ACL (win-acl.ts), set when it is made
// and verified at start; everything inside inherits it.
export function ownedByMe(stat: { uid: number }, platform: NodeJS.Platform = process.platform, uid: number | undefined = process.getuid?.()): boolean {
  return platform === 'win32' ? true : stat.uid === uid;
}
export function privateMode(stat: { mode: number }, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? true : (stat.mode & 0o077) === 0;
}
