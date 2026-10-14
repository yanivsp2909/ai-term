import type { TerminalApi } from '../../app/shared/api.js';
declare global { interface Window { terminal: TerminalApi } }
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let home: string;
let application: ElectronApplication;
test.beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ai-term-desktop-'));
  const state = join(home, '.ai-term');
  await mkdir(state, { mode: 0o700 });
  await writeFile(join(state, 'settings.json'), JSON.stringify({ theme: 'auto', notifications: false }));
  application = await electron.launch({ args: [resolve('app/out/main/index.js'), '--disable-background-networking', '--disable-component-update'], env: {
    HOME: home, AI_TERM_HOME: state, AI_TERM_APP_DATA: join(home, 'electron'), PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8',
  } });
});
// eslint-disable-next-line no-empty-pattern -- Playwright requires fixture destructuring even when none are used.
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) {
    for (const path of [join(home, "electron/app.log"), join(home, ".ai-term/logs/daemon.log")]) {
      try { console.log(await readFile(path, "utf8")); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    }
  }
  if (application) await application.close();
  // Stop only this test's daemon, using the pid in its private disposable home.
  try {
    const pid = Number(await readFile(join(home, '.ai-term/run/daemon.pid'), 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && ['ENOENT', 'ESRCH'].includes(String(error.code)))) throw error;
  }
  await rm(home, { recursive: true, force: true });
});

test('opens ai homepage, types immediately, preserves paste, searches and resizes', async () => {
  const page = await application.firstWindow();
  const screen = page.locator('.xterm-accessibility-tree');
  await expect(screen).toContainText('What do you want to build?');
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Escape');
  await expect(screen).not.toContainText('Connect a provider');
  await page.keyboard.type('desktop smoke');
  await expect(screen).toContainText('desktop smoke');
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(900, 600); });
  await expect(screen).toContainText('desktop smoke');
  await page.keyboard.press('Meta+e');
  await page.keyboard.press('Control+u');
  await application.evaluate(async ({ clipboard }) => { await clipboard.writeText('first line\nsecond line'); });
  await page.keyboard.press('Meta+v');
  await expect(screen).toContainText('pasted');
  await page.keyboard.press('Meta+k');
  await expect(page.getByRole('searchbox', { name: 'Search scrollback' }).or(page.getByRole('textbox', { name: 'Search scrollback' }))).toBeFocused();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+-');
  await page.keyboard.press('Meta+0');
});

test('runtime sandbox and preload expose only the seven operations', async () => {
  const page = await application.firstWindow();
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('What do you want to build?');
  expect(await page.evaluate(() => Object.keys(window.terminal).sort())).toEqual(['copy', 'onOutput', 'onTheme', 'openUrl', 'paste', 'resize', 'write'].sort());
  expect(await page.evaluate(() => ({ node: typeof Reflect.get(window, 'require'), process: typeof Reflect.get(window, 'process'), ipc: typeof Reflect.get(window, 'ipcRenderer') }))).toEqual({ node: 'undefined', process: 'undefined', ipc: 'undefined' });
  const preferences = await application.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents;
    const get = contents ? Reflect.get(contents, 'getLastWebPreferences') as (() => unknown) | undefined : undefined;
    return get?.call(contents);
  });
  expect(preferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false });
  expect(await page.evaluate(async () => {
    try { await window.terminal.openUrl('file:///tmp/no'); return false; } catch { return true; }
  })).toBe(true);
  expect(await page.evaluate(() => window.open('https://example.com'))).toBe(null);
  expect(application.windows()).toHaveLength(1);
});
