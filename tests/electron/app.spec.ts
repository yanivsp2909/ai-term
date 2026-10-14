import type { TerminalApi } from '../../app/shared/api.js';
declare global { interface Window { terminal: TerminalApi } }
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Connection } from '../../src/client/connection.js';
import { getPaths } from '../../src/shared/paths.js';
import { tokenColors } from '../../src/shared/theme-tokens.js';
import { createTheme } from '../../src/client/tui/theme.js';

let home: string;
let application: ElectronApplication;
test.beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ai-term-desktop-'));
  const state = join(home, '.ai-term');
  await mkdir(state, { mode: 0o700 });
  await writeFile(join(state, 'settings.json'), JSON.stringify({ theme: 'graphite', notifications: false }));
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
  if (application) {
    await application.evaluate(async ({ clipboard }) => { await clipboard.clear(); });
    await application.close();
  }
  // Stop only this test's daemon, using the pid in its private disposable home.
  try {
    const pid = Number(await readFile(join(home, '.ai-term/run/daemon.pid'), 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && ['ENOENT', 'ESRCH'].includes(String(error.code)))) throw error;
  }
  await rm(home, { recursive: true, force: true });
});

// CDP dispatch bypasses Electron's before-input-event/native accelerators. Use
// Electron's input entry point for Command keys, and CDP for ordinary typing.
async function commandKey(key: string): Promise<void> {
  await application.evaluate(({BrowserWindow}, code) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents;
    contents?.sendInputEvent({type:'keyDown',keyCode:code,modifiers:['meta']});
    contents?.sendInputEvent({type:'keyUp',keyCode:code,modifiers:['meta']});
  }, key);
}

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
  await commandKey('E');
  await page.keyboard.press('Control+u');
  await application.evaluate(async ({ clipboard }) => { await clipboard.writeText('first line\nsecond line'); });
  await commandKey('V');
  await expect(screen).toContainText('pasted');
  await commandKey('F');
  await expect(page.getByRole('searchbox', { name: 'Search scrollback' }).or(page.getByRole('textbox', { name: 'Search scrollback' }))).toBeFocused();
  await page.keyboard.press('Escape');
  await commandKey('-');
  await commandKey('0');
});

