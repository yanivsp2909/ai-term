import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { MAX_FRAME_BYTES, MAX_COPY_BYTES, type TerminalModes } from '../shared/protocol.js';
import { useUnicode11 } from '../shared/unicode-width.js';
// eslint-disable-next-line no-control-regex -- C0/C1 controls never reach the clipboard.
const COPY_STRIP=/[\u0000-\u001f\u007f-\u009f\p{Zl}\p{Zp}]|(?!\u200d)\p{Cf}/gu;
export class Mirror {
    readonly terminal: headless.Terminal;
    private readonly addon: serialize.SerializeAddon;
    private attached = false;
    private cursorVisible=true;
    private mouseEncoding:TerminalModes['mouseEncoding']='default';
    constructor(cols: number, rows: number, reply: (data: string) => void) {
        this.terminal = new headless.Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
        useUnicode11(this.terminal);
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
    plainText():{text:string;truncated:boolean} {
        const buffer=this.terminal.buffer.active,lines:string[]=[];let logical='';
        for(let row=0;row<buffer.length;row++){
            const line=buffer.getLine(row);if(!line)continue;
            if(row>0&&!line.isWrapped){lines.push(logical.trimEnd());logical='';}
            // Read parsed cells, including spaces inside soft wraps; OSC/CSI payloads are absent here.
            const next=buffer.getLine(row+1),last=line.getCell(this.terminal.cols-1);
            // xterm pads an empty last cell before a wide glyph wraps; explicit space cells stay.
            const end=next?.isWrapped&&next.getCell(0)?.getWidth()===2&&last?.getCode()===0&&last.getWidth()===1?this.terminal.cols-1:this.terminal.cols;
            // Copy exports strip C0/C1 controls and invisible format characters (bidi overrides, zero-width,
            // tag characters) that make pasted text read differently from what it is; ZWJ only joins emoji.
            logical+=line.translateToString(false,0,end).replace(COPY_STRIP,'');
        }
        lines.push(logical.trimEnd());while(lines.at(-1)==='')lines.pop();
        const bytes=Buffer.from(lines.join('\n'),'utf8');if(bytes.length<=MAX_COPY_BYTES)return {text:bytes.toString('utf8'),truncated:false};
        let start=bytes.length-MAX_COPY_BYTES;
        // A byte cap can land inside a multibyte code point. Keep only its complete newer suffix.
        while(start<bytes.length&&((bytes[start]??0)&0xc0)===0x80)start++;
        return {text:bytes.subarray(start).toString('utf8'),truncated:true};
    }
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
