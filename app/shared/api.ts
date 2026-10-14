export type AppTheme = 'dark' | 'light';
export interface TerminalSize { cols: number; rows: number }
export interface TerminalApi {
  write(data: string): void;
  resize(size: TerminalSize): void;
  onOutput(callback: (data: string) => void): () => void;
  openUrl(url: string): Promise<void>;
  copy(text: string): Promise<void>;
  paste(): Promise<string>;
  onTheme(callback: (theme: AppTheme) => void): () => void;
}
export const channels = {
  write: 'terminal:write', resize: 'terminal:resize', output: 'terminal:output',
  openUrl: 'terminal:open-url', copy: 'terminal:copy', paste: 'terminal:paste', theme: 'terminal:theme',
} as const;
