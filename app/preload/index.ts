import { contextBridge, ipcRenderer } from 'electron';
import { channels, type AppTheme, type TerminalApi } from '../shared/api.js';
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
    const listener = (_event: unknown, theme: unknown): void => { if (theme === 'dark' || theme === 'light') callback(theme satisfies AppTheme); };
    ipcRenderer.on(channels.theme, listener);
    ipcRenderer.send(channels.theme);
    return () => { ipcRenderer.removeListener(channels.theme, listener); };
  },
};
contextBridge.exposeInMainWorld('terminal', api);
