import { contextBridge, ipcRenderer } from 'electron';
import { channels, menuActions, type MenuAction, type TerminalApi } from '../shared/api.js';
import { validateLook } from '../shared/validation.js';
// Each wrapper has a fixed channel. IPC events never cross the context bridge.
const api: TerminalApi = {
  write: data => { ipcRenderer.send(channels.write, data); },
  resize: size => { ipcRenderer.send(channels.resize, size); },
  onOutput: callback => {
    const listener = (_event: unknown, data: unknown): void => { if (typeof data === 'string') callback(data); };
    ipcRenderer.on(channels.output, listener);
    return () => { ipcRenderer.removeListener(channels.output, listener); };
  },
  openUrl: url => ipcRenderer.invoke(channels.openUrl, url) as Promise<void>,
  copy: text => ipcRenderer.invoke(channels.copy, text) as Promise<void>,
  paste: () => ipcRenderer.invoke(channels.paste) as Promise<string>,
  onTheme: callback => {
    // Main's look is checked here before the renderer applies it (validation.ts); a refused one changes nothing.
    const listener = (_event: unknown, look: unknown): void => {
      let checked;
      try { checked = validateLook(look); } catch { console.error('AI Term: a window look was refused'); return; }
      callback(checked);
    };
    ipcRenderer.on(channels.theme, listener);
    ipcRenderer.send(channels.theme);
    return () => { ipcRenderer.removeListener(channels.theme, listener); };
  },
  themeApplied: theme => { ipcRenderer.send(channels.themeApplied, theme); },
  onMenuAction: callback => {
    const listener = (_event: unknown, action: unknown): void => { if (typeof action === 'string' && menuActions.includes(action as MenuAction)) callback(action as MenuAction); };
    ipcRenderer.on(channels.menuAction, listener);
    ipcRenderer.send(channels.menuAction);
    return () => { ipcRenderer.removeListener(channels.menuAction, listener); };
  },
};
contextBridge.exposeInMainWorld('terminal', api);
