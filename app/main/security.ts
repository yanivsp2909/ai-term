import type { WebPreferences } from 'electron';
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
export function secureWebPreferences(preload: string): WebPreferences {
  return { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false };
}
interface NavigationTarget {
  on(name: string, handler: (...args: unknown[]) => void): unknown;
  setWindowOpenHandler(handler: () => { action: 'deny' }): void;
}
export function lockNavigation(contents: NavigationTarget): void {
  const prevent = (event: unknown): void => {
    if (event && typeof event === 'object' && 'preventDefault' in event && typeof event.preventDefault === 'function') event.preventDefault();
  };
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) contents.on(name, prevent);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}
interface PermissionTarget {
  setPermissionRequestHandler(handler: (contents: unknown, permission: unknown, callback: (allow: boolean) => void) => void): void;
  setPermissionCheckHandler(handler: () => boolean): void;
}
export function denyPermissions(session: PermissionTarget): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false); });
  session.setPermissionCheckHandler(() => false);
}
// The packaged app is never remotely debuggable: a CDP or inspector port would drive the page and read the app-control token
// (S23/S24). The Node inspector fuse is off too (scripts/package-app.mjs); Chromium's switches are refused here.
const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk', 'inspect-port'] as const;
export function debugSwitch(hasSwitch: (name: string) => boolean, packaged: boolean): string | null {
  return packaged ? DEBUG_SWITCHES.find(name => hasSwitch(name)) ?? null : null;
}
