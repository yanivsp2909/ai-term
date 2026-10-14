// This OSC belongs to the outer ai client, never to a daemon protocol or an agent.
const PREFIX = '\x1b]777;ai-term;';
const PASTE_START = '\x1b[200~', PASTE_END = '\x1b[201~';
export type AppCommand = 'palette' | 'new-agent' | `select ${1|2|3|4|5|6|7|8|9}` | 'split' | 'theme-changed' | 'home' | 'settings';
export function isAppCommand(value: string): value is AppCommand {
  return ['palette', 'new-agent', 'split', 'theme-changed', 'home', 'settings'].includes(value) || /^select [1-9]$/.test(value);
}
export function takeAppToken(env: Record<string, string | undefined>): string | undefined {
  const token = env.AI_TERM_APP_TOKEN;
  delete env.AI_TERM_APP_TOKEN;
  return token && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}
export function encodeAppControl(token: string, command: AppCommand): string {
  if (!/^[a-f0-9]{64}$/.test(token) || !isAppCommand(command)) throw new Error('Invalid app control');
  return PREFIX + token + ';' + command + '\x1b\\';
}
type InputPart = { data: Buffer } | { command: AppCommand };
export class AppControlFilter {
  private pending = '';
  private emitted = 0;
  private pasted = false;
  private control = false;
  private oversized = false;
  private previous = 0;
  constructor(private readonly token?: string) {}
  push(chunk: Buffer): InputPart[] {
    // Ordinary typing avoids string conversion, byte scanning and buffering.
    if (!this.pending && !this.control && !chunk.includes(27)) return [{ data: chunk }];
    const parts: InputPart[] = [], bytes: number[] = [];
    const flush = () => { if (bytes.length) { parts.push({ data: Buffer.from(bytes) }); bytes.length = 0; } };
    for (const byte of chunk) {
      if (this.control) {
        if (!this.oversized) {
          this.pending += String.fromCharCode(byte);
          if (this.pending.length > 256) { this.oversized = true; this.pending = ''; }
        }
        if (byte === 7 || byte === 92 && this.previous === 27) {
          if (!this.oversized && byte !== 7 && !this.pasted && this.token) {
            const payload = this.pending.slice(PREFIX.length, -2), separator = payload.indexOf(';');
            const command = payload.slice(separator + 1);
            if (payload.slice(0, separator) === this.token && isAppCommand(command)) { flush(); parts.push({ command }); }
          }
          this.pending = ''; this.control = false; this.oversized = false; this.emitted = 0;
        }
        this.previous = byte;
        continue;
      }
      if (byte === 27) {
        // Escape can precede a menu shortcut (vim especially). Reconsider this
        // byte as a fresh prefix instead of leaking the next OSC/token as data.
        bytes.push(...Buffer.from(this.pending.slice(this.emitted), 'latin1'));
        this.pending = '\x1b'; this.emitted = 0; continue;
      }
      if (!this.pending) { bytes.push(byte); continue; }
      this.pending += String.fromCharCode(byte);
      if (this.pending === PREFIX) { this.control = true; this.previous = byte; continue; }
      if (this.pending === PASTE_START || this.pending === PASTE_END) {
        this.pasted = this.pending === PASTE_START;
      } else if ([PREFIX, PASTE_START, PASTE_END].some(prefix => prefix.startsWith(this.pending))) continue;
      bytes.push(...Buffer.from(this.pending.slice(this.emitted), 'latin1'));
      this.pending = ''; this.emitted = 0;
    }
    flush(); return parts;
  }
  flush(): Buffer {
    // After the Escape timeout a bare Escape, or a prefix only a paste marker could complete (Option+[), is a real key.
    // A longer prefix of the app control (Option+] is one) waits for its next byte, so a token can never leak as data.
    if (this.control || !this.pending || this.pending !== '\x1b' && PREFIX.startsWith(this.pending)) return Buffer.alloc(0);
    const held = this.pending.slice(this.emitted); this.emitted = this.pending.length;
    return Buffer.from(held, 'latin1');
  }
}
