import { watch, type FSWatcher } from 'node:fs';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { isBuiltinTheme } from '../../src/shared/theme-tokens.js';
import { readUserThemes, themesFolder, type ThemeList } from '../../src/shared/user-themes.js';
import { isFsError } from '../../src/shared/paths.js';
import { appLook, savedFonts } from '../shared/look.js';
import type { AppLook } from '../shared/api.js';

// v1.2.6: the app's main process reads the saved theme and fonts itself (settings.json and, for a theme of your own,
// the themes folder) and watches both, so the window follows a choice made in /theme or /settings at once, wherever ai
// runs. It reads only those three fields; nothing it reads is a secret, and a broken file gives the default look.
const SETTINGS_MAX_BYTES = 64 * 1024;
const NO_THEMES: ThemeList = { themes: [], refused: [] };
async function readSettings(root: string): Promise<{ saved: Record<string, unknown>; problem: string | null }> {
  let text: string;
  try {
    // A regular file only, opened without blocking (security review: a FIFO here held a thread at each watch event).
    const handle = await open(join(root, 'settings.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { if (!(await handle.stat()).isFile()) return { saved: {}, problem: "settings.json isn't a regular file" }; const buffer = Buffer.alloc(SETTINGS_MAX_BYTES + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); if (bytesRead > SETTINGS_MAX_BYTES) return { saved: {}, problem: 'settings.json is too big' }; text = buffer.subarray(0, bytesRead).toString('utf8'); }
    finally { await handle.close(); }
  } catch (error) { if (isFsError(error, 'ENOENT')) return { saved: {}, problem: null }; if (isFsError(error, 'ELOOP')) return { saved: {}, problem: "settings.json isn't a regular file" }; return { saved: {}, problem: `settings.json couldn't be read (${error instanceof Error && 'code' in error ? String(error.code) : 'error'})` }; }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { saved: {}, problem: "settings.json isn't valid JSON" }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { saved: {}, problem: "settings.json isn't a JSON object" };
  const v = value as Record<string, unknown>;
  return { saved: { theme: v.theme, themeVariant: v.themeVariant, appFonts: v.appFonts }, problem: null };
}
export async function readLook(root: string, nativeDark: boolean): Promise<{ look: AppLook; problem: string | null }> {
  const { saved, problem } = await readSettings(root);
  let list = NO_THEMES, themeProblem: string | null = null;
  if (typeof saved.theme === 'string' && !isBuiltinTheme(saved.theme) && saved.theme !== 'auto' && saved.theme !== 'light') {
    try { list = await readUserThemes(root); } catch (error) { themeProblem = `your theme files couldn't be read (${error instanceof Error && 'code' in error ? String(error.code) : 'error'})`; }
  }
  const fontsProblem = saved.appFonts !== undefined && savedFonts(saved.appFonts) === undefined ? 'the saved fonts are not valid; the defaults are used' : null;
  return { look: appLook(saved, list, nativeDark), problem: problem ?? themeProblem ?? fontsProblem };
}

// fs.watch on the AI Term folder (settings.json is replaced by a rename, so the folder sees it) and on the themes folder
// once it exists. Changes are batched for 50 ms: one save can arrive as several events.
const SETTLE_MS = 50;
export class LookWatcher {
  private watchers: FSWatcher[] = [];
  private themes?: FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly root: string, private readonly changed: () => void, private readonly failed: (message: string) => void) {}
  start(): void {
    try {
      const folder = watch(this.root, (_event, name) => { if (name === 'themes') this.watchThemes(); if (name === 'settings.json' || name === 'themes') this.soon(); });
      folder.on('error', () => { this.failed('The AI Term folder stopped being watched; restart the app to follow theme changes'); });
      this.watchers.push(folder);
    } catch (error) { this.failed(`The AI Term folder can't be watched (${error instanceof Error && 'code' in error ? String(error.code) : 'error'})`); }
    this.watchThemes();
  }
  private watchThemes(): void {
    this.themes?.close(); this.themes = undefined;
    try { this.themes = watch(themesFolder(this.root), () => { this.soon(); }); this.themes.on('error', () => { this.themes?.close(); this.themes = undefined; }); }
    catch (error) { if (!isFsError(error, 'ENOENT')) this.failed(`The themes folder can't be watched (${error instanceof Error && 'code' in error ? String(error.code) : 'error'})`); }
  }
  private soon(): void { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => { this.timer = undefined; this.changed(); }, SETTLE_MS); }
  stop(): void { if (this.timer) clearTimeout(this.timer); for (const w of this.watchers) w.close(); this.themes?.close(); this.watchers = []; this.themes = undefined; }
}
