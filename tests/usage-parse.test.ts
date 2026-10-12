import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {UsageParser} from '../src/daemon/usage-parse.js';
const context={sessionId:randomUUID(),provider:'anthropic' as const,engine:'claude-code' as const,model:'sonnet'};
const metric=(name:string,type:string,value:unknown,time='2',temporality=1)=>({resourceMetrics:[{resource:{attributes:[{key:'user.email',value:{stringValue:'fake@example.com'}}]},scopeMetrics:[{metrics:[{name,sum:{aggregationTemporality:temporality,dataPoints:[{attributes:[{key:'type',value:{stringValue:type}},{key:'model',value:{stringValue:'sonnet'}},{key:'user.email',value:{stringValue:'AITERMCANARY fake@example.com'}}],asInt:value,startTimeUnixNano:'1',timeUnixNano:time}]}}]}]}]});
it('Claude allowlist numeric strings delta dedupe and cumulative reset',()=>{
 const diagnostics:unknown[]=[];const p=new UsageParser((d)=>diagnostics.push(d));
 const parse=(raw:unknown)=>p.parse('/v1/metrics',raw,context);
 expect(parse(metric('claude_code.token.usage','input','100'))[0]).toMatchObject({inputTokens:100,outputTokens:0,sessionId:context.sessionId,costSource:'cli-estimate'});
 expect(parse(metric('claude_code.token.usage','input','100'))).toEqual([]);
 expect(parse(metric('unknown','input','100','3'))).toEqual([]);
 expect(parse(metric('claude_code.token.usage','input','NaN','3'))).toEqual([]);
 expect(parse(metric('claude_code.token.usage','input','150','4',2))[0]?.inputTokens).toBe(150);
 expect(parse(metric('claude_code.token.usage','input','180','5',2))[0]?.inputTokens).toBe(30);
 expect(parse(metric('claude_code.token.usage','input','10','6',2))[0]?.inputTokens).toBe(10);
 const cost=metric('claude_code.cost.usage','cost',undefined,'7');const point=cost.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0];delete point.asInt;Object.assign(point,{asDouble:0.12});expect(parse(cost)[0]?.costUsd).toBe(0.12);
 expect(JSON.stringify(diagnostics)).not.toMatch(/AITERMCANARY|fake@example/);
});
it('Codex only accepts response.completed token fields and ignores private record bodies/attributes',()=>{
 const p=new UsageParser(()=>{}),codex={...context,engine:'codex' as const,provider:'openai' as const,model:'test'};
 const attributes=[{key:'event.name',value:{stringValue:'codex.sse_event'}},{key:'event.kind',value:{stringValue:'response.completed'}},{key:'input_token_count',value:{stringValue:'1000'}},{key:'output_token_count',value:{intValue:'100'}},{key:'cached_token_count',value:{intValue:'500'}},{key:'reasoning_token_count',value:{intValue:'10'}},{key:'user.email',value:{stringValue:'fake@example.com AITERMCANARY'}}];
 const raw={resourceLogs:[{scopeLogs:[{logRecords:[{timeUnixNano:'10',attributes,body:{stringValue:'PRIVATE'}},{timeUnixNano:'11',attributes:[{key:'event.name',value:{stringValue:'codex.tool_output'}},{key:'content',value:{stringValue:'AITERMCANARY'}}]}]}]}]};
 const records=p.parse('/v1/logs',raw,codex);expect(records).toHaveLength(1);expect(records[0]).toMatchObject({model:'test',inputTokens:1000,outputTokens:100,cachedTokens:500,costUsd:null,costSource:'price-table'});expect(JSON.stringify(records)).not.toMatch(/PRIVATE|AITERMCANARY|email/);expect(p.parse('/v1/logs',raw,codex)).toEqual([]);
});
