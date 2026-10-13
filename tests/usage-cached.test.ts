import {expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {UsageParser} from '../src/daemon/usage-parse.js';
import {UsageStore} from '../src/daemon/usage.js';
import {estimateCost} from '../src/daemon/usage-prices.js';
import {validateUsageSummary} from '../src/shared/validate.js';
import {renderHomepage} from '../src/client/tui/layout.js';
import {plainText,type Frame} from '../src/client/tui/grid.js';
import {createTheme} from '../src/client/tui/theme.js';
import type {UsagePeriod,UsageRecord} from '../src/shared/protocol.js';
const theme=createTheme('graphite');
// rust-v0.160.1 response.completed: input_token_count already includes cached_token_count (Codex also exports
// non_cached_input_tokens = input − cached), and output_token_count already includes reasoning_token_count.
const completed=(input:string,output:string,cached:string,reasoning:string,time:string)=>({resourceLogs:[{scopeLogs:[{logRecords:[{timeUnixNano:time,attributes:[{key:'event.name',value:{stringValue:'codex.sse_event'}},{key:'event.kind',value:{stringValue:'response.completed'}},{key:'input_token_count',value:{stringValue:input}},{key:'output_token_count',value:{stringValue:output}},{key:'cached_token_count',value:{intValue:cached}},{key:'reasoning_token_count',value:{intValue:reasoning}}]}]}]}]});
it('Codex totals count input once with its cached share and never add reasoning on top of output',()=>{
 const context={sessionId:randomUUID(),provider:'foundry' as const,engine:'codex' as const,model:'gpt-6.1-sol'},parser=new UsageParser(()=>{});
 const [record]=parser.parse('/v1/logs',completed('80300','500','71000','300','1'),context);
 expect(record).toMatchObject({inputTokens:80300,outputTokens:500,cachedTokens:71000});
 // Uncached input at the input rate, cached input at the cache rate, output (reasoning included) at the output rate.
 expect(estimateCost({input:2,output:8,cacheRead:0.5},80300,500,71000)).toBeCloseTo((9300*2+71000*0.5+500*8)/1e6,12);
 expect(estimateCost({input:2,output:8},1000,100,0)).toBeCloseTo((1000*2+100*8)/1e6,12);
});
it('the usage summary keeps cached tokens beside the totals, with and without cache',async()=>{
 const root=await mkdtemp('/tmp/ai-usage-cached-');
 try{
  const now=new Date(),store=new UsageStore(root,{error:()=>{}},()=>now,async()=>{}),ts=now.toISOString();
  const record=(over:Partial<UsageRecord>):UsageRecord=>({ts,sessionId:randomUUID(),provider:'foundry',model:'gpt-6.1-sol',inputTokens:0,outputTokens:0,costUsd:0.01,costSource:'price-table',...over});
  await store.add(record({inputTokens:1000,outputTokens:200}));
  expect(store.summary().today).toMatchObject({tokens:1200,cachedTokens:0});
  await store.add(record({inputTokens:80300,outputTokens:500,cachedTokens:71000}));
  await store.add(record({provider:'anthropic',model:'sonnet',inputTokens:300,outputTokens:0,cachedTokens:300,costSource:'cli-estimate'}));
  const today=store.summary().today;
  expect(today).toMatchObject({tokens:82300,cachedTokens:71300});
  expect(today.providers.find(p=>p.provider==='foundry')).toMatchObject({tokens:82000,cachedTokens:71000});
  expect(validateUsageSummary(store.summary())).toEqual(store.summary());
 }finally{await rm(root,{recursive:true,force:true});}
 // A summary from a daemon without the field still validates; a broken count does not.
 const period={costUsd:0,tokens:5,unknownPrice:false,providers:[]};
 expect(()=>validateUsageSummary({today:period,week:period,month:period})).not.toThrow();
 for(const cachedTokens of [-1,1.5,'7'])expect(()=>validateUsageSummary({today:{...period,cachedTokens},week:period,month:period})).toThrow();
});
function tokensRow(frame:Frame):string{return plainText(frame).split('\n').find(line=>line.includes('│ tokens'))??'';}
const usage=(today:Partial<UsagePeriod>,rest:Partial<UsagePeriod>={})=>{const base={costUsd:0.16,tokens:80800,cachedTokens:0,unknownPrice:false,providers:[]};return {today:{...base,...today},week:{...base,...rest},month:{...base,...rest}};};
it('the tokens row shows the cached share in the widest form that fits the panel',()=>{
 const view=(cols:number,u:ReturnType<typeof usage>)=>renderHomepage({cols,rows:45,sessions:[],selectedId:null,input:'',note:'',previewVisible:true,cwd:'/tmp',now:0,usage:u,budgets:{daily:null,weekly:null,monthly:null}},theme);
 // Wide panel: the words fit.
 const wide=view(220,usage({cachedTokens:71000},{cachedTokens:71000}));expect(tokensRow(wide)).toContain('80.8K (71.0K cached)');
 // The 130-column reference: just the number in parentheses, with the legend on the hint line.
 const reference=view(130,usage({cachedTokens:71000},{cachedTokens:71000})),text=plainText(reference);
 expect(tokensRow(reference)).toContain('80.8K (71.0K)');expect(tokensRow(reference)).not.toContain('cached');expect(text).toContain('(…) cached · b add');
 const cached=reference.flat().find((cell,i,cells)=>cell.char==='7'&&cells[i-1]?.char==='(');expect(cached?.fg).toBe(theme.colors['ink-3']);
 // A period without cache shows its total alone; no cache anywhere means no legend.
 const mixed=view(130,usage({cachedTokens:71000},{cachedTokens:0}));expect(tokensRow(mixed)).toMatch(/80\.8K \(71\.0K\)\s+80\.8K\s+80\.8K/);
 const none=view(130,usage({}));expect(tokensRow(none)).not.toContain('(');expect(plainText(none)).not.toContain('cached');
 // Too narrow for even the number: totals only, never clipped mid-value.
 const huge=view(130,usage({tokens:999900,cachedTokens:999800},{tokens:999900,cachedTokens:999800}));expect(tokensRow(huge)).not.toContain('(');expect(tokensRow(huge)).toContain('999.9K');
 // The 100-column layout uses the stacked narrow panel: totals stay, nothing overflows the box.
 const narrow=view(100,usage({cachedTokens:71000},{cachedTokens:71000}));expect(plainText(narrow)).toContain('≈ today $0.16 80.8K');
});
