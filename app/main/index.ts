import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import {homedir} from 'node:os';
import {runtimePaths,runtimeEnv} from '../../src/shared/runtime-paths.js';
import {commandPlan,installCommand,uninstallCommand} from './command-install.js';
import {PtyLifecycle} from './pty-lifecycle.js';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isAppCommand, type AppCommand } from '../../src/shared/app-control.js';
import { appMenu, menuShortcut } from './menus.js';
import { spawn, type IPty } from 'node-pty';
import { Logger } from '../../src/daemon/log.js';
import { tokenColors } from '../../src/shared/theme-tokens.js';
import { channels, pasteErrors, type TerminalSize, type MenuAction } from '../shared/api.js';
import { MAX_COPY_BYTES, PasteRefusal, validateAppTheme, validateEmpty, validateOne, validatePaste, validateSize, validateUrl, validateWrite } from '../shared/validation.js';
import { CSP, denyPermissions, lockNavigation, secureWebPreferences } from './security.js';
import { ControlGate } from './control-gate.js';
import { describeExit, errorTag, inputAfterExit, rendererGone, startupFailed } from './failures.js';

const here = dirname(fileURLToPath(import.meta.url));
const runtime = runtimePaths(fileURLToPath(import.meta.url),app.isPackaged);
const root = runtime.root;
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
// Tests set this to their disposable HOME before Electron becomes ready.
if (process.env.AI_TERM_APP_DATA) app.setPath('userData', resolve(process.env.AI_TERM_APP_DATA));
app.setName('AI Term');
let window: BrowserWindow | undefined;
let terminal: IPty | undefined;
let ended = false;
const appToken = randomBytes(32).toString('hex');
const gate = new ControlGate(appToken);
let gateTimer: ReturnType<typeof setTimeout> | undefined;
// A held partial control prefix that no more output completes was ordinary text (control-gate.ts).
const GATE_FLUSH_MS = 15;
let closeNote = false;
let log: Logger;
let logReady = false;
const lifecycle=new PtyLifecycle(()=>{failure('Desktop terminal cleanup failed');});
let quitting=false,quitReady=false;
function output(data: string): void { if (window && !window.isDestroyed()) window.webContents.send(channels.output, data); }
// The terminal shows the fixed message; app.log also keeps the error's code or class (failures.ts).
function failure(message: string, error?: unknown): void { log.error(error === undefined ? message : `${message} (${errorTag(error)})`); output(`\r\n✗ ${message}\r\n`); }
function trusted(event: IpcMainEvent | IpcMainInvokeEvent): void {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== window.webContents.getURL()) throw new Error('Untrusted terminal sender');
}
function resize(size: TerminalSize): void {
  if(quitting)throw new Error('App is closing');
  if (inputAfterExit(ended) === 'drop') return;
  if (terminal) { terminal.resize(size.cols, size.rows); return; }
  // CLI startup inherits its caller's env today. Electron runs the built CLI in Node mode;
  // this flag also follows the CLI's normal detached daemon spawn. No key lookup occurs here.
  terminal = spawn(app.isPackaged?runtime.node:process.execPath, [runtime.entry], {
    name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd: app.isPackaged ? homedir() : root,
    env: runtimeEnv({ ...process.env, TERM_PROGRAM: 'AI_Term', COLORTERM: 'truecolor', AI_TERM_APP_TOKEN: appToken }),
  });
  const child = terminal;
  lifecycle.track(child);
  child.onData(data => {
    if (terminal !== child) return;
    if (gateTimer) clearTimeout(gateTimer);
    const shown = gate.output(data);
    if (shown) output(shown);
    if (gate.holding) gateTimer = setTimeout(() => { const rest = gate.flush(); if (rest) output(rest); }, GATE_FLUSH_MS);
  });
  child.onExit(({ exitCode, signal }) => {
    if (terminal !== child) return;
    terminal = undefined; ended = true;
    const exit = describeExit({ exitCode, ...(signal === undefined ? {} : { signal }) });
    output(`\r\n${exit.failed ? '✗' : '■'} ${exit.text} · close the window to finish\r\n`);
    if (exit.failed) log.error(`Desktop ${exit.text}`);
  });
}
function command(action: AppCommand): void {
  if (!terminal || !window || window.isDestroyed()) return;
  if (action !== 'theme-changed') menuAction('focus-terminal');
  // Before the client is on its own screen its PTY still echoes input: the control (and its token) would show.
  const control = gate.command(action);
  if (!control) return;
  try { terminal.write(control); } catch (error) { failure('Desktop command failed', error); }
}
function menuAction(action: MenuAction): void { window?.webContents.send(channels.menuAction, action); }
async function manageCommand(install:boolean):Promise<void> {
  if(!app.isPackaged){await dialog.showMessageBox({type:'info',message:'Install the packaged AI Term.app first.'});return;}
  try{
    const plan=commandPlan(homedir(),runtime.command);
    if(install){const answer=await dialog.showMessageBox({type:'question',message:'Install ai command?',detail:`Create if missing: ${join(plan.home,'.local')}\nCreate if missing: ${join(plan.home,'.local/bin')}\nCreate symlink: ${plan.link}\nPointing to: ${plan.target}\nExisting foreign entries are refused. No sudo or shell profile changes.`,buttons:['Cancel','Install'],defaultId:0,cancelId:0});if(answer.response!==1)return;await installCommand(plan);}
    else await uninstallCommand(plan);
    await dialog.showMessageBox({type:'info',message:install?'ai command installed':'ai command uninstalled',detail:install?`${plan.link} → ${plan.target}\nAdd ~/.local/bin to your Terminal PATH if needed.`:'Only this app’s exact symlink was eligible for removal.'});
  }catch(error){log.error(`Command installation operation failed (${errorTag(error)})`);await dialog.showMessageBox({type:'error',message:'Could not change ai command',detail:error instanceof Error?error.message:'Command operation failed'});}
}
function registerIpc(): void {
  const receive = (channel: string, action: (args: unknown[]) => void): void => {
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      try { trusted(event); action(args); } catch (error) { failure('Terminal message refused or operation failed', error); }
    });
  };
  receive(channels.write, args => {
    const data = validateWrite(validateOne(args));
    if (inputAfterExit(ended) === 'drop') return;
    if (!terminal) throw new Error('Terminal unavailable');
    terminal.write(data);
  });
  receive(channels.resize, args => { resize(validateSize(validateOne(args))); });
  receive(channels.themeApplied, args => {
    const theme = validateAppTheme(validateOne(args));
    if (theme === (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')) command('theme-changed');
  });
  receive(channels.menuAction, args => { validateEmpty(args); if (closeNote) { menuAction('close-note'); closeNote = false; } });
  receive(channels.theme, args => { validateEmpty(args); window?.webContents.send(channels.theme, nativeTheme.shouldUseDarkColors ? 'dark' : 'light'); });
  ipcMain.handle(channels.openUrl, async (event, ...args: unknown[]) => {
    try { trusted(event); await shell.openExternal(validateUrl(validateOne(args))); }
    // eslint-disable-next-line preserve-caught-error -- IPC exposes only fixed reasons; app.log keeps the error code.
    catch (error) { log.error(`External link refused or failed (${errorTag(error)})`); throw new Error('Could not open http/https link'); }
  });
  ipcMain.handle(channels.copy, async (event, ...args: unknown[]) => {
    try { trusted(event); await clipboard.writeText(validateWrite(validateOne(args), MAX_COPY_BYTES)); }
    // eslint-disable-next-line preserve-caught-error -- IPC exposes only fixed reasons; app.log keeps the error code.
    catch (error) { log.error(`Clipboard copy refused or failed (${errorTag(error)})`); throw new Error('Could not copy terminal selection'); }
  });
  ipcMain.handle(channels.paste, async (event, ...args: unknown[]) => {
    try { trusted(event); validateEmpty(args); return validatePaste(await clipboard.readText()); }
    catch (error) {
      log.error(`Clipboard paste refused or failed (${errorTag(error)})`);
      // eslint-disable-next-line preserve-caught-error -- IPC must expose only fixed reasons, never native clipboard errors.
      throw new Error(error instanceof PasteRefusal ? error.message : pasteErrors.unavailable);
    }
  });
}
function createWindow(): Promise<void> {
  ended = false;
  const colors = tokenColors(nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  window = new BrowserWindow({ title: 'AI Term', width: 1100, height: 720, minWidth: 480, minHeight: 300, backgroundColor: colors.bg, titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 14 }, webPreferences: secureWebPreferences(join(here, '../preload/index.cjs')) });
  window.setMenu(null);
  denyPermissions(window.webContents.session);
  lockNavigation(window.webContents);
  // File content only, in dev too. There is no localhost page or HMR websocket to allow.
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } });
  });
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.meta || input.alt || input.control) return;
    if (input.shift && !['+', '='].includes(input.key)) return;
    const shortcut = menuShortcut(input.key);
    if (!shortcut) return;
    event.preventDefault();
    if (shortcut === 'close') window?.close(); else if (shortcut === 'quit') app.quit();
    else if (isAppCommand(shortcut)) command(shortcut); else menuAction(shortcut);
  });
  window.on('closed', () => {
    window = undefined;
    // Only the outer ai client dies; its existing detached daemon and agents survive.
    const child = terminal; terminal = undefined;
    if (child) lifecycle.stop(child);
  });
  window.webContents.on('render-process-gone', (_event, details) => { log.error(rendererGone(details)); window?.close(); });
  return window.loadFile(join(here, '../renderer/index.html'));
}
void app.whenReady().then(async () => {
  const dataPath = app.getPath('userData');
  mkdirSync(dataPath, { recursive: true, mode: 0o700 });
  log = new Logger(join(dataPath, 'app.log')); logReady = true;
  log.on('writeFailed', () => { console.error('Desktop log could not be written'); });
  try { writeFileSync(join(dataPath, 'close-note-shown'), '', {flag:'wx',mode:0o600}); closeNote = true; }
  catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) { log.error('Desktop first-use note could not be saved'); closeNote = true; } }
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenu({command,action:menuAction,theme:source=>{nativeTheme.themeSource=source;},themeSource:nativeTheme.themeSource,install:()=>{void manageCommand(true);},uninstall:()=>{void manageCommand(false);}})));
  registerIpc();
  nativeTheme.on('updated', () => {
    if (!window || window.isDestroyed()) return;
    const mode = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    window.setBackgroundColor(tokenColors(mode).bg);
    window.webContents.send(channels.theme, mode);
  });
  app.on('activate', () => { if (!window&&!quitting) void createWindow().catch((error: unknown) => { startupFailed(error, { log, showErrorBox: (title, body) => { dialog.showErrorBox(title, body); }, quit: () => { app.quit(); } }); }); });
  await createWindow();
}).catch((error: unknown) => { startupFailed(error, { ...(logReady ? { log } : {}), showErrorBox: (title, body) => { dialog.showErrorBox(title, body); }, quit: () => { app.quit(); } }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit',event=>{
 if(quitReady)return;event.preventDefault();if(quitting)return;quitting=true;
 void lifecycle.finish().then(()=>{quitReady=true;app.quit();}).catch(()=>{console.error('AI Term terminal shutdown failed');});
});
