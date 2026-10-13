import {expect,it} from 'vitest';
import {parseCodexStatus,codexTitle,isCodexApproval} from '../src/daemon/codex-status.js';
import {Mirror,type MirrorSignal} from '../src/daemon/mirror.js';
const at='2026-10-13T00:00:00.000Z';
it('Codex notify bodies map only agent-turn-complete to done with a capped reply',()=>{
 expect(parseCodexStatus({type:'agent-turn-complete','last-assistant-message':'ok','input-messages':['AITERMCANARY']},4,at)).toEqual({event:{seq:4,at,kind:'done'},reply:'ok'});
 expect(parseCodexStatus({type:'agent-turn-complete','last-assistant-message':7},4,at)).toEqual({event:{seq:4,at,kind:'done'}});
 expect(parseCodexStatus({type:'agent-turn-complete','last-assistant-message':'é'.repeat(200*1024)},1,at)?.reply).toHaveLength(128*1024);
 for(const raw of [null,[],'agent-turn-complete',{type:'approval-requested'},{},{type:7}])expect(parseCodexStatus(raw,1,at)).toBeNull();
});
it('Codex titles yield only a run state and a remaining-context number',()=>{
 expect(codexTitle('⠋ Working | Context 87% left')).toEqual({run:'working',leftPercent:87});
 expect(codexTitle('Thinking')).toEqual({run:'working',leftPercent:null});
 expect(codexTitle('[ ! ] Action Required | Context 70% left')).toEqual({run:'action',leftPercent:70});
 expect(codexTitle('Ready | Context 100% left')).toEqual({run:'ready',leftPercent:100});
 expect(codexTitle('Starting AITERMCANARY')).toEqual({run:null,leftPercent:null});
 expect(codexTitle('Ready | Context 101% left')).toEqual({run:'ready',leftPercent:null});
 expect(codexTitle('my-Working-dir | Context 0% left')).toEqual({run:null,leftPercent:0});
});
it('only Codex approval OSC 9 messages count as waiting',()=>{
 expect(isCodexApproval('Approval requested: curl https://example.com')).toBe(true);
 expect(isCodexApproval('Codex wants to edit src/a.ts')).toBe(true);
 for(const text of ['All done: Approval requested','Agent turn complete','']) expect(isCodexApproval(text)).toBe(false);
});
it('the daemon mirror reports OSC 9, titles and only bare bells as signals',async()=>{
 const signals:MirrorSignal[]=[],mirror=new Mirror(80,24,()=>{},signal=>signals.push(signal));
 try{
  await mirror.write('\x1b]9;Approval requested: curl\x07');expect(signals).toEqual([{kind:'osc9',text:'Approval requested: curl'}]);signals.length=0;
  await mirror.write('\x1b]0;Working | Context 90% left\x07\x1b]2;Ready\x1b\\');expect(signals).toEqual([{kind:'title',title:'Working | Context 90% left'},{kind:'title',title:'Ready'}]);signals.length=0;
  await mirror.write('\x1b]8;;https://x\x07link\x1b]8;;\x07\x1b]52;c;QUlURVJN\x07');expect(signals).toEqual([]);
  await mirror.write('a\x07b');expect(signals).toEqual([{kind:'bell'}]);
  // OSC 9 text stays out of the screen the preview and copy export render.
  expect(mirror.plainText().text).not.toContain('Approval');
 }finally{mirror.dispose();}
});
