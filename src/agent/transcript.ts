import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

// One JSON object per line in <home>/sessions/<id>/transcript.jsonl (0600, inside the daemon's 0700 session folder,
// deleted with the session). v0.4.2's resume reads it. Text is capped and the session key is redacted before writing.
export type TranscriptEntry =
  | { kind: 'user' | 'assistant' | 'note'; text: string }
  | { kind: 'tool-call'; tool: string; input: string }
  | { kind: 'tool-result'; tool: string; ok: boolean; output: string }
  | { kind: 'model'; model: string };
const ENTRY_MAX_CHARS = 64 * 1024;

export class Transcript {
  private file: Promise<FileHandle> | null = null;
  private queue: Promise<void> = Promise.resolve();
  failed = false;
  constructor(private readonly path: string | null, private readonly redact: (text: string) => string, private readonly onFailure: () => void) {}
  append(entry: TranscriptEntry): Promise<void> {
    if (!this.path || this.failed) return this.queue;
    const path = this.path;
    const capped = Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, typeof value === 'string' ? this.redact(value.length > ENTRY_MAX_CHARS ? value.slice(0, ENTRY_MAX_CHARS) + '…' : value) : value]));
    const line = JSON.stringify({ v: 1, at: new Date().toISOString(), ...capped }) + '\n';
    this.queue = this.queue.then(async () => {
      // O_NOFOLLOW: the session folder is the daemon's, but the file name must never lead somewhere else.
      this.file ??= open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      await (await this.file).appendFile(line, 'utf8');
    }).catch(() => { this.failed = true; this.onFailure(); });
    return this.queue;
  }
  async close(): Promise<void> { await this.queue; if (this.file) { try { await (await this.file).close(); } catch { this.failed = true; } } }
}
