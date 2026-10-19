import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, readState } from './store.js';
import { SettingsStore } from './settings.js';
import { errorKind } from './log.js';
import { MAX_QUEUE_ITEMS, MAX_RUN_MS, nextLocalTime, stopDelayMs, untilWithin, validateQueueItem, type QueueItem, type QueueLimit, type QueueRequest, type QueueTrigger } from '../shared/queue.js';
import type { SessionInfo } from '../shared/protocol.js';
import type { StatusState } from './status-reducer.js';

// v0.9.1 queue (D55, off by default; `/settings` b). Items live in <root>/queue.json (0600, written whole, first messages
// included), so the queue survives a daemon restart. A time that passed while the daemon wasn't running, or by more than
// two minutes while it was (a sleeping Mac), is marked missed and never starts by itself (the prompt's sentence about it
// was cut off; this is the safer reading). A due item starts through the same create() as a manual start (worktree,
// env, the mode you picked, Ask by default); a failed start is shown on the item and never retried.
const FULL = 'The queue is full (20 agents); remove one with x in /queue', GONE = 'That queued agent is gone', OFF = 'The queue is off; turn it on in /settings (b)';
const SPAN = 'The stop time must come within 12 hours after it starts', NAME = 'No agent has that name; after <agent> needs one that is running now', UNSAVED = 'The queue could not be saved';
export const QUEUE_ERRORS: readonly string[] = [FULL, GONE, OFF, SPAN, NAME, UNSAVED];
export interface QueueManager {
  create(request: QueueRequest): Promise<{ id: string }>;
  on(event: 'statusChanged', listener: (session: SessionInfo, previous: StatusState, next: StatusState) => void): unknown;
  setQueueLimit(sessionId: string, limit: QueueLimit, onStop: (note: string) => void): void;
  stop(sessionId: string): Promise<void>;
  // The agents running now, by title: an `after` trigger must name one (review: a typo would wait forever).
  titles?(): string[];
}
const TICK_MS = 15_000, LATE_MS = 2 * 60_000;
// A start can fail with anything create() throws; only plain one-line text reaches the item (it is shown in /queue).
const shown = (error: unknown): string => { const text = error instanceof Error ? error.message : ''; return /^[^\p{C}]{1,200}$/u.test(text) ? text : "the agent couldn't start"; };
export class QueueService extends EventEmitter {
  private items: QueueItem[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private saving: Promise<void> = Promise.resolve();
  private closed = false;
  private settingsFailed = false;
  private readonly path: string;
  constructor(root: string, private readonly manager: QueueManager, private readonly log: { error(text: string): void; info(text: string): void }, private readonly now: () => Date = () => new Date(),
    private readonly enabled: () => Promise<boolean> = async () => (await new SettingsStore(root).get()).queue === true) {
    super(); this.path = join(root, 'queue.json');
    manager.on('statusChanged', (session, previous, next) => { this.onStatus(session.title, previous.status, next.status).catch((error: unknown) => this.log.error(`Queue trigger failed (${errorKind(error)})`)); });
  }
  list(): QueueItem[] { return this.items.map(item => ({ ...item })); }
  // Each item on its own: one that no longer validates is left out, and the file as it was is kept beside it.
  async load(): Promise<void> {
    let raw: unknown;
    try { raw = await readState(this.path); } catch (error) { if (!(error instanceof SyntaxError)) throw error; raw = null; }
    // readState answers { sessions: [] } for a file that isn't there: an empty queue.
    const missing = !Array.isArray(raw) && raw !== null && typeof raw === 'object' && 'sessions' in raw;
    const entries = Array.isArray(raw) ? raw.slice(0, MAX_QUEUE_ITEMS) : [];
    this.items = entries.flatMap(entry => { try { return [validateQueueItem(entry)]; } catch { return []; } });
    let changed = false;
    if (!missing && (!Array.isArray(raw) || this.items.length !== raw.length)) {
      const aside = `${this.path}.unreadable-${Date.now()}`;
      await rename(this.path, aside);
      this.log.error('Queue file had items AI Term could not read; it was kept beside it and the rest load');
      changed = true;
    }
    const now = this.now().getTime();
    for (const item of this.items) if (item.state === 'waiting' && item.trigger.kind === 'at' && item.trigger.due && Date.parse(item.trigger.due) <= now) {
      item.state = 'missed'; item.note = `its time (${item.trigger.time}) passed while AI Term wasn't running`; changed = true;
    }
    if (changed) await this.save();
  }
  start(): void { this.timer ??= setInterval(() => { this.tick().catch((error: unknown) => this.log.error(`Queue check failed (${errorKind(error)})`)); }, TICK_MS); this.timer.unref(); }
  // While the daemon stops nothing starts or fails (review: shutdown's exits would otherwise fire `after` items).
  // Resolves once a save already in flight has finished, so shutdown (and a test's cleanup) never races queue.json.
  close(): Promise<void> { this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; return this.saving; }
  async add(entry: { trigger: QueueTrigger; limit: QueueLimit; request: QueueRequest }): Promise<QueueItem> {
    if (!await this.isOn()) throw new Error(OFF);
    if (this.items.length >= MAX_QUEUE_ITEMS) throw new Error(FULL);
    if (entry.trigger.kind === 'at' && entry.limit.until && !untilWithin(entry.trigger.time, entry.limit.until)) throw new Error(SPAN);
    if (entry.trigger.kind === 'after' && this.manager.titles && !this.manager.titles().includes(entry.trigger.agent)) throw new Error(NAME);
    const trigger: QueueTrigger = entry.trigger.kind === 'at' ? { kind: 'at', time: entry.trigger.time, due: nextLocalTime(entry.trigger.time, this.now()).toISOString() } : entry.trigger;
    const item: QueueItem = { id: randomUUID(), createdAt: this.now().toISOString(), trigger, limit: entry.limit, request: entry.request, state: 'waiting' };
    this.items.push(item);
    try { await this.save(); } catch (error) { this.items = this.items.filter(other => other !== item); throw error; }
    return { ...item };
  }
  async remove(id: string): Promise<void> {
    const before = this.items.length; this.items = this.items.filter(item => item.id !== id);
    if (this.items.length === before) throw new Error(GONE);
    await this.save();
  }
  // Time triggers; also called every 15 s once started.
  async tick(): Promise<void> {
    if (this.closed || !await this.isOn()) return;
    const now = this.now().getTime(); let changed = false;
    for (const item of [...this.items]) {
      if (!this.live(item) || item.trigger.kind !== 'at' || !item.trigger.due || Date.parse(item.trigger.due) > now) continue;
      if (now - Date.parse(item.trigger.due) > LATE_MS) { item.state = 'missed'; item.note = `AI Term wasn't free at ${item.trigger.time} (the Mac may have slept), so it didn't start late`; changed = true; continue; }
      await this.launch(item);
    }
    if (changed) await this.save().catch((error: unknown) => this.log.error(`${UNSAVED} (${errorKind(error)})`));
  }
  // Settings that can't be read count as the queue being off (logged once): nothing starts, nothing crashes.
  private async isOn(): Promise<boolean> {
    try { const on = await this.enabled(); this.settingsFailed = false; return on; }
    catch (error) { if (!this.settingsFailed) this.log.error(`Queue settings unreadable; nothing starts (${errorKind(error)})`); this.settingsFailed = true; return false; }
  }
  // Still queued, still waiting, and the daemon not stopping: re-checked right before each start (review: an item removed
  // meanwhile must not start).
  private live(item: QueueItem): boolean { return !this.closed && this.items.includes(item) && item.state === 'waiting'; }
  // An agent finishing (its turn done, or it exited) starts what waits after it; one that ended with an error doesn't.
  private async onStatus(title: string, previous: string, next: string): Promise<void> {
    if (this.closed || previous === next || !['done', 'exited', 'error'].includes(next)) return;
    const waiting = this.items.filter(item => item.state === 'waiting' && item.trigger.kind === 'after' && item.trigger.agent === title);
    if (!waiting.length || !await this.isOn()) return;
    for (const item of waiting) {
      if (!this.live(item)) continue;
      if (next === 'error') { item.state = 'failed'; item.note = `${title} ended with an error, so this one didn't start`; continue; }
      await this.launch(item);
    }
    await this.save().catch((error: unknown) => this.log.error(`${UNSAVED} (${errorKind(error)})`));
  }
  private async launch(item: QueueItem): Promise<void> {
    if (!this.live(item)) return;
    // Its stop time must still be within 12 hours: an `after` item may start long after it was queued.
    if (item.limit.until && stopDelayMs(item.limit.until, this.now()) > MAX_RUN_MS) {
      item.state = 'failed'; item.note = `its stop time (${item.limit.until}) is more than 12 hours away, so it didn't start`;
      await this.save().catch((error: unknown) => this.log.error(`${UNSAVED} (${errorKind(error)})`)); return;
    }
    // Saved as started before the start, so a crash in between can't start it twice later.
    item.state = 'started'; delete item.note;
    await this.save().catch((error: unknown) => this.log.error(`${UNSAVED} (${errorKind(error)})`));
    let session: { id: string };
    try { session = await this.manager.create(item.request); }
    catch (error) {
      item.state = 'failed'; item.note = shown(error);
      this.log.error(`Queued agent could not start (${errorKind(error)})`);
      await this.save().catch((error: unknown) => this.log.error(`${UNSAVED} (${errorKind(error)})`)); return;
    }
    item.sessionId = session.id;
    // Every queued agent runs with its limit or not at all (gate: one that started and lost its limit ran on unlimited
    // while the panel said failed).
    try { this.manager.setQueueLimit(session.id, item.limit, note => { item.note = note; this.save().catch((error: unknown) => this.log.error(`${UNSAVED} (${errorKind(error)})`)); }); }
    catch (limitError) {
      try { await this.manager.stop(session.id); item.note = "its limit couldn't be set, so AI Term stopped it"; this.log.error(`Queued agent started, but its limit could not be set (${errorKind(limitError)}); it was stopped`); }
      catch (stopError) { item.note = "its limit couldn't be set and AI Term couldn't stop it: stop it on the homepage"; this.log.error(`Queued agent without its limit could not be stopped (${errorKind(stopError)}); stop it on the homepage`); }
    }
    await this.save().catch((error: unknown) => this.log.error(`${UNSAVED} (${errorKind(error)})`));
  }
  // Writes one after another; a failed write rejects for its caller (add and remove say so) and the next one still runs.
  private async save(): Promise<void> {
    const write = this.saving.then(() => atomicWrite(this.path, this.items));
    this.saving = write.then(() => undefined, () => undefined);
    try { await write; } catch (error) { throw new Error(UNSAVED, { cause: error }); }
    this.emit('changed', this.list());
  }
}
