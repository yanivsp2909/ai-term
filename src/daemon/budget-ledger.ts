import { randomUUID } from 'node:crypto';
import type { Budgets, KeyProvider } from '../shared/protocol.js';
import type { BudgetRefusal } from '../shared/agent-facts.js';
import { isKeyProvider, isUUID, isValidModelId } from '../shared/validate.js';
import { atomicWrite, moveAside, readState } from './store.js';

// B25 (v0.6.1): budgets hold across agents. Before each model request AI Term's agent reserves that request's worst case
// here; a reservation is granted only if every budget still fits counting every live reservation, and settled after the
// request: released when the real usage was reported, booked at its worst case when it never will be. The check and the
// insert happen in one synchronous step, so two agents racing for the last of a budget can't both get through.
export interface Reservation { id: string; sessionId: string; provider: KeyProvider; model: string; amountUsd: number; at: string }
export type ReserveAnswer = { grant: { id: string } } | { refused: BudgetRefusal };
// A request still streaming after this long is booked at its worst case (its real usage then counts too: over, never under).
export const RESERVATION_TTL_MS = 20 * 60_000;
const MAX_RESERVATIONS = 1000;
// One agent sends one request at a time (a subagent adds one more): 16 held is plenty, and one session can't take every
// slot. 600 reservations a minute is ten requests a second, far past any real model; a flood can't bloat Usage.
const MAX_PER_SESSION = 16, MAX_PER_MINUTE = 600, MAX_RELEASED = 10_000;
// file: where live reservations survive a daemon crash (absent in tests that need no restart).
// busy: the session is waiting on you or running a tool. A request's grant spans its tools (the step's usage comes after
// them), so it must not expire into a booked worst case while you take time over an approval.
export interface LedgerOptions { file?: string; book: (reservation: Reservation) => Promise<void>; log: { error(text: string): void }; ttlMs?: number; busy?: (sessionId: string) => boolean }
type Spent = { day: number; week: number; month: number };

