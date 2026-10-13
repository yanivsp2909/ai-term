export type Encoding = 'default' | 'utf8' | 'sgr' | 'urxvt';
export interface MouseState { tracking: boolean; encoding: Encoding }

// eslint-disable-next-line no-control-regex -- Mouse reports are terminal control sequences.
const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
// eslint-disable-next-line no-control-regex -- Mouse reports are terminal control sequences.
const URXVT = /\x1b\[(\d+);(\d+);(\d+)M/g;
const PASTE_START = '\x1b[200~', PASTE_END = '\x1b[201~';

// Button codes: low 2 bits 3 = release (legacy encodings), +32 = motion, 64/65 = wheel.
// A press dropped on the bar also drops its release, so the agent never sees half a click.
function shifter(): (button: number, row: number, release: boolean) => number | null {
  let pressDropped = false;
  return (button, row, release) => {
    const isWheel = (button & 64) !== 0, isMotion = (button & 32) !== 0;
    if (release && pressDropped) { pressDropped = false; return null; }
    if (row > 1) return row - 1;
    if (release || isMotion) return isWheel ? null : 1;
    if (!isWheel) pressDropped = true;
    return null;
  };
}

export class MouseRewriter {
  private carry: Buffer = Buffer.alloc(0);
  private paste = false;
  private readonly shift = shifter();
  dropped = 0;
  constructor(private readonly state: () => MouseState) {}
  push(chunk: Buffer): Buffer {
    const { tracking, encoding } = this.state();
    const data = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    this.carry = Buffer.alloc(0);
    if (!tracking) return data;
    const result:Buffer[]=[];let at=0;
    while(at<data.length){
      if(this.paste){
        const end=data.indexOf(PASTE_END,at);
        if(end>=0){result.push(data.subarray(at,end+PASTE_END.length));at=end+PASTE_END.length;this.paste=false;continue;}
        let suffix=0;
        for(let n=1;n<PASTE_END.length&&n<=data.length-at;n++)if(data.subarray(data.length-n).equals(Buffer.from(PASTE_END.slice(0,n))))suffix=n;
        result.push(data.subarray(at,data.length-suffix));this.carry=data.subarray(data.length-suffix);break;
      }
      if(data[at]!==27){result.push(data.subarray(at,at+1));at++;continue;}
      const text=data.subarray(at).toString('latin1');
      if(PASTE_START.startsWith(text)||'\x1b[M'.startsWith(text)||encoding==='sgr'&&'\x1b[<'.startsWith(text)||encoding==='urxvt'&&text==='\x1b['){this.carry=data.subarray(at);break;}
      if(text.startsWith(PASTE_START)){result.push(data.subarray(at,at+PASTE_START.length));at+=PASTE_START.length;this.paste=true;continue;}
      if((encoding==='default'||encoding==='utf8')&&text.startsWith('\x1b[M')){
        let end=at+3,count=0;
        while(count<3&&end<data.length){const first=data[end]??0;end+=encoding==='utf8'&&first>=0xc0?2:1;count++;}
        if(count<3||end>data.length){this.carry=data.subarray(at);break;}
        result.push(this.legacy(data.subarray(at,end),encoding==='utf8'));at=end;continue;
      }
      const pattern=encoding==='sgr'?SGR:URXVT;pattern.lastIndex=0;
      // eslint-disable-next-line no-restricted-properties -- RegExp matching, not a subprocess.
      const match=pattern.exec(text);
      if(match?.index===0){
        const [,b='',x='',y='',final='M']=match;const button=Number(b)-(encoding==='urxvt'?32:0);
        const row=this.shift(button,Number(y),encoding==='sgr'?final==='m':(button&3)===3);
        if(row===null)this.dropped++;else result.push(Buffer.from(`\x1b[${encoding==='sgr'?'<':''}${b};${x};${row}${final}`,'latin1'));
        at+=match[0].length;continue;
      }
      // Keep only a bounded unfinished mouse candidate; unrelated escape keys pass immediately.
      // eslint-disable-next-line no-control-regex -- Mouse control sequence prefix.
      if(text.length<64&&(encoding==='sgr'? /^\x1b\[<[\d;]*$/.test(text):encoding==='urxvt'&&/^\x1b\[[\d;]*$/.test(text))){this.carry=data.subarray(at);break;}
      result.push(data.subarray(at,at+1));at++;
    }
    return Buffer.concat(result);
  }
  flush():Buffer{const pending=this.carry;this.carry=Buffer.alloc(0);return pending;}
  // X10/normal (`CSI M b x y`, each value + 32 in one byte) and UTF-8 1005 (values as UTF-8 code points).
  private legacy(data: Buffer, utf8: boolean): Buffer {
    const out: number[] = [];
    for (let i = 0; i < data.length;) {
      if (data[i] !== 0x1b || data[i + 1] !== 0x5b || data[i + 2] !== 0x4d) { out.push(data[i] ?? 0); i++; continue; }
      const values: number[] = []; let j = i + 3;
      while (values.length < 3 && j < data.length) {
        const first = data[j] ?? 0;
        if (utf8 && first >= 0xc0) { values.push(((first & 0x1f) << 6) | ((data[j + 1] ?? 0) & 0x3f)); j += 2; }
        else { values.push(first); j++; }
      }
      if (values.length < 3 || j > data.length) { this.carry = data.subarray(i); break; }
      const [b = 32, x = 32, y = 32] = values, button = b - 32, row = this.shift(button, y - 32, (button & 3) === 3);
      if (row === null) { this.dropped++; i = j; continue; }
      const encode = (v: number): number[] => utf8 && v >= 128 ? [0xc0 | (v >> 6), 0x80 | (v & 0x3f)] : [v];
      out.push(0x1b, 0x5b, 0x4d, ...encode(b), ...encode(x), ...encode(row + 32));
      i = j;
    }
    return Buffer.from(out);
  }
}
