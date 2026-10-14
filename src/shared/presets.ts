import type { AgentEngine, AuthRef, Effort, Permission } from './protocol.js';
import { ValidationError, isAgentEngine, isAuthRef, isEffortForEngine, isModel, isPermissionForEngine, isSafeAbsolutePath } from './validate.js';

// v0.6.2 (D55, on by default): a preset is a saved start setup for one new agent. It names an API key by its id only
// (never the key); Don't ask is kept only when it was the mode chosen when saving, and the started card shows its red !.
export interface Preset { engine: AgentEngine; model: string | null; effort: Effort | null; auth: AuthRef; permission: Permission; cwd: string; worktree: boolean; firstMessage?: string }
export const PRESET_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
// settings.json stays under its 16 KiB cap: twenty presets with short first messages fit; a long one is refused there.
export const MAX_PRESETS = 20, MAX_PRESET_MESSAGE_BYTES = 4096;
const KEYS = ['engine', 'model', 'effort', 'auth', 'permission', 'cwd', 'worktree', 'firstMessage'];
export function validatePreset(value: unknown): Preset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Invalid preset');
  const p = value as Record<string, unknown>;
  const message = p.firstMessage;
  if (Object.keys(p).some(k => !KEYS.includes(k)) || !isAgentEngine(p.engine) || !isModel(p.model) || !isEffortForEngine(p.engine, p.effort) || !isAuthRef(p.auth)
    || p.engine === 'ai-term' && p.auth.kind !== 'key' || !isPermissionForEngine(p.engine, p.permission) || !isSafeAbsolutePath(p.cwd) || typeof p.worktree !== 'boolean'
    || message !== undefined && (typeof message !== 'string' || !message.trim() || Buffer.byteLength(message) > MAX_PRESET_MESSAGE_BYTES || message.includes('\0')))
    throw new ValidationError('Invalid preset');
  return p as unknown as Preset;
}
export function validatePresets(value: unknown): Record<string, Preset> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Invalid presets');
  const entries = Object.entries(value);
  if (entries.length > MAX_PRESETS || entries.some(([name]) => !PRESET_NAME.test(name))) throw new ValidationError('Invalid presets');
  for (const [, preset] of entries) validatePreset(preset);
  return value as Record<string, Preset>;
}
