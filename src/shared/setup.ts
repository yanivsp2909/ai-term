// v1.2 first-run setup: what the daemon found on this machine, shown on the homepage the first time and on `ai setup`.
// Every value is AI Term's own word or a version number it parsed; nothing a tool printed reaches the screen as is.
export const SETUP_TOOLS = ['claude-code', 'codex', 'cursor', 'gemini', 'copilot', 'gh', 'tailscale', 'ollama', 'lmstudio'] as const;
export type SetupToolId = typeof SETUP_TOOLS[number];
// found: on PATH and answering its version; "couldn't check": on PATH but its version check failed or took too long.
// login: what the CLI's own status command said; null where a login doesn't apply (Tailscale, Ollama, LM Studio).
export const SETUP_FOUND = ['found', 'not found', "couldn't check"] as const;
export const SETUP_LOGIN = ['logged in', 'not logged in', "couldn't check", 'logs in when it starts'] as const;
export interface SetupTool { id: SetupToolId; name: string; found: typeof SETUP_FOUND[number]; version: string | null; login: typeof SETUP_LOGIN[number] | null; install: string }
export interface SetupKey { label: string; provider: string; last4: string }
export interface SetupStatus { tools: SetupTool[]; keys: SetupKey[]; sandbox: 'sandbox-exec' | 'bwrap' | 'none'; sandboxNote: string | null }

const object = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const plain = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= max && !/[\p{C}]/u.test(v);
const keys = (o: Record<string, unknown>, ...names: string[]) => Object.keys(o).length === names.length && names.every(n => Object.hasOwn(o, n));
const VERSION = /^\d[\w.+-]{0,39}$/;
export function validateSetupStatus(value: unknown): SetupStatus {
  const v = object(value);
  const tool = (x: unknown) => { const t = object(x); return !!t && keys(t, 'id', 'name', 'found', 'version', 'login', 'install') && (SETUP_TOOLS as readonly unknown[]).includes(t.id) && plain(t.name, 60)
    && (SETUP_FOUND as readonly unknown[]).includes(t.found) && (t.version === null || typeof t.version === 'string' && VERSION.test(t.version)) && (t.login === null || (SETUP_LOGIN as readonly unknown[]).includes(t.login)) && plain(t.install, 160); };
  const key = (x: unknown) => { const k = object(x); return !!k && keys(k, 'label', 'provider', 'last4') && plain(k.label, 240) && plain(k.provider, 40) && typeof k.last4 === 'string' && /^[A-Za-z0-9_-]{0,4}$/.test(k.last4); };
  if (!v || !keys(v, 'tools', 'keys', 'sandbox', 'sandboxNote') || !Array.isArray(v.tools) || v.tools.length > SETUP_TOOLS.length || !v.tools.every(tool) || !Array.isArray(v.keys) || v.keys.length > 100 || !v.keys.every(key)
    || !['sandbox-exec', 'bwrap', 'none'].includes(String(v.sandbox)) || !(v.sandboxNote === null || plain(v.sandboxNote, 300))) throw new Error('Invalid setup status');
  return v as unknown as SetupStatus;
}
