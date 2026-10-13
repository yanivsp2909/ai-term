// A last reply is copied only on an explicit request, so it is kept in memory at a bounded size.
export const MAX_REPLY_BYTES=256*1024;
export function capReply(text:string):string{
 const bytes=Buffer.from(text);let end=Math.min(bytes.length,MAX_REPLY_BYTES);
 // A byte cap can land inside a multibyte code point; drop that partial character.
 while(end<bytes.length&&((bytes[end]??0)&0xc0)===0x80)end--;
 return bytes.subarray(0,end).toString('utf8');
}
