import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { atomicWrite, readState } from './store.js';
import { SettingsStore } from './settings.js';
import { MAX_QUEUE_ITEMS, nextLocalTime, validateQueue, type QueueItem, type QueueLimit, type QueueRequest, type QueueTrigger } from '../shared/queue.js';
import type { SessionInfo } from '../shared/protocol.js';
import type { StatusState } from './status-reducer.js';

// v0.9.1 queue (D55, off by default; `/settings` b). Items live in <root>/queue.json (0600, written whole), so the queue
// survives a daemon restart. A time that passed while the daemon wasn't running is marked missed and never starts by
// itself (the prompt's sentence about it was cut off; this is the safer reading). A due item starts through the same
// create() as a manual start (worktree, env, the mode you picked, Ask by default); a failed start is shown on the item and
// never retried.
export const QUEUE_ERRORS: readonly string[] = ['The queue is full (20 agents); remove one with x in /queue', 'That queued agent is gone', 'The queue is off; turn it on in /settings (b)'];
export interface QueueManager {
  create(request: QueueRequest): Promise<{ id: string }>;
  on(event: 'statusChanged', listener: (session: SessionInfo, previous: StatusState, next: StatusState) => void): unknown;
  setQueueLimit(sessionId: string, limit: QueueLimit, onStop: (note: string) => void): void;
}
const TICK_MS = 15_000;
// A start can fail with anything create() throws; only plain one-line text reaches the item (it is shown in /queue).
const shown = (error: unknown): string => { const text = error instanceof Error ? error.message : ''; return /^[^\p{C}]{1,200}$/u.test(text) ? text : "the agent couldn't start"; };
export class QueueService extends EventEmitter {
  private items: QueueItem[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;
  constructor(root: string, private readonly manager: QueueManager, private readonly log: { error(text: string): void; info(text: string): void }, private readonly now: () => Date = () => new Date(),
    private readonly enabled: () => Promise<boolean> = async () => (await new SettingsStore(root).get()).queue === true) {
    super(); this.path = join(root, 'queue.json');
  }
  list(): QueueItem[] { return this.items.map(item => ({ ...item })); }
  async load(): Promise<void> {
    const raw = await readState(this.path);
    // readState answers { sessions: [] } for a file that isn't there: an empty queue.
    this.items = Array.isArray(raw) ? validateQueue(raw) : [];
    const now = this.now().getTime(); let changed = false;
    for (const item of this.items) if (item.state === 'waiting' && item.trigger.kind === 'at' && item.trigger.due && Date.parse(item.trigger.due) <= now) {
      item.state = 'missed'; item.note = `its time (${item.trigger.time}) passed while AI Term wasn't running`; changed = true;
    }
    if (changed) await this.save();
    this.manager.on('statusChanged', (session, previous, next) => { void this.onStatus(session.title, previous.status, next.status); });
  }
  start(): void { this.timer ??= setInterval(() => { void this.tick(); }, TICK_MS); this.timer.unref(); }
  close(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async add(entry: { trigger: QueueTrigger; limit: QueueLimit; request: QueueRequest }): Promise<QueueItem> {
    if (!await this.enabled()) throw new Error(QUEUE_ERRORS[2]);
    if (this.items.length >= MAX_QUEUE_ITEMS) throw new Error(QUEUE_ERRORS[0]);
    const trigger: QueueTrigger = entry.trigger.kind === 'at' ? { kind: 'at', time: entry.trigger.time, due: nextLocalTime(entry.trigger.time, this.now()).toISOString() } : entry.trigger;
    const item: QueueItem = { id: randomUUID(), createdAt: this.now().toISOString(), trigger, limit: entry.limit, request: entry.request, state: 'waiting' };
    this.items.push(item); await this.save();
    return { ...item };
  }
  async remove(id: string): Promise<void> {
    const before = this.items.length; this.items = this.items.filter(item => item.id !== id);
    if (this.items.length === before) throw new Error(QUEUE_ERRORS[1]);
    await this.save();
  }
  // Time triggers; also called every 15 s once started.
  async tick(): Promise<void> {
    if (!await this.enabled()) return;
    const now = this.now().getTime();
    for (const item of this.items) if (item.state === 'waiting' && item.trigger.kind === 'at' && item.trigger.due && Date.parse(item.trigger.due) <= now) await this.launch(item);
  }
  // An agent finishing (its turn done, or it exited) starts what waits after it; one that ended with an error doesn't.
  private async onStatus(title: string, previous: string, next: string): Promise<void> {
    if (previous === next || !['done', 'exited', 'error'].includes(next)) return;
    const waiting = this.items.filter(item => item.state === 'waiting' && item.trigger.kind === 'after' && item.trigger.agent === title);
    if (!waiting.length || !await this.enabled()) return;
    for (const item of waiting) {
      if (next === 'error') { item.state = 'failed'; item.note = `${title} ended with an error, so this one didn't start`; continue; }
      await this.launch(item);
    }
    await this.save();
  }
  private async launch(item: QueueItem): Promise<void> {
    // Marked first, so a second trigger meanwhile can't start it twice.
    item.state = 'started'; delete item.note;
    try {
      const session = await this.manager.create(item.request);
      item.sessionId = session.id;
      this.manager.setQueueLimit(session.id, item.limit, note => { item.note = note; void this.save(); });
    } catch (error) {
      item.state = 'failed'; item.note = shown(error);
      this.log.error('Queued agent could not start');
    }
    await this.save();
  }
  private save(): Promise<void> {
    this.saving = this.saving.then(() => atomicWrite(this.path, this.items)).then(() => { this.emit('changed', this.list()); }, () => { this.log.error('Queue could not be saved'); });
    return this.saving;
  }
}
