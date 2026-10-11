export const BACKGROUND_QUERY='\x1b]11;?\x1b\\';
export function parseBackground(reply) {
  const match=/^\x1b\]11;rgb:([a-f\d]{2}|[a-f\d]{4})\/([a-f\d]{2}|[a-f\d]{4})\/([a-f\d]{2}|[a-f\d]{4})(?:\x07|\x1b\\)$/i.exec(reply);
  if(!match)return null;
  return '#'+match.slice(1).map(part=>Math.round(Number.parseInt(part,16)*255/(part.length===4?65535:255)).toString(16).padStart(2,'0')).join('');
}
// Strip background replies even after the timeout, without swallowing Alt+].
export class BackgroundReplies {
  constructor(onBackground){this.onBackground=onBackground;this.escape=false;this.osc=false;this.terminator=false;this.reply='';}
  push(chunk){
    const output=[];
    for(const byte of chunk){
      if(this.osc){
        this.reply+=String.fromCharCode(byte);
        if(byte===7||this.terminator&&byte===92){
          const background=parseBackground(this.reply);if(background)this.onBackground(background);
          this.osc=false;this.terminator=false;this.reply='';
        }else{
          const header='\x1b]11;';
          if(!header.startsWith(this.reply)&&!this.reply.startsWith(header)){
            output.push(...Buffer.from(this.reply,'latin1'));this.osc=false;this.reply='';
          }else if(this.reply.length>64||this.reply.startsWith(header)&&!/^\x1b\]11;[rgba-f\d:/\x1b]*$/i.test(this.reply)){
            // A valid reply is at most 25 bytes. Discard malformed candidates.
            this.osc=false;this.reply='';
          }
          this.terminator=this.osc&&byte===27;
        }
        continue;
      }
      if(this.escape){
        this.escape=false;
        if(byte===93){this.osc=true;this.reply='\x1b]';continue;}
        output.push(27);
      }
      if(byte===27)this.escape=true;else output.push(byte);
    }
    return Buffer.from(output);
  }
}
