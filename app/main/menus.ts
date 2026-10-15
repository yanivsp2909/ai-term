import type { MenuItemConstructorOptions } from 'electron';
import type { AppCommand } from '../../src/shared/app-control.js';
import type { MenuAction } from '../shared/api.js';
export type ThemeSource = 'system' | 'light' | 'dark';
export interface MenuHandlers {
  command(command: AppCommand): void;
  action(action: MenuAction): void;
  theme(source: ThemeSource): void;
  themeSource: ThemeSource;
  install?():void;
  uninstall?():void;
}
// Linux and Windows (v0.8): Ctrl+Shift+key, as terminal apps there do (Ctrl+C, Ctrl+T and the like belong to the agent);
// the ai command install and the hide roles are macOS's.
export function accelerator(spec: string, platform: NodeJS.Platform = process.platform): string { return platform === 'darwin' ? spec : spec.replace(/^Command\+/, 'Ctrl+Shift+'); }
export function appMenu(handlers: MenuHandlers, platform: NodeJS.Platform = process.platform): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin';
  const command = (label: string, keys: string, action: AppCommand): MenuItemConstructorOptions => ({label, accelerator: accelerator(keys, platform), click:()=>handlers.command(action)});
  const action = (label: string, keys: string, item: MenuAction): MenuItemConstructorOptions => ({label, accelerator: accelerator(keys, platform), click:()=>handlers.action(item)});
  return [
    {label:'AI Term',submenu:mac?[{role:'about'},command('Settings…','Command+,','settings'),{type:'separator'},{label:'Install `ai` command…',click:()=>handlers.install?.()},{label:'Uninstall `ai` command',click:()=>handlers.uninstall?.()},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit'}]:[{role:'about'},command('Settings…','Command+,','settings'),{type:'separator'},{role:'quit'}]},
    {label:'File',submenu:[command('New Agent','Command+T','new-agent'),command('Home','Command+E','home'),command('Command Palette','Command+K','palette'),command('Split Marked Agents','Command+D','split'),{type:'separator'},...Array.from({length:9},(_,index)=>command(`Select Agent ${index+1}`,`Command+${index+1}`,`select ${index+1}` as AppCommand)),{type:'separator'},{role:'close',accelerator:accelerator('Command+W',platform)}]},
    {label:'Edit',submenu:[action('Copy','Command+C','copy'),action('Paste','Command+V','paste'),action('Select All','Command+A','select-all'),{type:'separator'},action('Find…','Command+F','find')]},
    {label:'View',submenu:[action('Increase Font Size','Command+Plus','font-increase'),action('Decrease Font Size','Command+-','font-decrease'),action('Reset Font Size','Command+0','font-reset'),{type:'separator'},...(['system','light','dark'] as const).map(source=>({label:source==='system'?'Use System Appearance':source==='light'?'Light':'Dark',type:'radio' as const,checked:handlers.themeSource===source,click:()=>handlers.theme(source)}))]},
    {label:'Window',submenu:mac?[{role:'minimize'},{role:'zoom'},{type:'separator'},{role:'front'}]:[{role:'minimize'}]},
  ];
}
// The same mapping handles webContents key events and native menu clicks. This
// also keeps accelerators working while a search/form field has focus.
export function menuShortcut(key: string): AppCommand | MenuAction | 'close' | 'quit' | undefined {
  const commands: Record<string, AppCommand | MenuAction | 'close' | 'quit'> = {k:'palette',t:'new-agent',d:'split',e:'home',',':'settings',c:'copy',v:'paste',a:'select-all',f:'find','+':'font-increase','=':'font-increase','-':'font-decrease','0':'font-reset',w:'close',q:'quit'};
  return /^[1-9]$/.test(key) ? `select ${key}` as AppCommand : commands[key.toLowerCase()];
}
