// Preserve bytes, buffering only Escape/CSI prefixes that might encode the home key.
export class HomeKeyFilter {
  private pending:number[]=[];
  private paste=false;
  private emitted=0;
  private stopped=false;
  push(chunk:Buffer):{data:Buffer;home:boolean} {
    const output:number[]=[];let home=false;
    for(const byte of chunk) {
      if(this.stopped)break;
      if(byte===5&&!this.paste){output.push(...this.pending.slice(this.emitted));this.pending=[];this.emitted=0;home=true;this.stopped=true;break;}
      if(this.pending.length===0){if(byte===27)this.pending.push(byte);else output.push(byte);continue;}
      if(byte===27){output.push(...this.pending.slice(this.emitted));this.pending=[27];this.emitted=0;continue;}
      this.pending.push(byte);
      if(this.pending.length===2&&byte===91)continue;
      if(this.pending.length===2||this.pending.length>96||byte>=64&&byte<=126) {
        const sequence=Buffer.from(this.pending).toString('ascii');
        if(sequence==='\x1b[200~')this.paste=true;
        else if(sequence==='\x1b[201~')this.paste=false;
        else if(!this.paste&&sequence.startsWith('\x1b[')&&/^(?:101;5(?::[123])?(?:;[0-9:]+)?u|27;5;101~)$/.test(sequence.slice(2))){home=true;this.stopped=true;this.pending=[];this.emitted=0;break;}
        output.push(...this.pending.slice(this.emitted));this.pending=[];this.emitted=0;
      }
    }
    return {data:Buffer.from(output),home};
  }
  // A bare Escape has no terminator. Only it receives a short ambiguity timeout.
  flush():Buffer {if(this.pending.length!==1||this.emitted)return Buffer.alloc(0);this.emitted=1;return Buffer.from(this.pending);}
}
