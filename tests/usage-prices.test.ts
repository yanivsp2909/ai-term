import {expect,it} from 'vitest';
import {trimPrices,estimateCost,findPrice} from '../src/daemon/usage-prices.js';
it('trims price catalog to supported providers and computes cached input separately',()=>{
 const trimmed=trimPrices({openai:{models:{test:{cost:{input:2,output:10,cache_read:0.2},private:'ignored'}}},anthropic:{models:{}},azure:{models:{test:{cost:{input:2,output:10}}}},other:{models:{}}},'2026-10-12');expect(Object.keys(trimmed.providers)).toEqual(['anthropic','openai','azure']);expect(trimmed.providers.openai.test).toEqual({input:2,output:10,cacheRead:0.2});expect(JSON.stringify(trimmed)).not.toContain('private');
 expect(estimateCost({input:2,output:10,cacheRead:0.2},1000,100,500)).toBeCloseTo(0.0021,8);expect(estimateCost(undefined,1000,100,0)).toBeNull();expect(estimateCost({input:2,output:10},1000,100,500)).toBeCloseTo((1000*2+100*10)/1e6,12);
});
it('an explicit input/output Foundry override prices all input tokens unless a cache price is specified',()=>{const snapshot=trimPrices({},'2026-10-12');const price=findPrice(snapshot,'foundry','custom-deployment',{'custom-deployment':{input:2,output:10}});expect(estimateCost(price,1000,100,500)).toBeCloseTo(0.003,8);});
it('prototype property names are unknown models, never inherited prices',()=>{const snapshot=trimPrices({},'2026-10-12');for(const provider of ['anthropic','openai','foundry']as const)for(const model of ['constructor','toString','__proto__'])expect(estimateCost(findPrice(snapshot,provider,model,{}),10,1)).toBeNull();});
