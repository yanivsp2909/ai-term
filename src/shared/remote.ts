// v1.0.8 /remote (D54): your phone reaches AI Term over your own tailnet while /remote is on. The daemon's phone server
// listens on 127.0.0.1 only; `tailscale serve` publishes it over HTTPS on REMOTE_HTTPS_PORT, a port of its own, so your
// other serve settings are never touched.
export const REMOTE_HTTPS_PORT = 8443;
export const REMOTE_IDLE_MS = 30 * 60_000, REMOTE_CODE_MS = 2 * 60_000;
export interface RemotePhone { id: string; name: string; pairedAt: string; lastSeen: string | null }
// pair: the one-time pairing URL, only in the answer to /remote on (the code is in the fragment, so no log sees it).
export interface RemoteStatus { state: 'on' | 'off'; host?: string; since?: string; lastRequest?: string; awake?: boolean; phones: RemotePhone[]; pair?: { url: string; expiresAt: string } }
// What the phone sees of an agent: never keys, env, logins or settings.
export interface RemoteAgent { id: string; title: string; engine: import('./protocol.js').Engine; status: string; detail: string; ctx: number | null; tokens: number | null; costUsd: number | null; waiting: 'permission' | 'question' | null; dontAsk: boolean }
// fingerprint: of exactly these lines and the prompt they show; an answer must send it back unchanged.
export interface RemoteScreen { lines: string[]; fingerprint: string; waiting: 'permission' | 'question' | null }
export interface RemoteStart { engine: 'claude-code' | 'codex'; folder: string; message: string }

const object = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const plain = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\p{C}]/u.test(v);
const time = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
export const isPhoneId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{16}$/.test(v);
// A phone's name: what you typed when pairing, 1-40 printable characters.
export const isPhoneName = (v: unknown): v is string => typeof v === 'string' && v.trim() === v && v.length >= 1 && v.length <= 40 && plain(v, 40);
function isPhone(v: unknown): v is RemotePhone {
  const p = object(v);
  return !!p && Object.keys(p).length === 4 && isPhoneId(p.id) && isPhoneName(p.name) && time(p.pairedAt) && (p.lastSeen === null || time(p.lastSeen));
}
export function validateRemoteStatus(value: unknown): RemoteStatus {
  const v = object(value), pair = object(v?.pair);
  const optional = ['host', 'since', 'lastRequest', 'awake', 'pair'].filter(k => v?.[k] !== undefined).length;
  if (!v || Object.keys(v).length !== 2 + optional || (v.state !== 'on' && v.state !== 'off') || !Array.isArray(v.phones) || v.phones.length > 32 || !v.phones.every(isPhone)
    || v.host !== undefined && !(typeof v.host === 'string' && /^[a-z0-9.-]{1,253}:\d{1,5}$/i.test(v.host)) || v.since !== undefined && !time(v.since) || v.lastRequest !== undefined && !time(v.lastRequest)
    || v.awake !== undefined && typeof v.awake !== 'boolean' || v.pair !== undefined && !(pair && Object.keys(pair).length === 2 && typeof pair.url === 'string' && /^https:\/\/[a-z0-9.-]+:\d+\/pair#[A-Za-z0-9_-]{32,64}$/i.test(pair.url) && time(pair.expiresAt)))
    throw new Error('Invalid remote status');
  return v as unknown as RemoteStatus;
}
// eslint-disable-next-line no-control-regex -- a first message keeps tabs and newlines and no other control character.
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
// The phone's start form: an account engine, one of the folders the daemon offered, a first message. Nothing else (no
// permission field: every phone start is Ask).
export function validateRemoteStart(value: unknown): RemoteStart {
  const v = object(value);
  if (!v || Object.keys(v).length !== 3 || (v.engine !== 'claude-code' && v.engine !== 'codex') || typeof v.folder !== 'string' || v.folder.length > 1024 || !v.folder.startsWith('/') || /[\p{C}]/u.test(v.folder)
    || typeof v.message !== 'string' || !v.message.trim() || Buffer.byteLength(v.message) > 8192 || CONTROLS.test(v.message)) throw new Error('Invalid start');
  return { engine: v.engine, folder: v.folder, message: v.message };
}