export class BudgetLedger {
  private readonly live = new Map<string, { reservation: Reservation; timer: ReturnType<typeof setTimeout> }>();
  private writes: Promise<void> = Promise.resolve();
  private writeQueued = false;
  private closed = false;
  // Sessions whose agent exited: a reserve still in flight from it is refused, never left held until it expires.
  private readonly released = new Set<string>();
  private readonly rate = new Map<string, { start: number; count: number }>();
  constructor(private readonly options: LedgerOptions) {}
  holds(id: string): boolean { return this.live.has(id); }
  reserved(): number { let total = 0; for (const { reservation } of this.live.values()) total += reservation.amountUsd; return total; }
  // Reservations a stopped or crashed daemon left behind never got their usage: book each at its worst case, once.
  async load(): Promise<void> {
    const file = this.options.file;
    if (!file) return;
    let raw: unknown;
    try { raw = await readState(file); }
    catch {
      // Never overwritten: kept for a look, as B24 keeps an unreadable agent list.
      try { await moveAside(file); this.options.log.error('Budget reservations unreadable; moved aside'); }
      catch { this.options.log.error('Budget reservations unreadable and could not be moved aside'); this.closed = true; }
      return;
    }
    const list = raw && typeof raw === 'object' && 'reservations' in raw && Array.isArray(raw.reservations) ? raw.reservations as unknown[] : [];
    const left = list.filter(isReservation);
    if (list.length !== left.length) this.options.log.error('Budget reservation record unreadable; skipped');
    for (const reservation of left) await this.options.book(reservation);
    if (list.length) await this.persist();
  }
  reserve(request: { sessionId: string; provider: KeyProvider; model: string; amountUsd: number }, budgets: Budgets, spent: Spent): ReserveAnswer {
    const unavailable: ReserveAnswer = { refused: { budget: 'unavailable', spent: 0, reserved: this.reserved(), limit: 0 } };
    if (this.closed || this.released.has(request.sessionId) || !Number.isFinite(request.amountUsd) || request.amountUsd < 0 || this.live.size >= MAX_RESERVATIONS) return unavailable;
    let own = 0; for (const { reservation } of this.live.values()) if (reservation.sessionId === request.sessionId) own++;
    if (own >= MAX_PER_SESSION || !this.takeRate(request.sessionId)) return unavailable;
    const held = this.reserved();
    for (const [budget, limit, used] of [['daily', budgets.daily, spent.day], ['weekly', budgets.weekly, spent.week], ['monthly', budgets.monthly, spent.month]] as const)
      if (limit !== null && used + held + request.amountUsd > limit) return { refused: { budget, spent: used, reserved: held, limit } };
    const reservation: Reservation = { id: randomUUID(), ...request, at: new Date().toISOString() };
    this.live.set(reservation.id, { reservation, timer: this.expire(reservation) });
    void this.persist();
    return { grant: { id: reservation.id } };
  }
  private expire(reservation: Reservation): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const held = this.live.get(reservation.id);
      if (!held) return;
      if (this.options.busy?.(reservation.sessionId)) { held.timer = this.expire(reservation); return; }
      void this.settle(reservation.sessionId, reservation.id, true, 'expired');
    }, this.options.ttlMs ?? RESERVATION_TTL_MS);
    timer.unref();
    return timer;
  }
  // Only the session that holds a reservation can settle it. worstCase: no usage will ever arrive for it.
  async settle(sessionId: string, id: string, worstCase: boolean, why: 'settled' | 'expired' | 'exited' = 'settled'): Promise<boolean> {
    const held = this.live.get(id);
    if (!held || held.reservation.sessionId !== sessionId) return false;
    this.live.delete(id); clearTimeout(held.timer);
    if (why === 'expired') this.options.log.error('Budget reservation expired; booked at its worst case');
    // A booking that fails is logged and never rejects: callers settle without awaiting (exit, expiry), and an unhandled
    // rejection would stop the daemon. The file is rewritten either way, so a restart doesn't book it again.
    try { if (worstCase && held.reservation.amountUsd > 0) await this.options.book(held.reservation); }
    catch { this.options.log.error('Budget reservation could not be booked'); }
    // Not awaited: the answer doesn't wait for the disk; close() waits for the last write.
    void this.persist();
    return true;
  }
  // An agent that exited can't report the usage of a request it still held: booked at its worst case.
  async releaseSession(sessionId: string): Promise<void> {
    this.released.add(sessionId); this.rate.delete(sessionId);
    // Session ids are never reused; the oldest are dropped so a long-lived daemon doesn't keep every one.
    if (this.released.size > MAX_RELEASED) for (const old of this.released) { this.released.delete(old); if (this.released.size <= MAX_RELEASED / 2) break; }
    for (const { reservation } of [...this.live.values()]) if (reservation.sessionId === sessionId) await this.settle(sessionId, reservation.id, true, 'exited');
  }
  // Shutdown keeps the file: whatever is still held is booked at the next start.
  async close(): Promise<void> { this.closed = true; for (const { timer } of this.live.values()) clearTimeout(timer); await this.writes; }
  private takeRate(sessionId: string): boolean {
    const now = Date.now(), window = this.rate.get(sessionId);
    if (!window || now - window.start >= 60_000 || now < window.start) { this.rate.set(sessionId, { start: now, count: 1 }); return true; }
    if (window.count >= MAX_PER_MINUTE) return false;
    window.count++; return true;
  }
  // Writes coalesce: at most one is waiting, and it saves whatever is held when it runs.
  private persist(): Promise<void> {
    const file = this.options.file;
    if (!file || this.writeQueued) return this.writes;
    this.writeQueued = true;
    // A failed write never stops the daemon or an agent (D33); the next change writes again.
    this.writes = this.writes.then(() => { this.writeQueued = false; return atomicWrite(file, { v: 1, reservations: [...this.live.values()].map(({ reservation }) => reservation) }); })
      .catch(() => { this.options.log.error('Budget reservations could not be saved; will retry on next change'); });
    return this.writes;
  }
}
function isReservation(v: unknown): v is Reservation {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return Object.keys(r).length === 6 && isUUID(r.id) && isUUID(r.sessionId) && isKeyProvider(r.provider) && typeof r.model === 'string' && isValidModelId(r.model)
    && typeof r.amountUsd === 'number' && Number.isFinite(r.amountUsd) && r.amountUsd >= 0 && r.amountUsd <= 10_000 && typeof r.at === 'string' && Number.isFinite(Date.parse(r.at));
}
