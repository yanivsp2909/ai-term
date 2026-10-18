import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { KeyStore } from '../keys.js';
import { atomicWrite, readState } from '../store.js';
import { isPhoneId, isPhoneName, REMOTE_CODE_MS, type RemotePhone } from '../../shared/remote.js';

// v1.0.8 /remote pairing (D54). A one-time code (in the QR's URL fragment, so it never reaches a log) works once, for two
// minutes. The phone then gets a random token in a cookie; the Keychain keeps only the token's SHA-256, through keys.ts.
// Names, dates and ids are in ~/.ai-term/remote-phones.json (0600): nothing there logs anyone in.
const sha256 = (text: string) => createHash('sha256').update(text).digest();
const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);
export class PairingCodes {
  private pending: { hash: Buffer; expires: number } | null = null;
  // A new code replaces the previous one: only the QR on your screen now can pair.
  issue(now = Date.now()): { code: string; expiresAt: number } {
    const code = randomBytes(32).toString('base64url');
    this.pending = { hash: sha256(code), expires: now + REMOTE_CODE_MS };
    return { code, expiresAt: this.pending.expires };
  }
  // Used up by any attempt that names it, right or late: a code is never tried twice.
  redeem(code: unknown, now = Date.now()): boolean {
    const pending = this.pending;
    if (!pending || typeof code !== 'string' || !/^[A-Za-z0-9_-]{32,64}$/.test(code)) return false;
    if (!same(sha256(code), pending.hash)) return false;
    this.pending = null;
    return now <= pending.expires;
  }
  clear(): void { this.pending = null; }
}
export const COOKIE = '__Host-aiterm';
export const MAX_PHONES = 32;
export class PhoneError extends Error {}
export const PHONE_ERRORS = ['No paired phone has that name or id · /remote lists them', 'Two phones have that name · revoke it by its id (/remote lists it)', 'Too many paired phones · revoke one first'] as const;
export class RemotePhones {
  private hashes = new Map<string, Buffer>();
  constructor(private root: string, private keys: KeyStore) {}
  private get file() { return join(this.root, 'remote-phones.json'); }
  async list(): Promise<RemotePhone[]> {
    // A missing file reads as an empty record; an unreadable one fails loudly (never "no phones" by accident).
    const raw = await readState(this.file);
    const phones = Array.isArray(raw) ? raw : [];
    return phones.filter((p): p is RemotePhone => !!p && typeof p === 'object' && isPhoneId((p as RemotePhone).id) && isPhoneName((p as RemotePhone).name) && typeof (p as RemotePhone).pairedAt === 'string');
  }
  private save(phones: RemotePhone[]): Promise<void> { return atomicWrite(this.file, phones); }
  async pair(name: string, now = Date.now()): Promise<{ phone: RemotePhone; cookie: string }> {
    const phones = await this.list();
    if (phones.length >= MAX_PHONES) throw new PhoneError(PHONE_ERRORS[2]);
    const id = randomBytes(8).toString('hex'), token = randomBytes(32).toString('base64url');
    const phone: RemotePhone = { id, name: isPhoneName(name) ? name : 'phone', pairedAt: new Date(now).toISOString(), lastSeen: null };
    await this.keys.savePhone(id, sha256(token).toString('hex'));
    await this.save([...phones, phone]);
    return { phone, cookie: `${id}.${token}` };
  }
  // The cookie's phone, if its token's hash matches the Keychain's (constant time) and the phone is still paired.
  async check(value: string | undefined): Promise<RemotePhone | null> {
    const match = (value ?? '').match(/^([0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/);
    if (!match?.[1] || !match[2]) return null;
    const phone = (await this.list()).find(p => p.id === match[1]);
    if (!phone) return null;
    let stored = this.hashes.get(phone.id);
    if (!stored) { const hex = await this.keys.phoneHash(phone.id); if (!hex) return null; stored = Buffer.from(hex, 'hex'); this.hashes.set(phone.id, stored); }
    return same(sha256(match[2]), stored) ? phone : null;
  }
  async seen(id: string, now = Date.now()): Promise<void> {
    const phones = await this.list(), at = new Date(now).toISOString();
    // At most once a minute: every request would otherwise rewrite the file.
    if (!phones.some(p => p.id === id && (p.lastSeen === null || now - Date.parse(p.lastSeen) > 60_000))) return;
    await this.save(phones.map(p => p.id === id ? { ...p, lastSeen: at } : p));
  }
  async revoke(which: string): Promise<RemotePhone> {
    const phones = await this.list(), found = phones.filter(p => p.id === which || p.name === which);
    if (!found.length) throw new PhoneError(PHONE_ERRORS[0]);
    if (found.length > 1) throw new PhoneError(PHONE_ERRORS[1]);
    const phone = found[0] as RemotePhone;
    // The token stops working first (memory, then the record), then its hash leaves the Keychain.
    this.hashes.delete(phone.id);
    await this.save(phones.filter(p => p.id !== phone.id));
    await this.keys.removePhone(phone.id);
    return phone;
  }
}
