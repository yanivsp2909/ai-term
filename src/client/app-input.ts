import { EventEmitter } from 'node:events';
import type { Input, Output } from './attach.js';
import { AppControlFilter } from '../shared/app-control.js';
import { BACKGROUND_QUERY, BackgroundReplies } from './tui/theme.js';

// All home/attach/split readers receive this stream. Only real stdin feeds the filter;
// neither agent output nor the socket can dispatch a desktop command.
export class AppInput extends EventEmitter implements Input {
  private readonly filter: AppControlFilter;
  private escapeTimer?: ReturnType<typeof setTimeout>;
  private probe?: { replies: BackgroundReplies; finish: (background?: string) => void; timer: ReturnType<typeof setTimeout> };
  readonly enabled: boolean;
  constructor(private readonly source: Input, token?: string) {
    super(); this.enabled = !!token; this.filter = new AppControlFilter(token);
    source.on('data', this.receive); source.on('error', this.error); source.on('end', this.end); source.on('close', this.close);
  }
  get isTTY(): boolean { return this.source.isTTY ?? false; }
  get isRaw(): boolean { return this.source.isRaw ?? false; }
  setRawMode(raw: boolean): unknown { return this.source.setRawMode(raw); }
  resume(): unknown { return this.source.resume(); }
  pause(): unknown { return this.source.pause(); }
  private data(data: Buffer): void {
    const bytes = this.probe ? this.probe.replies.push(data) : data;
    if (bytes.length) this.emit('data', bytes);
  }
  private receive = (value: Buffer | string): void => {
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    for (const part of this.filter.push(typeof value === 'string' ? Buffer.from(value) : value)) {
      if ('command' in part) this.emit('command', part.command); else this.data(part.data);
    }
    this.escapeTimer = setTimeout(() => { this.data(this.filter.flush()); }, 30);
  };
  private error = (error: Error): void => { this.emit('error', error); };
  private end = (): void => { this.emit('end'); };
  private close = (): void => { this.emit('close'); };
  background(stdout: Output): Promise<string | undefined> {
    this.probe?.finish();
    return new Promise((resolve, reject) => {
      const finish = (background?: string): void => { if (this.probe) clearTimeout(this.probe.timer); this.probe = undefined; resolve(background); };
      this.probe = { replies: new BackgroundReplies(finish), finish, timer: setTimeout(finish, 200) };
      try { stdout.write(BACKGROUND_QUERY); } catch (error) { finish(); reject(error); }
    });
  }
  dispose(): void {
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.probe?.finish();
    this.source.off('data', this.receive); this.source.off('error', this.error); this.source.off('end', this.end); this.source.off('close', this.close);
  }
}
