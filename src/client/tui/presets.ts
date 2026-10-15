import { stat } from 'node:fs/promises';
import type { CliEngine, KeyView } from '../../shared/protocol.js';
import { accountAuthLabel } from './accounts.js';
import { engineLabel } from '../../shared/models.js';
import { keyAuthLabel } from '../../shared/providers.js';
import { PRESET_NAME, type Preset } from '../../shared/presets.js';
import { isFsError } from '../../shared/paths.js';

// v0.6.2 /preset: save <name> [first message] · <name> · rm <name> · (nothing) lists them.
export type PresetCommand = { kind: 'list' } | { kind: 'save'; name: string; firstMessage?: string } | { kind: 'rm'; name: string } | { kind: 'use'; name: string } | { kind: 'error'; text: string };
const USAGE = '/preset · /preset <name> · /preset save <name> [first message] · /preset rm <name>';
export function parsePresetCommand(text: string): PresetCommand {
  const words = text.trim().split(/\s+/).slice(1), [first, name, ...rest] = words;
  if (!first) return { kind: 'list' };
  const valid = (value: string | undefined): value is string => !!value && PRESET_NAME.test(value);
  if (first === 'save') {
    if (!valid(name)) return { kind: 'error', text: `${USAGE} · names: a-z, 0-9 and -, up to 32` };
    // The first message keeps its own spacing: everything after the name.
    const message = text.trim().replace(/^\/preset\s+save\s+\S+\s*/, '');
    return { kind: 'save', name, ...(message ? { firstMessage: message } : {}) };
  }
  if (first === 'rm') return valid(name) && !rest.length ? { kind: 'rm', name } : { kind: 'error', text: USAGE };
  return valid(first) && words.length === 1 ? { kind: 'use', name: first } : { kind: 'error', text: USAGE };
}
// One line saying why a saved preset can't start now: its key was removed, or its folder is gone.
export async function presetProblem(name: string, preset: Preset, keys: readonly KeyView[]): Promise<string | null> {
  const auth = preset.auth;
  if (auth.kind === 'key' && !keys.some(key => key.id === auth.keyId)) return `preset ${name}: its API key was removed · save it again with another key`;
  try { if (!(await stat(preset.cwd)).isDirectory()) return `preset ${name}: folder ${preset.cwd} is gone`; }
  catch (error) { return isFsError(error, 'ENOENT') || isFsError(error, 'ENOTDIR') ? `preset ${name}: folder ${preset.cwd} is gone` : `preset ${name}: folder ${preset.cwd} can't be read`; }
  return null;
}
export function presetAuthLabel(preset: Preset, keys: readonly KeyView[], defaults: Partial<Record<CliEngine, string>> = {}): string {
  const auth = preset.auth;
  if (auth.kind === 'account') return accountAuthLabel(auth, preset.engine, defaults, 'own login');
  const key = keys.find(k => k.id === auth.keyId);
  return key ? keyAuthLabel(key.provider, key.last4) : 'removed key';
}
export function presetLines(presets: Readonly<Record<string, Preset>>, keys: readonly KeyView[], defaults: Partial<Record<CliEngine, string>> = {}): string[] {
  return Object.entries(presets).sort(([a], [b]) => a.localeCompare(b)).map(([name, p]) =>
    `${name} · ${p.model ?? 'CLI default'} · ${engineLabel(p.engine)} · ${presetAuthLabel(p, keys, defaults)} · ${p.permission === 'dontAsk' ? "! don't ask" : p.permission} · ${p.cwd} · worktree ${p.worktree ? 'on' : 'off'}${p.firstMessage ? ` · first message: ${p.firstMessage.split('\n')[0] ?? ''}` : ''}`);
}
