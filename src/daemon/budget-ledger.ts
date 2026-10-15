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
// warn: a homepage warning (D33) when holds can't be saved ('save', cleared with null once a save works) or when some of
// the last run's holds couldn't be counted ('load'); log lines alone went unseen (v0.6 gate).
export interface LedgerOptions { file?: string; book: (reservation: Reservation) => Promise<void>; log: { error(text: string): void }; ttlMs?: number; busy?: (sessionId: string) => boolean; warn?: (key: 'save' | 'load', text: string | null) => void }
const SAVE_WARNING = 'Budget holds could not be saved; agents keep running.', LOAD_WARNING = 'Some in-flight spend from the last run could not be counted.';
// v0.6 gate: an agent that stopped waiting for its grant cancels it by id. A cancel can arrive before the reserve it
// cancels (separate requests), so cancelled ids are remembered for a while, bounded.
const MAX_CANCELLED = 1000, MAX_REFUSAL_LOGS = 1000;
type Refusal = 'too many held for one agent' | 'too many requests a minute' | 'too many held overall' | 'ledger closed';
type Spent = { day: number; week: number; month: number };

export class BudgetLedger {
  private readonly live = new Map<string, { reservation: Reservation; timer: ReturnType<typeof setTimeout> }>();
  private writes: Promise<void> = Promise.resolve();
  private writeQueued = false;
  private closed = false;
  // Sessions whose agent exited: a reserve still in flight from it is refused, never left held until it expires.
  private readonly released = new Set<string>();
  private readonly rate = new Map<string, { start: number; count: number }>();
  private readonly cancelled = new Map<string, string>();
  private readonly refusalsLogged = new Set<string>();
  private saveWarned = false;
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
      this.options.warn?.('load', LOAD_WARNING);
      return;
    }
    const list = raw && typeof raw === 'object' && 'reservations' in raw && Array.isArray(raw.reservations) ? raw.reservations as unknown[] : [];
    const left = list.filter(isReservation);
    let lost = list.length !== left.length;
    if (lost) this.options.log.error('Budget reservation record unreadable; skipped');
    // One booking that fails (a full disk) must not stop the daemon or the rest of the bookings.
    for (const reservation of left) {
      try { await this.options.book(reservation); }
      catch { lost = true; this.options.log.error('Budget reservation could not be booked at start'); }
    }
    if (lost) this.options.warn?.('load', LOAD_WARNING);
    if (list.length) await this.persist();
  }
  // id: chosen by the agent (v0.6 gate), so it can cancel a grant whose answer it never got; absent from older agents.
  reserve(request: { sessionId: string; provider: KeyProvider; model: string; amountUsd: number; id?: string }, budgets: Budgets, spent: Spent): ReserveAnswer {
    const unavailable: ReserveAnswer = { refused: { budget: 'unavailable', spent: 0, reserved: this.reserved(), limit: 0 } };
    const { id: wanted, ...fields } = request;
    if (wanted !== undefined && (!isUUID(wanted) || this.live.has(wanted))) return unavailable;
    if (wanted !== undefined && this.cancelled.has(wanted)) { const owner = this.cancelled.get(wanted); this.cancelled.delete(wanted); if (owner === request.sessionId) return unavailable; }
    if (this.closed) return this.refuse(request.sessionId, 'ledger closed', unavailable);
    if (this.released.has(request.sessionId) || !Number.isFinite(request.amountUsd) || request.amountUsd < 0) return unavailable;
    if (this.live.size >= MAX_RESERVATIONS) return this.refuse(request.sessionId, 'too many held overall', unavailable);
    let own = 0; for (const { reservation } of this.live.values()) if (reservation.sessionId === request.sessionId) own++;
    if (own >= MAX_PER_SESSION) return this.refuse(request.sessionId, 'too many held for one agent', unavailable);
    if (!this.takeRate(request.sessionId)) return this.refuse(request.sessionId, 'too many requests a minute', unavailable);
    const held = this.reserved();
    for (const [budget, limit, used] of [['daily', budgets.daily, spent.day], ['weekly', budgets.weekly, spent.week], ['monthly', budgets.monthly, spent.month]] as const)
      if (limit !== null && used + held + request.amountUsd > limit) return { refused: { budget, spent: used, reserved: held, limit } };
    const reservation: Reservation = { id: wanted ?? randomUUID(), ...fields, at: new Date().toISOString() };
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
    if (!held) {
      // A cancel ahead of its reserve: remembered so the late reserve is refused (only a release can cancel, never a booking).
      if (!worstCase && why === 'settled' && isUUID(id)) { this.cancelled.set(id, sessionId); if (this.cancelled.size > MAX_CANCELLED) for (const old of this.cancelled.keys()) { this.cancelled.delete(old); break; } }
      return false;
    }
    if (held.reservation.sessionId !== sessionId) return false;
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
  // The last write's end: a grant goes out only once its hold is on disk, so a daemon killed right after can still book it.
  flushed(): Promise<void> { return this.writes; }
  // Why a reserve was refused, logged once per agent and reason (the agent only says AI Term isn't answering).
  private refuse(sessionId: string, reason: Refusal, answer: ReserveAnswer): ReserveAnswer {
    const key = `${sessionId}:${reason}`;
    if (!this.refusalsLogged.has(key)) { if (this.refusalsLogged.size >= MAX_REFUSAL_LOGS) this.refusalsLogged.clear(); this.refusalsLogged.add(key); this.options.log.error(`Budget reserve refused: ${reason}`); }
    return answer;
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
    this.writes = this.writes.then(async () => { this.writeQueued = false; await atomicWrite(file, { v: 1, reservations: [...this.live.values()].map(({ reservation }) => reservation) }); if (this.saveWarned) { this.saveWarned = false; this.options.warn?.('save', null); } })
      .catch(() => { this.options.log.error('Budget reservations could not be saved; will retry on next change'); if (!this.saveWarned) { this.saveWarned = true; this.options.warn?.('save', SAVE_WARNING); } });
    return this.writes;
  }
}
function isReservation(v: unknown): v is Reservation {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return Object.keys(r).length === 6 && isUUID(r.id) && isUUID(r.sessionId) && isKeyProvider(r.provider) && typeof r.model === 'string' && isValidModelId(r.model)
    && typeof r.amountUsd === 'number' && Number.isFinite(r.amountUsd) && r.amountUsd >= 0 && r.amountUsd <= 10_000 && typeof r.at === 'string' && Number.isFinite(Date.parse(r.at));
}
