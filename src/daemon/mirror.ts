import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { MAX_FRAME_BYTES } from '../shared/protocol.js';
export class Mirror {
    readonly terminal: headless.Terminal;
    private readonly addon: serialize.SerializeAddon;
    private attached = false;
    constructor(cols: number, rows: number, reply: (data: string) => void) {
        this.terminal = new headless.Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
        this.addon = new serialize.SerializeAddon();
        this.terminal.loadAddon(this.addon);
        this.terminal.onData(data => { if (!this.attached)
            reply(data); });
    }
    setAttached(attached: boolean): void { this.attached = attached; }
    write(data: string): Promise<void> { return new Promise(resolve => this.terminal.write(data, resolve)); }
    snapshot(): string {
        // Reserve JSON escaping/envelope space; retain the screen before scrollback.
        const limit = MAX_FRAME_BYTES - 2048;
        let lines = 5000;
        while (true) {
            const snapshot = this.addon.serialize({scrollback:lines});
            if (Buffer.byteLength(JSON.stringify(snapshot)) < limit) return snapshot;
            if (lines === 0) throw new Error('Current terminal screen exceeds snapshot frame limit');
            lines = Math.floor(lines / 2);
        }
    }
    resize(cols: number, rows: number): void { this.terminal.resize(cols, rows); }
    dispose(): void { this.terminal.dispose(); }
}
