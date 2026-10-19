import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BASE_COLOR_NAMES, DERIVED_COLORS, deriveColors, isBuiltinTheme, type ColorName, type Colors } from './theme-tokens.js';
import { isFsError } from './paths.js';

// v1.2.6: a theme of your own is ~/.ai-term/themes/<name>.json: an optional name (its label) and a dark and a light set
// with every base token of docs/design/tokens.json. A file that is incomplete or wrong in any way is refused whole, with
// one line saying what's wrong; nothing of it is used. The daemon reads the folder for the TUI (themes.list) and the
// app's main process reads it for its own window; the files only ever hold colors, so a refusal is the worst outcome.
export interface UserTheme { name: string; label: string; dark: Colors; light: Colors }
export interface ThemeRefusal { file: string; reason: string }
export interface ThemeList { themes: UserTheme[]; refused: ThemeRefusal[] }
export const THEME_FILE_MAX_BYTES = 16 * 1024;
export const MAX_THEME_FILES = 32;
const FILE = /^([a-z0-9][a-z0-9-]{0,30})\.json$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const MAX_LISTED_MISSING = 6;
export function themesFolder(root: string): string { return join(root, 'themes'); }
export function isUserThemeName(value: unknown): value is string { return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,30}$/.test(value); }
const printable = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 1 && [...value].length <= max && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value);
// A name from the file goes into a reason as printable ASCII only (it is shown on screen and checked as printable).
const shown = (name: string): string => name.replace(/[^\x20-\x7e]/g, '?').slice(0, 40);
// Refusing to save a theme that can't be used: its one line reaches the client as is (the daemon passes ThemeError).
export class ThemeError extends Error {}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

type Parsed = { ok: true; theme: UserTheme } | { ok: false; refusal: ThemeRefusal };
function variantProblem(sets: Record<string, unknown>): string | null {
  const missing: string[] = [];
  for (const variant of ['dark', 'light'] as const) {
    const set = sets[variant];
    if (set !== undefined && !record(set)) return `${variant} must be an object of token colors`;
    for (const name of BASE_COLOR_NAMES) if (!record(set) || set[name] === undefined) missing.push(`${variant}.${name}`);
  }
  for (const variant of ['dark', 'light'] as const) {
    const set = sets[variant]; if (!record(set)) continue;
    for (const [name, value] of Object.entries(set)) {
      const derived = DERIVED_COLORS.get(name as ColorName);
      if (derived) return `${variant}.${name} is derived (= ${derived}); leave it out`;
      if (!BASE_COLOR_NAMES.includes(name as ColorName)) return `unknown token ${variant}.${shown(name)}`;
      if (typeof value !== 'string' || !HEX.test(value)) return `${variant}.${name} isn't a #rrggbb color`;
    }
  }
  if (!missing.length) return null;
  const listed = missing.slice(0, MAX_LISTED_MISSING).join(', ');
  return missing.length > MAX_LISTED_MISSING ? `missing ${listed} and ${missing.length - MAX_LISTED_MISSING} more` : `missing ${listed}`;
}
const lower = (set: Record<string, unknown>): Partial<Colors> => Object.fromEntries(Object.entries(set).map(([k, v]) => [k, String(v).toLowerCase()]));
export function parseUserTheme(file: string, text: string): Parsed {
  const refuse = (reason: string): Parsed => ({ ok: false, refusal: { file, reason } });
  const name = file.match(FILE)?.[1];
  if (!name) return refuse('file name must be lowercase letters, digits and dashes, then .json');
  if (isBuiltinTheme(name) || name === 'auto' || name === 'light') return refuse(`takes the built-in name ${name}; rename the file`);
  if (Buffer.byteLength(text) > THEME_FILE_MAX_BYTES) return refuse('bigger than 16 KB');
  let value: unknown;
  try { value = JSON.parse(text); } catch { return refuse("isn't valid JSON"); }
  if (!record(value)) return refuse("isn't a JSON object");
  const extra = Object.keys(value).find(k => !['name', 'dark', 'light'].includes(k));
  if (extra !== undefined) return refuse(`unknown field ${shown(extra)}; a theme has name, dark and light`);
  if (value.name !== undefined && !printable(value.name, 32)) return refuse('name must be 1 to 32 printable characters');
  const problem = variantProblem(value);
  if (problem) return refuse(problem);
  const dark = value.dark as Record<string, unknown>, light = value.light as Record<string, unknown>;
  return { ok: true, theme: { name, label: typeof value.name === 'string' ? value.name : name, dark: deriveColors(lower(dark)), light: deriveColors(lower(light)) } };
}

