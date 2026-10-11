import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
export class Mirror {
  readonly terminal: headless.Terminal;
  private readonly addon: serialize.SerializeAddon;
  private attached = false;
  constructor(cols: number, rows: number, reply: (data: string) => void) {
    this.terminal = new headless.Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
    this.addon = new serialize.SerializeAddon(); this.terminal.loadAddon(this.addon);
    this.terminal.onData(data => { if (!this.attached) reply(data); });
  }
  setAttached(attached: boolean): void { this.attached = attached; }
  write(data: string): Promise<void> { return new Promise(resolve => this.terminal.write(data, resolve)); }
  snapshot(): string { return this.addon.serialize(); }
  resize(cols: number, rows: number): void { this.terminal.resize(cols, rows); }
  dispose(): void { this.terminal.dispose(); }
}
