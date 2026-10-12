import {expect,it} from 'vitest';
import {trimPrices,estimateCost} from '../src/daemon/usage-prices.js';
it('trims price catalog to supported providers and computes cached input separately',()=>{
 const trimmed=trimPrices({openai:{models:{test:{cost:{input:2,output:10,cache_read:0.2},private:'ignored'}}},anthropic:{models:{}},azure:{models:{test:{cost:{input:2,output:10}}}},other:{models:{}}},'2026-10-12');expect(Object.keys(trimmed.providers)).toEqual(['anthropic','openai','azure']);expect(trimmed.providers.openai.test).toEqual({input:2,output:10,cacheRead:0.2});expect(JSON.stringify(trimmed)).not.toContain('private');
 expect(estimateCost({input:2,output:10,cacheRead:0.2},1000,100,500)).toBeCloseTo(0.0021);expect(estimateCost(undefined,1000,100,0)).toBeNull();expect(estimateCost({input:2,output:10},1000,100,500)).toBeNull();
});
