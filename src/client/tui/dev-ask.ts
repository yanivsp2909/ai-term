import type { Frame } from './grid.js';
import type { Theme } from './theme.js';
import { TextPanel } from './text-panel.js';
import { devLines } from '../../shared/dev.js';
import type { DevPlan } from '../../shared/dev.js';

// v0.9.2 /dev [agent]: exactly what runs, where, on which port and in which sandbox. y starts it (only that plan); a running
// one shows its last lines, and x stops it. n or Esc does nothing.
export class DevAsk {
  private readonly panel: TextPanel;
  constructor(private readonly plan: DevPlan, changed: () => void, private readonly close: () => void, private readonly start: () => void, private readonly stop: () => void) {
    this.panel = new TextPanel('Dev server', changed, close);
    this.panel.set(devLines(plan));
  }
  key(key: string): void {
    // Without a sandbox it takes a capital Y (review): one easy key shouldn't run agent code with your rights.
    if (key === (this.plan.sandbox ? 'y' : 'Y') && !this.plan.running) { this.close(); this.start(); return; }
    if (key === 'x' && this.plan.running) { this.close(); this.stop(); return; }
    if (key === 'n') { this.close(); return; }
    this.panel.key(key);
  }
  draw(frame: Frame, theme: Theme): Frame { return this.panel.draw(frame, theme); }
}
