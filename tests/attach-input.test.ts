import { expect, it } from 'vitest';
import { HomeKeyFilter } from '../src/client/input-filter.js';
it('intercepts raw Ctrl+E and forwards other binary input unchanged',()=>{
 const filter=new HomeKeyFilter();const result=filter.push(Buffer.from([97,0,255,5,98]));expect(result.home).toBe(true);expect(result.data).toEqual(Buffer.from([97,0,255]));
});
it('intercepts CSI-u and modifyOtherKeys Ctrl+E across every split',()=>{
 for(const sequence of ['\x1b[101;5u','\x1b[101;5:1u','\x1b[101;5:2u','\x1b[101;5:3u','\x1b[27;5;101~'])for(let split=0;split<=sequence.length;split++){
  const filter=new HomeKeyFilter();const first=filter.push(Buffer.from(sequence.slice(0,split)));const second=filter.push(Buffer.from(sequence.slice(split)));expect(first.home||second.home).toBe(true);expect(Buffer.concat([first.data,second.data])).toHaveLength(0);
 }
});
it('forwards Ctrl+E and protocol forms inside split bracketed paste',()=>{
 const text=Buffer.from('\x1b[200~text\x05\x1b[101;5u\x1b[27;5;101~\x1b[201~');
 for(let split=0;split<=text.length;split++){
  const filter=new HomeKeyFilter();const a=filter.push(text.subarray(0,split)),b=filter.push(text.subarray(split));expect(a.home||b.home).toBe(false);expect(Buffer.concat([a.data,b.data])).toEqual(text);expect(filter.push(Buffer.from([5])).home).toBe(true);
 }
});
it('forwards unrelated sequences, split UTF-8, and flushes a standalone Escape',()=>{
 const filter=new HomeKeyFilter();const text=Buffer.from('é\x1b[A\x1b[102;5u\x1b[27;3;101~');const output:Buffer[]=[];
 for(const byte of text){const r=filter.push(Buffer.from([byte]));expect(r.home).toBe(false);output.push(r.data);}expect(Buffer.concat(output)).toEqual(text);
 expect(filter.push(Buffer.from([27])).data).toHaveLength(0);expect(filter.flush()).toEqual(Buffer.from([27]));
});
