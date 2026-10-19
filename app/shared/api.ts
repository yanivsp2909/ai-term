export type AppTheme = 'dark' | 'light';
// v1.2.6: the saved theme in the variant the window shows, and the app fonts as CSS font stacks (app/shared/look.ts).
export interface AppLook { mode: AppTheme; colors: import('../../src/shared/theme-tokens.js').Colors; fonts: import('../../src/shared/app-fonts.js').FontStacks }
export const menuActions = ['copy', 'paste', 'select-all', 'find', 'font-increase', 'font-decrease', 'font-reset', 'close-note', 'focus-terminal'] as const;
export type MenuAction = typeof menuActions[number];
export const pasteErrors = {
  controls: 'Paste contains terminal escape controls',
  size: 'Paste exceeds 64 KiB',
  unavailable: 'Clipboard is unavailable',
} as const;
export interface TerminalSize { cols: number; rows: number }
export interface TerminalApi {
  write(data: string): void;
  resize(size: TerminalSize): void;
  onOutput(callback: (data: string) => void): () => void;
  openUrl(url: string): Promise<void>;
  copy(text: string): Promise<void>;
  paste(): Promise<string>;
  onTheme(callback: (look: AppLook) => void): () => void;
  themeApplied(theme: AppTheme): void;
  onMenuAction(callback: (action: MenuAction) => void): () => void;
}
export const channels = {
  write: 'terminal:write', resize: 'terminal:resize', output: 'terminal:output',
  openUrl: 'terminal:open-url', copy: 'terminal:copy', paste: 'terminal:paste', theme: 'terminal:theme',
  themeApplied: 'terminal:theme-applied', menuAction: 'terminal:menu-action',
} as const;
