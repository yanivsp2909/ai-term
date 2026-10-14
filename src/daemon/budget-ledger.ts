import { randomUUID } from 'node:crypto';
import type { Budgets, KeyProvider } from '../shared/protocol.js';
import type { BudgetRefusal } from '../shared/agent-facts.js';
import { isKeyProvider, isUUID, isValidModelId } from '../shared/validate.js';
import { atomicWrite, readState } from './store.js';

// B25 (v0.6.1): budgets hold across agents. Before each model request AI Term's agent reserves that request's worst case
// here; a reservation is granted only if every budget still fits counting every live reservation, and settled after the
// request: released when the real usage was reported, booked at its worst case when it never will be. The check and the
// insert happen in one synchronous step, so two agents racing for the last of a budget can't both get through.
export interface Reservation { id: string; sessionId: string; provider: KeyProvider; model: string; amountUsd: number; at: string }
export type ReserveAnswer = { grant: { id: string } } | { refused: BudgetRefusal };
// A request still streaming after this long is booked at its worst case (its real usage then counts too: over, never under).
export const RESERVATION_TTL_MS = 20 * 60_000;
const MAX_RESERVATIONS = 1000;
// file: where live reservations survive a daemon crash (absent in tests that need no restart).
export interface LedgerOptions { file?: string; book: (reservation: Reservation) => Promise<void>; log: { error(text: string): void }; ttlMs?: number }
type Spent = { day: number; week: number; month: number };

export class BudgetLedger {
  private readonly live = new Map<string, { reservation: Reservation; timer: ReturnType<typeof setTimeout> }>();
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private readonly options: LedgerOptions) {}
  reserved(): number { let total = 0; for (const { reservation } of this.live.values()) total += reservation.amountUsd; return total; }
  // Reservations a stopped or crashed daemon left behind never got their usage: book each at its worst case, once.
  async load(): Promise<void> {
    const file = this.options.file;
    if (!file) return;
    let raw: unknown;
    try { raw = await readState(file); } catch { this.options.log.error('Budget reservations unreadable; left in place'); return; }
    const list = raw && typeof raw === 'object' && 'reservations' in raw && Array.isArray(raw.reservations) ? raw.reservations as unknown[] : [];
    const left = list.filter(isReservation);
    if (list.length !== left.length) this.options.log.error('Budget reservation record unreadable; skipped');
    for (const reservation of left) await this.options.book(reservation);
    if (list.length) await this.persist();
  }
  reserve(request: { sessionId: string; provider: KeyProvider; model: string; amountUsd: number }, budgets: Budgets, spent: Spent): ReserveAnswer {
    if (this.closed || !Number.isFinite(request.amountUsd) || request.amountUsd < 0 || this.live.size >= MAX_RESERVATIONS) return { refused: { budget: 'unavailable', spent: 0, reserved: this.reserved(), limit: 0 } };
    const held = this.reserved();
    for (const [budget, limit, used] of [['daily', budgets.daily, spent.day], ['weekly', budgets.weekly, spent.week], ['monthly', budgets.monthly, spent.month]] as const)
      if (limit !== null && used + held + request.amountUsd > limit) return { refused: { budget, spent: used, reserved: held, limit } };
    const reservation: Reservation = { id: randomUUID(), ...request, at: new Date().toISOString() };
    const timer = setTimeout(() => { void this.settle(reservation.sessionId, reservation.id, true, 'expired'); }, this.options.ttlMs ?? RESERVATION_TTL_MS);
    timer.unref();
    this.live.set(reservation.id, { reservation, timer });
    void this.persist();
    return { grant: { id: reservation.id } };
  }
  // Only the session that holds a reservation can settle it. worstCase: no usage will ever arrive for it.
  async settle(sessionId: string, id: string, worstCase: boolean, why: 'settled' | 'expired' | 'exited' = 'settled'): Promise<boolean> {
    const held = this.live.get(id);
    if (!held || held.reservation.sessionId !== sessionId) return false;
    this.live.delete(id); clearTimeout(held.timer);
    if (why === 'expired') this.options.log.error('Budget reservation expired; booked at its worst case');
    if (worstCase && held.reservation.amountUsd > 0) await this.options.book(held.reservation);
    await this.persist();
    return true;
  }
  // An agent that exited can't report the usage of a request it still held: booked at its worst case.
  async releaseSession(sessionId: string): Promise<void> {
    for (const { reservation } of [...this.live.values()]) if (reservation.sessionId === sessionId) await this.settle(sessionId, reservation.id, true, 'exited');
  }
  // Shutdown keeps the file: whatever is still held is booked at the next start.
  async close(): Promise<void> { this.closed = true; for (const { timer } of this.live.values()) clearTimeout(timer); await this.writes; }
  private persist(): Promise<void> {
    const file = this.options.file;
    if (!file) return this.writes;
    const reservations = [...this.live.values()].map(({ reservation }) => reservation);
    // A failed write never stops the daemon or an agent (D33); the next change writes again.
    this.writes = this.writes.then(() => atomicWrite(file, { v: 1, reservations })).catch(() => { this.options.log.error('Budget reservations could not be saved; will retry on next change'); });
    return this.writes;
  }
}
function isReservation(v: unknown): v is Reservation {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return Object.keys(r).length === 6 && isUUID(r.id) && isUUID(r.sessionId) && isKeyProvider(r.provider) && typeof r.model === 'string' && isValidModelId(r.model)
    && typeof r.amountUsd === 'number' && Number.isFinite(r.amountUsd) && r.amountUsd >= 0 && r.amountUsd <= 10_000 && typeof r.at === 'string' && Number.isFinite(Date.parse(r.at));
}
