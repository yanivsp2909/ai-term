import { renderUnicodeCompact } from 'uqr';
import type { Frame } from './grid.js';
import { channels, type Theme } from './theme.js';
import { TextPanel } from './text-panel.js';
import type { RemoteStatus } from '../../shared/remote.js';

// v1.0.8 /remote: on or off, the pairing QR right after /remote on, and the paired phones. The QR holds the one-time URL
// (its code in the fragment); it is drawn here only, never logged, and works once for two minutes.
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString();
// Scanners want dark modules on a light ground: on a dark panel the blocks draw the light ground instead.
const dark = (color: string) => { const [r = 0, g = 0, b = 0] = channels(color); return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128; };
export function remoteLines(status: RemoteStatus, darkPanel: boolean): { text: string; tone: 'ink' | 'ink-3' | 'status-running' | 'status-waiting' }[] {
  const lines: ReturnType<typeof remoteLines> = [];
  if (status.state === 'off') lines.push({ text: '○ remote off · /remote on starts it (Phone remote must be on in /settings, R)', tone: 'ink' });
  else {
    lines.push({ text: `● remote on · https://${status.host ?? ''} · your tailnet only · off by itself after 30 minutes without a request`, tone: 'status-running' });
    lines.push({ text: status.awake ? 'this Mac stays awake while /remote is on (AC power)' : 'on battery: this Mac may sleep', tone: 'ink-3' });
  }
  if (status.pair) {
    lines.push({ text: `Scan with your phone's camera · works once, until ${clock(status.pair.expiresAt)}`, tone: 'status-waiting' });
    for (const row of renderUnicodeCompact(status.pair.url, { border: 2, invert: darkPanel }).split('\n')) lines.push({ text: row, tone: 'ink' });
    lines.push({ text: status.pair.url, tone: 'ink-3' });
  }
  lines.push({ text: status.phones.length ? 'Paired phones:' : 'No paired phones yet', tone: 'ink' });
  for (const phone of status.phones) lines.push({ text: `  ${phone.name} · ${phone.id} · paired ${day(phone.pairedAt)} · ${phone.lastSeen ? `last seen ${day(phone.lastSeen)} ${clock(phone.lastSeen)}` : 'not seen yet'}`, tone: 'ink-3' });
  lines.push({ text: `${status.state === 'on' ? '/remote off turns it off · ' : ''}/remote revoke <phone> · every action is logged in ~/.ai-term/remote.log · Esc closes`, tone: 'ink-3' });
  return lines;
}
export class RemotePanel {
  private readonly panel: TextPanel;
  private status: RemoteStatus | null = null;
  constructor(changed: () => void, close: () => void, private theme: Theme) { this.panel = new TextPanel('Remote', changed, close); }
  set(status: RemoteStatus): void { this.status = status; this.panel.resetScroll(); this.panel.set(remoteLines(status, dark(this.theme.colors.surface))); }
  key(key: string): void { this.panel.key(key); }
  draw(frame: Frame, theme: Theme): Frame { if (theme !== this.theme && this.status) { this.theme = theme; this.set(this.status); } return this.panel.draw(frame, theme); }
}