// Regular files only, opened without following a link, size-capped before reading: the folder is yours, but a link in
// it could name anything (a FIFO would block, a huge file would be read whole).
async function readCapped(path: string): Promise<{ text: string } | { problem: string }> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (isFsError(error, 'ELOOP')) return { problem: "isn't a regular file" }; if (error instanceof Error && 'code' in error) return { problem: `couldn't be read (${String(error.code)})` }; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { problem: "isn't a regular file" };
    const buffer = Buffer.alloc(Math.min(info.size, THEME_FILE_MAX_BYTES + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, bytesRead).toString('utf8') };
  } finally { await handle.close(); }
}
export async function readUserThemes(root: string): Promise<ThemeList> {
  const folder = themesFolder(root);
  let names: string[];
  try {
    if (!(await lstat(folder)).isDirectory()) return { themes: [], refused: [{ file: 'themes', reason: "isn't a folder" }] };
    names = (await readdir(folder)).filter(n => n.endsWith('.json')).sort();
  } catch (error) { if (isFsError(error, 'ENOENT')) return { themes: [], refused: [] }; throw error; }
  const themes: UserTheme[] = [], refused: ThemeRefusal[] = [];
  for (const file of names.slice(0, MAX_THEME_FILES)) {
    const read = await readCapped(join(folder, file));
    if ('problem' in read) { refused.push({ file, reason: read.problem }); continue; }
    const parsed = parseUserTheme(file, read.text);
    if (parsed.ok) themes.push(parsed.theme); else refused.push(parsed.refusal);
  }
  if (names.length > MAX_THEME_FILES) refused.push({ file: 'themes', reason: `only the first ${MAX_THEME_FILES} files are read` });
  return { themes, refused };
}

// One line saying why a theme name can't be used now, or null when it can (the homepage notes it, the daemon refuses to
// save it).
export function themeProblem(list: ThemeList, name: string): string | null {
  if (isBuiltinTheme(name) || name === 'auto' || name === 'light' || list.themes.some(t => t.name === name)) return null;
  const refused = list.refused.find(r => r.file === `${name}.json`);
  return refused ? `theme ${name} can't be used (${refused.reason})` : `theme ${name} isn't in ~/.ai-term/themes`;
}
function validColors(value: unknown): value is Colors {
  return record(value) && Object.keys(value).length === BASE_COLOR_NAMES.length + DERIVED_COLORS.size && Object.entries(value).every(([k, v]) => (BASE_COLOR_NAMES.includes(k as ColorName) || DERIVED_COLORS.has(k as ColorName)) && typeof v === 'string' && HEX.test(v));
}
// What crosses the socket (themes.list) or reaches the app's window is checked again on arrival.
export function validateThemeList(value: unknown): ThemeList {
  if (!record(value) || Object.keys(value).length !== 2 || !Array.isArray(value.themes) || !Array.isArray(value.refused) || value.themes.length > MAX_THEME_FILES || value.refused.length > MAX_THEME_FILES + 1) throw new Error('Invalid theme list');
  for (const theme of value.themes as unknown[]) {
    if (!record(theme) || Object.keys(theme).length !== 4 || !isUserThemeName(theme.name) || !printable(theme.label, 32) || !validColors(theme.dark) || !validColors(theme.light)) throw new Error('Invalid theme list');
  }
  for (const refusal of value.refused as unknown[]) {
    if (!record(refusal) || Object.keys(refusal).length !== 2 || !printable(refusal.file, 80) || !printable(refusal.reason, 200)) throw new Error('Invalid theme list');
  }
  return { themes: value.themes as UserTheme[], refused: value.refused as ThemeRefusal[] };
}
