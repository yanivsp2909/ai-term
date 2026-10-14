import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { MAX_FRAME_BYTES, MAX_COPY_BYTES, FIND_LINE_CHARS, type FindMatch, type TerminalModes } from '../shared/protocol.js';
import { useUnicode11 } from '../shared/unicode-width.js';
// Terminal signals the daemon reads for status (S15: the daemon's mirror, never the client). Text is passed on, never stored or logged here.
export type MirrorSignal={kind:'bell'}|{kind:'osc9';text:string}|{kind:'title';title:string};
// eslint-disable-next-line no-control-regex -- C0/C1 controls never reach the clipboard.
const COPY_STRIP=/[\u0000-\u001f\u007f-\u009f\p{Zl}\p{Zp}]|(?!\u200d)\p{Cf}/gu;
// /find results are drawn as plain text: every control, format and private-use character goes.
const FIND_STRIP=/[\p{C}\p{Zl}\p{Zp}]/gu;
// Lower-cased text plus, for each of its UTF-16 units, the offset in the original. A few characters change length when
// lower-cased (İ), so matching on the folded text and slicing the original needs the map.
function fold(text:string):{text:string;map:number[]}{
    let folded='',offset=0;const map:number[]=[];
    for(const char of text){const lower=char.toLowerCase();for(let i=0;i<lower.length;i++)map.push(offset);folded+=lower;offset+=char.length;}
    map.push(offset);return {text:folded,map};
}
export class Mirror {
    readonly terminal: headless.Terminal;
    private readonly addon: serialize.SerializeAddon;
    private attached = false;
    private appearance:Pick<TerminalModes,'cursorShape'|'title'|'kittyFlags'|'themeReports'>={};
    private cursorVisible=true;
    private mouseEncoding:TerminalModes['mouseEncoding']='default';
    constructor(cols: number, rows: number, reply: (data: string) => void, signal?: (signal: MirrorSignal) => void) {
        this.terminal = new headless.Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
        useUnicode11(this.terminal);
        this.addon = new serialize.SerializeAddon();
        this.terminal.loadAddon(this.addon);
        // The public modes API omits cursor visibility and mouse encoding.
        for(const final of ['h','l'])this.terminal.parser.registerCsiHandler({prefix:'?',final},params=>{
            for(const param of params) {
                if(param===2031)this.appearance.themeReports=final==='h';
                if(param===25)this.cursorVisible=final==='h';
                const encoding=param===1005?'utf8':param===1006?'sgr':param===1015?'urxvt':null;
                if(encoding&&(final==='h'||this.mouseEncoding===encoding))this.mouseEncoding=final==='h'?encoding:'default';
            }
            return false; // Let xterm apply the mode too.
        });
        this.terminal.parser.registerEscHandler({final:'c'},()=>{this.cursorVisible=true;this.mouseEncoding='default';this.appearance={};return false;});
        const parser=this.terminal.parser;
        parser.registerCsiHandler({intermediates:' ',final:'q'},params=>{const shape=params[0];if(typeof shape==='number'&&shape>=0&&shape<=6)this.appearance.cursorShape=shape;return false;});
        this.terminal.onTitleChange(title=>{this.appearance.title=title.replace(/[\p{C}\p{Zl}\p{Zp}]/gu,'').slice(0,1024);});
        parser.registerCsiHandler({prefix:'>',final:'u'},params=>{const stack=this.appearance.kittyFlags??[0],flags=params[0];if(typeof flags==='number'&&flags>=0&&flags<=31&&stack.length<64)this.appearance.kittyFlags=[...stack,flags];return true;});
        parser.registerCsiHandler({prefix:'<',final:'u'},params=>{const stack=this.appearance.kittyFlags??[0],count=typeof params[0]==='number'&&params[0]>0?params[0]:1;this.appearance.kittyFlags=stack.slice(0,Math.max(1,stack.length-count));return true;});
        parser.registerCsiHandler({prefix:'=',final:'u'},params=>{const stack=this.appearance.kittyFlags??[0],flags=params[0],how=params[1]??1;const current=stack.at(-1)??0;if(typeof flags==='number'&&flags>=0&&flags<=31){stack[stack.length-1]=how===1?flags:how===2?current|flags:current&~flags;this.appearance.kittyFlags=stack;}return true;});
        if(signal){
            // xterm's parser keeps OSC terminators apart from a bell: onBell fires only for a BEL outside any sequence.
            this.terminal.onBell(()=>signal({kind:'bell'}));
            this.terminal.onTitleChange(title=>signal({kind:'title',title}));
            this.terminal.parser.registerOscHandler(9,text=>{signal({kind:'osc9',text});return false;});
        }
        this.terminal.onData(data => { if (!this.attached)
            reply(data); });
    }
    modes():TerminalModes {
        const modes=this.terminal.modes;
        return {...this.appearance,applicationCursorKeys:modes.applicationCursorKeysMode,applicationKeypad:modes.applicationKeypadMode,bracketedPaste:modes.bracketedPasteMode,mouseTracking:modes.mouseTrackingMode,mouseEncoding:this.mouseEncoding,focusEvents:modes.sendFocusMode,cursorVisible:this.cursorVisible};
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
    // /find: plain-text, case-insensitive matches in the scrollback and screen, newest first, at most `limit`.
    // Rows joined by soft wraps are searched as one line; fromEnd names the row the match starts on.
    find(query:string,limit:number):Omit<FindMatch,'sessionId'>[]{
        const buffer=this.terminal.buffer.active,needle=query.toLowerCase(),found:Omit<FindMatch,'sessionId'>[]=[];
        for(let bottom=buffer.length-1;bottom>=0&&found.length<limit;){
            let top=bottom;while(top>0&&buffer.getLine(top)?.isWrapped)top--;
            let line='';const starts:number[]=[];
            for(let row=top;row<=bottom;row++){starts.push(line.length);line+=buffer.getLine(row)?.translateToString(row===bottom)??'';}
            const folded=fold(line),hits:Omit<FindMatch,'sessionId'>[]=[];
            for(let at=folded.text.indexOf(needle);at>=0;at=folded.text.indexOf(needle,at+Math.max(1,needle.length))){
                const start=folded.map[at]??0,end=folded.map[at+needle.length]??line.length;if(end<=start)continue;
                const row=top+starts.filter(offset=>offset<=start).length-1;
                const before=line.slice(Math.max(0,start-40),start).replace(FIND_STRIP,'').trimStart(),match=line.slice(start,end).replace(FIND_STRIP,'');
                const after=[...line.slice(end).replace(FIND_STRIP,'')].slice(0,Math.max(0,FIND_LINE_CHARS-before.length-match.length)).join('').trimEnd();
                if(match)hits.push({fromEnd:buffer.length-1-row,text:before+match+after,start:before.length,length:match.length});
            }
            found.push(...hits.reverse().slice(0,limit-found.length));bottom=top-1;
        }
        return found;
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
