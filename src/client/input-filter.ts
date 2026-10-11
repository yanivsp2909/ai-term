// Preserve bytes, buffering only Escape/CSI prefixes that might encode the home key.
export class HomeKeyFilter {
  private pending:number[]=[];
  private paste=false;
  private stopped=false;
  push(chunk:Buffer):{data:Buffer;home:boolean} {
    const output:number[]=[];let home=false;
    for(const byte of chunk) {
      if(this.stopped)break;
      if(byte===5&&!this.paste){output.push(...this.pending);this.pending=[];home=true;this.stopped=true;break;}
      if(this.pending.length===0){if(byte===27)this.pending.push(byte);else output.push(byte);continue;}
      this.pending.push(byte);
      if(this.pending.length===2&&byte===91)continue;
      if(this.pending.length===2||this.pending.length>96||byte>=64&&byte<=126) {
        const sequence=Buffer.from(this.pending).toString('ascii');
        if(sequence==='\x1b[200~')this.paste=true;
        else if(sequence==='\x1b[201~')this.paste=false;
        else if(!this.paste&&/^\x1b\[(?:101;5(?::[123])?(?:;[0-9:]+)?u|27;5;101~)$/.test(sequence)){home=true;this.stopped=true;this.pending=[];break;}
        output.push(...this.pending);this.pending=[];
      }
    }
    return {data:Buffer.from(output),home};
  }
  // A bare Escape has no terminator. Only it receives a short ambiguity timeout.
  flush():Buffer {if(this.pending.length!==1)return Buffer.alloc(0);const value=Buffer.from(this.pending);this.pending=[];return value;}
}
