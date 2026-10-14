import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeTheme, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { spawn, type IPty } from 'node-pty';
import { Logger } from '../../src/daemon/log.js';
import { tokenColors } from '../../src/shared/theme-tokens.js';
import { channels, pasteErrors, type TerminalSize } from '../shared/api.js';
import { MAX_COPY_BYTES, PasteRefusal, validateEmpty, validateOne, validatePaste, validateSize, validateUrl, validateWrite } from '../shared/validation.js';
import { CSP, denyPermissions, lockNavigation, secureWebPreferences } from './security.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
// Tests set this to their disposable HOME before Electron becomes ready.
if (process.env.AI_TERM_APP_DATA) app.setPath('userData', resolve(process.env.AI_TERM_APP_DATA));
app.setName('AI Term');
let window: BrowserWindow | undefined;
let terminal: IPty | undefined;
let ended = false;
let log: Logger;
function output(data: string): void { if (window && !window.isDestroyed()) window.webContents.send(channels.output, data); }
function failure(message: string): void { log.error(message); output(`\r\n✗ ${message}\r\n`); }
function trusted(event: IpcMainEvent | IpcMainInvokeEvent): void {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== window.webContents.getURL()) throw new Error('Untrusted terminal sender');
}
function resize(size: TerminalSize): void {
  if (ended) throw new Error('Terminal has exited');
  if (terminal) { terminal.resize(size.cols, size.rows); return; }
  // CLI startup inherits its caller's env today. Electron runs the built CLI in Node mode;
  // this flag also follows the CLI's normal detached daemon spawn. No key lookup occurs here.
  terminal = spawn(process.execPath, [join(root, 'dist/cli/index.js')], {
    name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TERM_PROGRAM: 'AI_Term', COLORTERM: 'truecolor' },
  });
  terminal.onData(output);
  terminal.onExit(({ exitCode }) => {
    terminal = undefined; ended = true;
    output(`\r\n■ ai exited (${exitCode}) · close the window to finish\r\n`);
    if (exitCode !== 0) log.error('Desktop ai process exited unsuccessfully');
  });
}
function registerIpc(): void {
  const receive = (channel: string, action: (args: unknown[]) => void): void => {
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      try { trusted(event); action(args); } catch { failure('Terminal message refused or operation failed'); }
    });
  };
  receive(channels.write, args => {
    const data = validateWrite(validateOne(args));
    if (!terminal) throw new Error('Terminal unavailable');
    terminal.write(data);
  });
  receive(channels.resize, args => { resize(validateSize(validateOne(args))); });
  receive(channels.theme, args => { validateEmpty(args); window?.webContents.send(channels.theme, nativeTheme.shouldUseDarkColors ? 'dark' : 'light'); });
  ipcMain.handle(channels.openUrl, async (event, ...args: unknown[]) => {
    try { trusted(event); await shell.openExternal(validateUrl(validateOne(args))); }
    catch { log.error('External link refused or failed'); throw new Error('Could not open http/https link'); }
  });
  ipcMain.handle(channels.copy, async (event, ...args: unknown[]) => {
    try { trusted(event); await clipboard.writeText(validateWrite(validateOne(args), MAX_COPY_BYTES)); }
    catch { log.error('Clipboard copy refused or failed'); throw new Error('Could not copy terminal selection'); }
  });
  ipcMain.handle(channels.paste, async (event, ...args: unknown[]) => {
    try { trusted(event); validateEmpty(args); return validatePaste(await clipboard.readText()); }
    catch (error) { log.error('Clipboard paste refused or failed'); throw new Error(error instanceof PasteRefusal ? error.message : pasteErrors.unavailable); }
  });
}
void app.whenReady().then(async () => {
  const dataPath = app.getPath('userData');
  mkdirSync(dataPath, { recursive: true, mode: 0o700 });
  log = new Logger(join(dataPath, 'app.log'));
  log.on('writeFailed', () => { console.error('Desktop log could not be written'); });
  // Keep the application menu minimal so native Edit/View accelerators cannot
  // compete with xterm's clipboard, search and font shortcuts.
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'AI Term', submenu: [{ role: 'quit' }] }]));
  const colors = tokenColors(nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  window = new BrowserWindow({ title: 'AI Term', width: 1100, height: 720, minWidth: 480, minHeight: 300, backgroundColor: colors.bg, webPreferences: secureWebPreferences(join(here, '../preload/index.cjs')) });
  window.setMenu(null);
  denyPermissions(window.webContents.session);
  lockNavigation(window.webContents);
  // File content only, in dev too. There is no localhost page or HMR websocket to allow.
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } });
  });
  registerIpc();
  nativeTheme.on('updated', () => {
    if (!window || window.isDestroyed()) return;
    const mode = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    window.setBackgroundColor(tokenColors(mode).bg);
    window.webContents.send(channels.theme, mode);
  });
  window.on('closed', () => {
    window = undefined;
    // Only the outer ai client dies; its existing detached daemon and agents survive.
    if (terminal) { try { terminal.kill(); } catch { log.error('Desktop terminal cleanup failed'); } terminal = undefined; }
  });
  window.webContents.on('render-process-gone', () => { log.error('Desktop renderer exited'); window?.close(); });
  await window.loadFile(join(here, '../renderer/index.html'));
}).catch(() => { console.error('AI Term desktop startup failed'); app.quit(); });
app.on('window-all-closed', () => { app.quit(); });
