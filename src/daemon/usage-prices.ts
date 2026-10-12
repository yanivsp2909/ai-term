import type {KeyProvider,ModelPrice} from '../shared/protocol.js';
export interface PriceSnapshot {fetchedAt:string;providers:Record<'anthropic'|'openai'|'azure',Record<string,ModelPrice>>}
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
export function trimPrices(raw:unknown,fetchedAt:string):PriceSnapshot{
 const providers:PriceSnapshot['providers']={anthropic:{},openai:{},azure:{}};
 for(const provider of Object.keys(providers)as(keyof typeof providers)[]){const models=object(object(object(raw)[provider]).models);for(const [id,rawModel]of Object.entries(models)){const cost=object(object(rawModel).cost);const input=cost.input,output=cost.output,cacheRead=cost.cache_read;if(typeof input==='number'&&Number.isFinite(input)&&input>=0&&typeof output==='number'&&Number.isFinite(output)&&output>=0)providers[provider][id]={input,output,...(typeof cacheRead==='number'&&Number.isFinite(cacheRead)&&cacheRead>=0?{cacheRead}:{})};}}
 return {fetchedAt,providers};
}
export function estimateCost(price:ModelPrice|undefined,input:number,output:number,cached=0):number|null{
 if(!price||cached>0&&price.cacheRead===undefined)return null;
 return ((input-cached)*price.input+output*price.output+cached*(price.cacheRead??0))/1e6;
}
export function findPrice(snapshot:PriceSnapshot,provider:KeyProvider,model:string,overrides:Record<string,ModelPrice>):ModelPrice|undefined{
 return provider==='foundry'?overrides[model]??snapshot.providers.azure[model]??snapshot.providers.openai[model]:snapshot.providers[provider][model];
}
