import { describe, expect, it, vi } from 'vitest';
import { CSP, secureWebPreferences, lockNavigation, denyPermissions } from '../app/main/security.js';

describe('Electron security boundary', () => {
  it('keeps the renderer isolated and sandboxed', () => {
    expect(secureWebPreferences('/preload.cjs')).toMatchObject({ preload: '/preload.cjs', contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false });
    expect(CSP).toContain("default-src 'none'");
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).toContain("connect-src 'none'");
    expect(CSP).not.toContain('unsafe-eval');
    expect(CSP).not.toContain('https:');
  });
  it('blocks navigation, redirects, frames and every new window', () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    let open: (() => { action: string }) | undefined;
    lockNavigation({ on: (name, handler) => { handlers.set(name, handler); }, setWindowOpenHandler: handler => { open = handler; } });
    for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
      const preventDefault = vi.fn();
      handlers.get(name)?.({ preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
    }
    expect(open?.()).toEqual({ action: 'deny' });
  });
  it('denies both permission requests and checks', () => {
    let request: ((contents: unknown, permission: unknown, callback: (allow: boolean) => void) => void) | undefined;
    let check: (() => boolean) | undefined;
    denyPermissions({ setPermissionRequestHandler: handler => { request = handler; }, setPermissionCheckHandler: handler => { check = handler; } });
    const callback = vi.fn(); request?.({}, 'clipboard-read', callback);
    expect(callback).toHaveBeenCalledWith(false); expect(check?.()).toBe(false);
  });
});