test('runtime sandbox and preload expose only the nine operations', async () => {
  const page = await application.firstWindow();
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('What do you want to build?');
  expect(await page.evaluate(() => Object.keys(window.terminal).sort())).toEqual(['copy', 'onOutput', 'onTheme', 'onMenuAction', 'themeApplied', 'openUrl', 'paste', 'resize', 'write'].sort());
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

test('clipboard paste refuses a paste-end escape before it can become an approval key', async () => {
  const page = await application.firstWindow();
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('What do you want to build?');
  expect(await page.evaluate(async () => {
    await window.terminal.copy('\x1b[201~y');
    try { await window.terminal.paste(); return false; } catch { return true; }
  })).toBe(true);
  expect(await page.evaluate(async () => {
    const text = 'first line\nsecond line\x05';
    await window.terminal.copy(text);
    return await window.terminal.paste();
  })).toBe('first line\nsecond line\x05');
});

test('native Command shortcuts open palette, start, search, settings and select the first homepage agent', async () => {
  const page = await application.firstWindow(), screen = page.locator('.xterm-accessibility-tree');
  await expect(screen).toContainText('What do you want to build?');
  await expect(page.locator('.chrome')).toHaveText('Closing or quitting keeps your agents running.');
  await commandKey('E'); await expect(screen).not.toContainText('Connect a provider');
  await commandKey('K'); await expect(screen).toContainText('/settings');
  await commandKey('T'); await expect(screen).toContainText('Start a new agent');
  await commandKey('F'); await expect(page.getByRole('textbox',{name:'Search scrollback'})).toBeFocused();
  await page.keyboard.press('Escape');
  await commandKey(','); await expect(screen).toContainText('Settings');
  await commandKey('E'); await expect(screen).not.toContainText('Settings');
  const client = await Connection.connect(getPaths(join(home,'.ai-term')), {entry:resolve('dist/cli/index.js'),autoStart:false});
  try {
    for (const title of ['earlier smoke','latest smoke']) await client.request({kind:'sessions.create',engine:'shell',cwd:home,title});
    await expect(screen).toContainText('latest smoke');
    await commandKey('2');
    await expect.poll(()=>screen.evaluate(tree=>tree.children[1]?.textContent)).toContain('earlier smoke');
    await commandKey('1');
    await expect.poll(()=>screen.evaluate(tree=>tree.children[1]?.textContent)).toContain('latest smoke');
    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type(' ');
    await commandKey('2'); await expect.poll(()=>screen.evaluate(tree=>tree.children[1]?.textContent)).toContain('earlier smoke');
    await page.keyboard.type(' '); await commandKey('D');
    await expect(screen).toContainText('each pane is its own agent');
    await commandKey('E'); await expect(screen).toContainText('What do you want to build?');
    await commandKey('W'); await expect.poll(()=>application.windows().length).toBe(0);
    expect((await client.request({kind:'sessions.list'})).sessions).toHaveLength(2);
    await application.evaluate(({app})=>{app.emit('activate');});
    const reopened = await application.firstWindow();
    await expect(reopened.locator('.chrome')).toHaveText('AI Term');
    await expect(reopened.locator('.xterm-accessibility-tree')).toContainText('latest smoke');
  } finally {client.close();}
});

test('live native theme changes recolor the TUI through a fresh OSC11 probe', async () => {
  const page = await application.firstWindow();
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('What do you want to build?');
  await page.evaluate(() => {
    Reflect.set(window,'themeOutput','');
    window.terminal.onOutput(data=>{Reflect.set(window,'themeOutput', String(Reflect.get(window,'themeOutput')) + data);});
  });
  await application.evaluate(({nativeTheme})=>{nativeTheme.themeSource='light';});
  await expect.poll(()=>page.evaluate(()=>getComputedStyle(document.body).backgroundColor)).toBe('rgb(250, 250, 249)');
  for (const mode of ['dark','light','dark'] as const) {
    await page.evaluate(()=>{Reflect.set(window,'themeOutput','');});
    await application.evaluate(({nativeTheme},source)=>{nativeTheme.themeSource=source;},mode);
    const rgb = createTheme('auto',tokenColors(mode).bg).colors.ink.slice(1).match(/../g)?.map(hex=>Number.parseInt(hex,16)).join(';');
    await expect.poll(()=>page.evaluate(()=>getComputedStyle(document.body).backgroundColor)).toBe(`rgb(${tokenColors(mode).bg.slice(1).match(/../g)?.map(hex=>Number.parseInt(hex,16)).join(', ')})`);
    await expect.poll(()=>page.evaluate(()=>String(Reflect.get(window,'themeOutput')))).toContain('\x1b]11;?');
    await expect.poll(()=>page.evaluate(()=>String(Reflect.get(window,'themeOutput')))).toContain(`38;2;${rgb}`);
  }
});
test('native navigation closes search and returns typing focus to xterm', async () => {
  const page=await application.firstWindow(),screen=page.locator('.xterm-accessibility-tree');
  await expect(screen).toContainText('What do you want to build?');
  await commandKey('E');
  for(const key of ['K','T','E']){
    await commandKey('F'); await expect(page.getByRole('textbox',{name:'Search scrollback'})).toBeFocused();
    await commandKey(key);
    await expect(page.getByRole('textbox',{name:'Search scrollback'})).toHaveCount(0);
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    if(key==='T'){
      await expect(screen).toContainText('Start a new agent');
      for(let row=0;row<4;row++)await page.keyboard.press('ArrowDown');
      await page.keyboard.type('focus smoke');await expect(screen).toContainText('focus smoke');
    }
  }
});

test('a pasted authenticated control sequence does nothing in the real ai client', async () => {
  const page = await application.firstWindow(), screen = page.locator('.xterm-accessibility-tree');
  await expect(screen).toContainText('What do you want to build?');
  await commandKey('E'); await expect(screen).not.toContainText('Connect a provider');
  // Capture only this disposable launch's native menu write in memory. No token
  // accessor or test hook is added to the product/preload.
  await application.evaluate(async () => {
    const requireModule = process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json');
    const module: unknown = requireModule('node-pty/lib/unixTerminal.js');
    if (!module || typeof module !== 'object') throw new Error('No disposable PTY module');
    const constructor = Reflect.get(module,'UnixTerminal') as {prototype:{write(data:string):void}};
    const prototype = constructor.prototype, original = prototype.write;
    Reflect.set(globalThis,'restoreControlCapture',()=>{prototype.write=original;});
    prototype.write = function(data:string):void {
      if (data.startsWith('\x1b]777;ai-term;')) Reflect.set(globalThis,'capturedControl',data);
      original.call(this,data);
    };
  });
  try {
    await commandKey('K'); await expect(screen).toContainText('/settings');
    const sequence = await application.evaluate(()=>{
      const value: unknown = Reflect.get(globalThis,'capturedControl');
      if (typeof value !== 'string') throw new Error('No disposable control captured');
      return value;
    });
    await commandKey('E'); await expect(screen).not.toContainText('/settings');
    await page.evaluate(data=>{window.terminal.write('\x1b[200~'+data+'\x1b[201~');},sequence);
    await page.waitForTimeout(100);
    await expect(screen).not.toContainText('/settings');
    await expect(screen).toContainText('What do you want to build?');
  } finally {
    await application.evaluate(()=>{const restore:unknown=Reflect.get(globalThis,'restoreControlCapture');if(typeof restore==='function')restore();});
  }
});
