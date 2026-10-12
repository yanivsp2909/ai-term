import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {validateRequest,validateSuccess,validateUsageSummary} from '../src/shared/validate.js';
const id=randomUUID();
const period={costUsd:0,tokens:0,unknownPrice:false,providers:[]};
it('usage subscription summary and diagnostics carry only bounded metadata and numbers',async()=>{
 for(const kind of ['usage.summary','usage.diagnostics'])expect(await validateRequest({id,kind})).toMatchObject({kind});expect(await validateRequest({id,kind:'usage.subscribe',on:true})).toMatchObject({on:true});
 const usage={today:period,week:period,month:period};expect(validateUsageSummary(usage)).toEqual(usage);expect(()=>validateSuccess({id,ok:true,usage})).not.toThrow();
 expect(()=>validateUsageSummary({...usage,today:{...period,credential:'private'}})).toThrow();expect(()=>validateUsageSummary({...usage,month:{...period,costUsd:-1}})).toThrow();
 await expect(validateRequest({id,kind:'usage.subscribe',on:'yes'})).rejects.toThrow();
});
it('budget and deployment price patches validate amounts and never save dontAsk',async()=>{
 expect(await validateRequest({id,kind:'settings.set',patch:{budgets:{daily:10,weekly:null,monthly:50},priceOverrides:{'gpt-6.1-sol':{input:2,output:10}}}})).toMatchObject({patch:{budgets:{daily:10}}});
 for(const patch of [{budgets:{daily:-1}},{budgets:{daily:'10'}},{priceOverrides:{model:{input:Infinity,output:1}}},{priceOverrides:{'-bad':{input:1,output:2}}}])await expect(validateRequest({id,kind:'settings.set',patch})).rejects.toThrow();
});
it('debug attributes reject arbitrary names even when their values are numeric',()=>{
 const usageDiagnostics={port:1234,sessions:[{sessionId:id,at:new Date().toISOString(),values:[{name:'AITERMCANARY',value:123}]}]};
 expect(()=>validateSuccess({id,ok:true,usageDiagnostics})).toThrow();
});
