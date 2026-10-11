import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { MAX_FRAME_BYTES, type TerminalModes } from '../shared/protocol.js';
export class Mirror {
    readonly terminal: headless.Terminal;
    private readonly addon: serialize.SerializeAddon;
    private attached = false;
    private cursorVisible=true;
    private mouseEncoding:TerminalModes['mouseEncoding']='default';
    constructor(cols: number, rows: number, reply: (data: string) => void) {
        this.terminal = new headless.Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
        this.addon = new serialize.SerializeAddon();
        this.terminal.loadAddon(this.addon);
        // The public modes API omits cursor visibility and mouse encoding.
        for(const final of ['h','l'])this.terminal.parser.registerCsiHandler({prefix:'?',final},params=>{
            for(const param of params) {
                if(param===25)this.cursorVisible=final==='h';
                const encoding=param===1005?'utf8':param===1006?'sgr':param===1015?'urxvt':null;
                if(encoding&&(final==='h'||this.mouseEncoding===encoding))this.mouseEncoding=final==='h'?encoding:'default';
            }
            return false; // Let xterm apply the mode too.
        });
        this.terminal.parser.registerEscHandler({final:'c'},()=>{this.cursorVisible=true;this.mouseEncoding='default';return false;});
        this.terminal.onData(data => { if (!this.attached)
            reply(data); });
    }
    modes():TerminalModes {
        const modes=this.terminal.modes;
        return {applicationCursorKeys:modes.applicationCursorKeysMode,applicationKeypad:modes.applicationKeypadMode,bracketedPaste:modes.bracketedPasteMode,mouseTracking:modes.mouseTrackingMode,mouseEncoding:this.mouseEncoding,focusEvents:modes.sendFocusMode,cursorVisible:this.cursorVisible};
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
