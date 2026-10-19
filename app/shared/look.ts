import { isBuiltinTheme, themeColors, type ThemeVariant } from '../../src/shared/theme-tokens.js';
import { fontStacks, validateAppFonts, type AppFonts } from '../../src/shared/app-fonts.js';
import { isThemeName, isThemeVariant } from '../../src/shared/validate.js';
import type { ThemeList } from '../../src/shared/user-themes.js';
import type { AppLook } from './api.js';

// v1.2.6: what the app's window wears, from the saved settings (read by main, never by the renderer). The variant you
// never set is system here, so the window follows macOS as it always did; auto keeps graphite by macOS, which ai then
// matches. A theme file that's gone, or saved fonts that aren't valid, give graphite and the default fonts.
export interface SavedLook { theme?: unknown; themeVariant?: unknown; appFonts?: unknown }
export function savedFonts(value: unknown): AppFonts | undefined {
  if (value === undefined) return undefined;
  try { return validateAppFonts(value); } catch { return undefined; }
}
export function appLook(saved: SavedLook, list: ThemeList, nativeDark: boolean): AppLook {
  const native: ThemeVariant = nativeDark ? 'dark' : 'light';
  const name = isThemeName(saved.theme) ? saved.theme : 'graphite', variant = isThemeVariant(saved.themeVariant) ? saved.themeVariant : 'system';
  const mode: ThemeVariant = name === 'auto' ? native : name === 'light' ? 'light' : variant === 'system' ? native : variant;
  const colors = isBuiltinTheme(name) ? themeColors(name, mode) : list.themes.find(t => t.name === name)?.[mode] ?? themeColors('graphite', mode);
  return { mode, colors: { ...colors }, fonts: fontStacks(savedFonts(saved.appFonts)) };
}
