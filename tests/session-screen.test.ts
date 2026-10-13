import { expect, it, vi } from 'vitest';
import headless from '@xterm/headless';
import { Mirror } from '../src/daemon/mirror.js';
import { SessionScreen } from '../src/client/session-screen.js';
import { installPassthrough, parseProbe } from '../src/client/passthrough.js';
import { MouseRewriter } from '../src/client/mouse-rows.js';
import { frameBar } from '../src/client/tui/frame-bar.js';
import { createTheme } from '../src/client/tui/theme.js';
const theme=createTheme('graphite');
it('daemon and attached client use the same width table for CJK, skin tones, ZWJ families and flags',async()=>{
 const daemon=new Mirror(80,8,()=>{}),client=new SessionScreen(80,8,{kitty:false},()=>{},()=>{},()=>'',()=>{});
 try{const text='漢字 🧪 👍🏽 👨‍👩‍👧‍👦 🇮🇱 end';await daemon.write(text);await client.write(daemon.snapshot());
 const cells=(term:headless.Terminal)=>Array.from({length:80},(_,x)=>{const cell=term.buffer.active.getLine(0)?.getCell(x);return [cell?.getChars(),cell?.getWidth()];});
 expect(cells(client.terminal)).toEqual(cells(daemon.terminal));expect(client.terminal.unicode.activeVersion).toBe('11');
 }finally{daemon.dispose();client.dispose();}
});
it('bar drops counts before model, keeps glyph and status word, uses surface and bold name',()=>{
 const session={title:'fix login',engine:'codex',model:'gpt-6.1-sol',status:'running'} as const;
 const wide=frameBar(120,session,[{status:'running'},{status:'done'},{status:'error'}],theme);
 const text=(frame:ReturnType<typeof frameBar>)=>frame[0]?.map(c=>c.char).join('')??'';
 expect(text(wide)).toContain('others ◐ 1  ✓ 1  ✗ 1');expect(text(wide)).toContain('gpt-6.1-sol');
 expect(text(frameBar(60,session,[],theme))).not.toContain('others');expect(text(frameBar(60,session,[],theme))).toContain('gpt-6.1-sol');
 expect(text(frameBar(30,session,[],theme))).not.toContain('gpt-6.1-sol');expect(text(frameBar(12,session,[],theme))).toContain('◐ running');
 expect(wide[0]?.every(c=>c.bg===theme.colors.surface)).toBe(true);expect(wide[0]?.filter(c=>c.bold).map(c=>c.char).join('')).toContain('fix login');
});
it('query policy mirrors screen queries, forwards input modes and copy, drops clipboard reads, links, pixels and images',async()=>{
 const term=new headless.Terminal({cols:80,rows:23,allowProposedApi:true,windowOptions:{getWinSizeChars:true}});const out:string[]=[],reply:string[]=[];
 installPassthrough(term,{kitty:true,foreground:'rgb:ffff/ffff/ffff',background:'rgb:0000/0000/0000'},data=>out.push(data),data=>reply.push(data));term.onData(data=>reply.push(data));
 try{await new Promise<void>(r=>term.write('\x1b[?2004h\x1b[?1006h\x1b[?1016h\x1b[>4;2m\x1b[>3u\x1b[?u\x1b]10;?\x07\x1b]11;?\x07\x1b]4;1;?\x07\x1b]12;?\x07\x1b]52;c;?\x07\x1b]52;c;YWJj\x07\x1b]8;;https://example.com\x07link\x1b]8;;\x07\x1b[18t\x1b[14t\x1b[2;4H\x1b[6n\x1b[c',r));
 expect(out.join('')).toContain('\x1b[?2004h');expect(out.join('')).toContain('\x1b]52;c;YWJj');expect(out.join('')).not.toContain('c;?');expect(out.join('')).not.toContain('example.com');expect(out.join('')).not.toContain('1016h');
 expect(reply).toContain('\x1b[?3u');expect(reply).toContain('\x1b[8;23;80t');expect(reply).toContain('\x1b[2;4R');expect(reply.join('')).toContain('rgb:ffff');
 }finally{term.dispose();}
});
it('probe accepts Terminal.app replies and preserves ordinary early input',()=>{
 expect(parseProbe('\x1b]10;rgb:ffff/ffff/ffff\x07\x1b[?1;2cx')).toMatchObject({done:true,rest:'x',facts:{kitty:false,foreground:'rgb:ffff/ffff/ffff'}});
 expect(parseProbe('')).toMatchObject({done:false});
});
it.each(['sgr','urxvt','default','utf8'] as const)('mouse %s shifts agent rows and drops a bar press and release',encoding=>{
 const mouse=new MouseRewriter(()=>({tracking:true,encoding}));
 const event=(row:number,release=false)=>encoding==='sgr'?Buffer.from(`\x1b[<0;5;${row}${release?'m':'M'}`):encoding==='urxvt'?Buffer.from(`\x1b[${release?35:32};5;${row}M`):Buffer.from([27,91,77,release?35:32,37,row+32]);
 expect(mouse.push(event(1))).toHaveLength(0);expect(mouse.push(event(1,true))).toHaveLength(0);expect(mouse.push(event(5))).toEqual(event(4));
});
it('screen draws changed cells only, resizes below row one and restores cursor',async()=>{
 const output:string[]=[];const screen=new SessionScreen(40,5,{kitty:false},data=>{output.push(data);return true;},()=>{},()=>'',()=>{});
 try{await screen.write('hello');expect(output.join('')).toContain('\x1b[2;1H');output.length=0;await screen.write('\x1b[1;1Hhello');expect(output).toHaveLength(0);
 screen.resize(30,7);expect(screen.terminal.rows).toBe(7);await screen.write('x');await new Promise(r=>setTimeout(r,12));expect(output.join('')).toContain('\x1b[?2026h');
 }finally{screen.dispose();}
});
it('user input flags xterm synchronously and floods are capped at eight milliseconds',async()=>{
 vi.useFakeTimers();const output:string[]=[];const screen=new SessionScreen(20,3,{kitty:false},data=>{output.push(data);return true;},()=>{},()=>'',()=>{});
 try{const input=vi.spyOn(screen.terminal,'input');screen.input();expect(input).toHaveBeenCalledWith('',true);await screen.write('a');const n=output.length;screen.terminal.input('',true);await screen.write('b');expect(output.length).toBe(n);await vi.advanceTimersByTimeAsync(8);expect(output.length).toBeGreaterThan(n);
 }finally{screen.dispose();vi.useRealTimers();}
});
it.each(['sgr','urxvt','default','utf8'] as const)('fragmented %s mouse reports and paste markers survive arbitrary read boundaries',encoding=>{
 const mouse=new MouseRewriter(()=>({tracking:true,encoding}));
 const report=encoding==='sgr'?Buffer.from('\x1b[<0;5;6M'):encoding==='urxvt'?Buffer.from('\x1b[32;5;6M'):Buffer.from([27,91,77,32,37,38]);
 const expected=encoding==='sgr'?Buffer.from('\x1b[<0;5;5M'):encoding==='urxvt'?Buffer.from('\x1b[32;5;5M'):Buffer.from([27,91,77,32,37,37]);
 expect(Buffer.concat([...report].map(b=>mouse.push(Buffer.from([b]))))).toEqual(expected);
 const paste=Buffer.concat([Buffer.from('\x1b[200~'),report,Buffer.from('\x1b[201~'),report]);
 expect(Buffer.concat([...paste].map(b=>mouse.push(Buffer.from([b]))))).toEqual(Buffer.concat([Buffer.from('\x1b[200~'),report,Buffer.from('\x1b[201~'),expected]));
});
it('a changed bar preserves the agent cursor even when no body cells changed',async()=>{
 let bar='\x1b[1;1Hbar';const out:string[]=[];const screen=new SessionScreen(20,3,{kitty:false},s=>{out.push(s);},()=>{},()=>bar,()=>{});
 try{await screen.write('abc');await new Promise(r=>setTimeout(r,12));out.length=0;bar='\x1b[1;1Hnew';screen.changed();expect(out.join('')).toContain('\x1b[2;4H');}finally{screen.dispose();}
});
it('a queued frame cannot paint through an agent synchronized-output begin',async()=>{
 const out:string[]=[];const screen=new SessionScreen(20,3,{kitty:false},s=>{out.push(s);},()=>{},()=>'',()=>{});
 try{await screen.write('a');screen.input();await screen.write('b');screen.input();await screen.write('\x1b[?2026hINCOMPLETE');const n=out.length;await new Promise(r=>setTimeout(r,20));expect(out.length).toBe(n);screen.input();await screen.write('\x1b[?2026l');await new Promise(r=>setTimeout(r,12));expect(out.length).toBeGreaterThan(n);}finally{screen.dispose();}
});
it('complete query policy forwards position-free operations and resets but never raw screen controls or images',async()=>{
 const out:string[]=[],reply:string[]=[];const screen=new SessionScreen(80,23,{kitty:true},s=>{out.push(s);},s=>reply.push(s),()=>'',()=>{});
 try{screen.input();await screen.write('stable');await new Promise(r=>setTimeout(r,12));out.length=0;
 const forwarded=['\x1b[?1;9;1000;1002;1003;1005;1006;1015;1004;1007;2004;12;66;2031h','\x1b=','\x1b>','\x1b[5 q','\x1b[22;0t','\x1b[23;0t','\x1b[?996n','\x1b[>4;2m','\x1b[>3u','\x1b[=1;2u','\x1b[<1u','\x07'];
 for(const id of [0,1,2,7,9,777,4,10,11,12])forwarded.push(`\x1b]${id};value\x1b\\`);
 for(const id of [104,110,111,112])forwarded.push(`\x1b]${id}\x1b\\`);
 screen.input();await screen.write(forwarded.join(''));for(const sequence of forwarded)expect(out.join('')).toContain(sequence);
 screen.input();await screen.write('\x1b[>c\x1b[5n\x1b[?1$p\x1bP$qm\x1b\\\x1b[18t');expect(reply.join('')).toContain('\x1b[0n');expect(reply.join('')).toContain('\x1b[?1;1$y');expect(reply.join('')).toContain('\x1bP1$r');expect(reply).toContain('\x1b[8;23;80t');
 out.length=0;screen.input();await screen.write('\x1bPqSECRET_IMAGE\x1b\\\x1b_Ga=T;SECRET_IMAGE\x1b\\\x1b]1337;File=SECRET_IMAGE\x07');expect(out.join('')).not.toContain('SECRET_IMAGE');
 out.length=0;screen.input();await screen.write('\x1bc');expect(out.join('')).toContain('\x1b[?1;9;1000;1002;1003;1005;1006;1015;1004;1007;2004;12;66;2031l');
 }finally{screen.dispose();}
});
it('agent sync expires after 150 ms and bar text stays unchanged during repeated output',async()=>{
 const out:string[]=[];const screen=new SessionScreen(20,3,{kitty:false},s=>{out.push(s);},()=>{},()=>'<BAR>',()=>{});
 try{screen.input();await screen.write('a');screen.input();await screen.write('\x1b[?2026hb');const before=out.length;await new Promise(r=>setTimeout(r,170));expect(out.length).toBeGreaterThan(before);expect(out.join('').split('<BAR>')).toHaveLength(2);}finally{screen.dispose();}
});
it('narrow bar drops the model while retaining engine before clipping the name',()=>{
 const text=frameBar(30,{title:'fix login',engine:'codex',model:'gpt-6.1-sol',status:'running'},[],theme)[0]?.map(c=>c.char).join('')??'';expect(text).toContain('codex');expect(text).not.toContain('gpt-6.1-sol');
});
