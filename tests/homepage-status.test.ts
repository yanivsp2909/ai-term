import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {cardText,quietSeconds,nextCardTick} from '../src/client/tui/agent-card.js';
import {renderHomepage,sortSessions,type HomepageView} from '../src/client/tui/layout.js';
import {plainText,type Frame} from '../src/client/tui/grid.js';
import {createTheme} from '../src/client/tui/theme.js';
import type {SessionInfo} from '../src/shared/protocol.js';
const NOW=Date.parse('2026-10-13T12:00:00.000Z'),ago=(ms:number)=>new Date(NOW-ms).toISOString(),theme=createTheme('graphite');
function agent(over:Partial<SessionInfo>={}):SessionInfo{return {id:randomUUID(),title:'fix-login',engine:'claude-code',model:'opus-5.5',auth:{kind:'account'},authMethod:'subscription',cwd:'/tmp',permission:'ask',status:'running',statusDetail:'running',statusSince:ago(3000),createdAt:ago(60000),lastOutputAt:ago(1000),exitCode:null,ctxPercent:null,lastActivity:null,...over};}
function view(sessions:SessionInfo[],over:Partial<HomepageView>={}):HomepageView{return {cols:130,rows:45,sessions,selectedId:sessions[0]?.id??null,input:'',note:'',previewVisible:true,cwd:'/tmp',now:NOW,...over};}
const W=27;
function rowText(frame:Frame,y:number,from=0,to=36){return (frame[y]??[]).slice(from,to).map(c=>c.char).join('');}
it.each([
 ['starting',{status:'starting',statusDetail:'starting'},'◐ starting 0m','status-running',null],
 ['running with a recent tool',{lastActivity:{tool:'Bash',at:ago(2000)}},'◐ running 0m','status-running',{text:'Bash',color:'ink-3'}],
 ['waiting for permission',{status:'waiting',statusDetail:'permission'},'● waiting 0m','status-waiting',{text:'asks: permission',color:'status-waiting'}],
 ['waiting with a question',{status:'waiting',statusDetail:'question'},'● waiting 0m','status-waiting',{text:'asks: question',color:'status-waiting'}],
 ['a failed turn',{status:'waiting',statusDetail:'turn failed: rate_limit'},'● waiting 0m','status-waiting',{text:'turn failed: rate_limit',color:'status-waiting'}],
 ['done',{status:'done',statusDetail:'done'},'✓ done 0m','status-done',{text:'ready to review',color:'ink-3'}],
 ['exited',{status:'exited',statusDetail:'exit 0',exitCode:0},'■ exited 0m','status-idle',null],
 ['failed with an exit code',{status:'error',statusDetail:'exit 2',exitCode:2},'✗ failed 0m','status-error',{text:'exit 2',color:'status-error'}],
 ['failed by signal',{status:'error',statusDetail:'signal SIGKILL',exitCode:null},'✗ failed 0m','status-error',{text:'signal SIGKILL',color:'status-error'}],
] as const)('a %s card has glyph, word and age, and its activity',(_name,over,status,color,activity)=>{
 const card=cardText(agent(over),NOW,W);
 expect(card.status).toMatchObject({text:status,color});expect(card.status.bold).toBe(over.status==='waiting');
 expect(card.activity).toEqual(activity);
});
it('ctx shows only when known, rounds, and turns status-waiting from 85%',()=>{
 expect(cardText(agent(),NOW,W).ctx).toBeNull();
 expect(cardText(agent({ctxPercent:62.4}),NOW,W).ctx).toEqual({text:'ctx 62%',color:'ink-3'});
 expect(cardText(agent({ctxPercent:84.4}),NOW,W).ctx).toEqual({text:'ctx 84%',color:'ink-3'});
 expect(cardText(agent({ctxPercent:85}),NOW,W).ctx).toEqual({text:'ctx 85%',color:'status-waiting'});
 const frame=renderHomepage(view([agent({ctxPercent:91})]),theme),line=rowText(frame,3);expect(line).toContain('ctx 91%');
 const x=line.indexOf('ctx 91%');expect(frame[3]?.[x]?.fg).toBe(theme.colors['status-waiting']);
});
it('quiet starts 10 s after the newest output, tool or status change and counts seconds, then minutes',()=>{
 expect(quietSeconds(agent({lastOutputAt:ago(9999),statusSince:ago(20000)}),NOW)).toBeNull();
 expect(quietSeconds(agent({lastOutputAt:ago(12000),statusSince:ago(20000)}),NOW)).toBe(12);
 expect(quietSeconds(agent({lastOutputAt:ago(30000),statusSince:ago(30000),lastActivity:{tool:'Bash',at:ago(4000)}}),NOW)).toBeNull();
 expect(quietSeconds(agent({status:'waiting',statusDetail:'permission',lastOutputAt:ago(60000),statusSince:ago(60000)}),NOW)).toBeNull();
 expect(cardText(agent({lastOutputAt:ago(42000),statusSince:ago(50000),lastActivity:{tool:'Bash',at:ago(45000)}}),NOW,W).activity).toEqual({text:'quiet 42s',color:'ink-3'});
 expect(cardText(agent({lastOutputAt:ago(185000),statusSince:ago(190000)}),NOW,W).activity).toEqual({text:'quiet 3m',color:'ink-3'});
 expect(cardText(agent({lastOutputAt:null,statusSince:ago(11000)}),NOW,W).activity).toEqual({text:'quiet 11s',color:'ink-3'});
});
it('the quiet tick asks for one redraw per second only while a card is quiet, else one at the next crossing',()=>{
 expect(nextCardTick([agent({status:'done',statusDetail:'done'})],NOW)).toBeNull();
 expect(nextCardTick([agent({lastOutputAt:ago(12300),statusSince:ago(20000)})],NOW)).toBe(700);
 expect(nextCardTick([agent({lastOutputAt:ago(4000),statusSince:ago(20000)})],NOW)).toBe(6000);
 expect(nextCardTick([agent({lastOutputAt:ago(4000),statusSince:ago(20000)}),agent({lastOutputAt:ago(15500),statusSince:ago(20000)})],NOW)).toBe(500);
 expect(nextCardTick([],NOW)).toBeNull();
});
it('line 3 shows the activity, keeps auth when it fits whole, and shows auth alone without activity; Don\'t ask keeps its !',()=>{
 const text=plainText(renderHomepage(view([agent({status:'waiting',statusDetail:'permission',permission:'dontAsk',statusSince:ago(240000)}),agent({title:'idle-one',status:'starting',statusDetail:'starting',createdAt:ago(120000)})]),theme));
 expect(text).toContain('! ● waiting 4m');expect(text).toContain('asks: permission');expect(text).toContain('own login · sub');
 expect(cardText(agent({status:'done',statusDetail:'done'}),NOW,W).line3).toBe('ready to review');
 expect(cardText(agent({status:'done',statusDetail:'done'}),NOW,40).line3).toBe('ready to review · own login · sub');
 expect(cardText(agent({status:'starting',statusDetail:'starting'}),NOW,W).line3).toBe('own login · sub');
 expect(cardText(agent({auth:{kind:'key',keyId:randomUUID(),provider:'anthropic',keyLabel:'k',last4:'AB12'},authMethod:'api-key'}),NOW,W).line3).toBe('API key ····AB12');
});
it('narrow cards drop ctx, age and activity before the status word',()=>{
 const card=cardText(agent({status:'waiting',statusDetail:'turn failed: authentication_failed',ctxPercent:90,statusSince:ago(7200000),model:'gpt-6.1-sol-long-name'}),NOW,16);
 expect(card.status.text).toBe('● waiting');expect(card.ctx).toBeNull();expect(card.activity).toBeNull();expect(card.line3).toBe('own login · sub');
 // At normal widths a long reason is clipped by the row, never dropped.
 expect(cardText(agent({status:'waiting',statusDetail:'turn failed: max_output_tokens'}),NOW,W).line3).toBe('turn failed: max_output_tokens');
 const roomy=cardText(agent({status:'waiting',statusDetail:'permission',ctxPercent:90,statusSince:ago(7200000)}),NOW,W);
 expect(roomy.status.text).toBe('● waiting 2h');expect(roomy.ctx?.text).toBe('ctx 90%');
 for(const cols of [60,80,99]){const text=plainText(renderHomepage(view([agent({status:'waiting',statusDetail:'permission',ctxPercent:90})],{cols,rows:30}),theme));expect(text).toContain('● waiting');expect(text).toContain('asks: permission');expect(text).toContain('ctx 90%');}
});
it('top line counts waiting, running, to review and failed with glyphs; zero counts are hidden',()=>{
 const sessions=[agent({status:'waiting',statusDetail:'permission'}),agent({status:'starting',statusDetail:'starting'}),agent(),agent({status:'done',statusDetail:'done'}),agent({status:'exited',statusDetail:'exit 0'})];
 const top=plainText(renderHomepage(view(sessions),theme)).split('\n')[0]??'';
 expect(top).toContain('● 1 waiting');expect(top).toContain('◐ 2 running');expect(top).toContain('✓ 1 to review');expect(top).not.toContain('failed');
 expect(top.indexOf('● 1 waiting')).toBeLessThan(top.indexOf('◐ 2 running'));expect(top.indexOf('◐ 2 running')).toBeLessThan(top.indexOf('✓ 1 to review'));
 const failed=plainText(renderHomepage(view([agent({status:'error',statusDetail:'exit 1',exitCode:1})]),theme)).split('\n')[0]??'';expect(failed).toContain('✗ 1 failed');expect(failed).not.toContain('running');
});
it('waiting agents sort first, then newest; the selection mark follows the same agent',()=>{
 const older=agent({title:'older',createdAt:ago(500000)}),newer=agent({title:'newer',createdAt:ago(1000)}),asks=agent({title:'asks',status:'waiting',statusDetail:'question',createdAt:ago(900000)});
 expect(sortSessions([older,newer,asks]).map(s=>s.title)).toEqual(['asks','newer','older']);
 const frame=renderHomepage(view([older,newer,asks],{selectedId:older.id}),theme),rows=[2,5,8].map(y=>rowText(frame,y));
 expect(rows.map(r=>r.slice(7,13).trim())).toEqual(['asks','newer','older']);expect(rows.map(r=>r[1])).toEqual([' ',' ','▎']);
});
it('the preview header puts ctx after the agent cpu/RAM text when known',()=>{
 const selected=agent({ctxPercent:62});
 const stats={cpuPercent:10,memUsedBytes:1,memTotalBytes:2,netRxBytesPerSec:0,netTxBytesPerSec:0,sessions:[{sessionId:selected.id,cpuPercent:4,rssBytes:310*1024*1024}]};
 const header=plainText(renderHomepage(view([selected],{stats}),theme)).split('\n')[2]??'';
 expect(header).toMatch(/cpu 4% · 310 MB {2}ctx 62% │$/);
 expect(plainText(renderHomepage(view([agent()],{stats}),theme)).split('\n')[2]).not.toContain('ctx');
});
