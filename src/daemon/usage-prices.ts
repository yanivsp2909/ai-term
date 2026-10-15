import type {KeyProvider,ModelPrice,Settings} from '../shared/protocol.js';
export interface ModelLimits {context?:number;output?:number}
// limits (v0.4.2): Models.dev's limit.context and limit.output per model, kept when the catalog is refreshed; absent in a
// catalog trimmed before then, which leaves context % and output limits unknown rather than guessed.
export interface PriceSnapshot {fetchedAt:string;providers:Record<'anthropic'|'openai'|'azure',Record<string,ModelPrice>>;limits?:Partial<Record<'anthropic'|'openai'|'azure',Record<string,ModelLimits>>>}
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
export function trimPrices(raw:unknown,fetchedAt:string):PriceSnapshot{
 const providers:PriceSnapshot['providers']={anthropic:{},openai:{},azure:{}};
 const limits:NonNullable<PriceSnapshot['limits']>={anthropic:{},openai:{},azure:{}};
 const count=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=100_000_000?v:undefined;
 for(const provider of Object.keys(providers)as(keyof typeof providers)[]){const models=object(object(object(raw)[provider]).models);for(const [id,rawModel]of Object.entries(models)){const cost=object(object(rawModel).cost);const input=cost.input,output=cost.output,cacheRead=cost.cache_read;if(typeof input==='number'&&Number.isFinite(input)&&input>=0&&typeof output==='number'&&Number.isFinite(output)&&output>=0)providers[provider][id]={input,output,...(typeof cacheRead==='number'&&Number.isFinite(cacheRead)&&cacheRead>=0?{cacheRead}:{})};
  const limit=object(object(rawModel).limit),context=count(limit.context),out=count(limit.output);if(providers[provider][id]&&(context||out)){const table=limits[provider]??{};table[id]={...(context?{context}:{}),...(out?{output:out}:{})};limits[provider]=table;}}}
 return {fetchedAt,providers,limits};
}
// A price with no cache-read rate charges cached input at the input rate: an upper bound, so budgets and caps (D49) count
// every token instead of losing cache hits to an unknown price (v0.4.2 review).
export function estimateCost(price:ModelPrice|undefined,input:number,output:number,cached=0):number|null{
 if(!price)return null;
 return ((input-cached)*price.input+output*price.output+cached*(price.cacheRead??price.input))/1e6;
}
// alias: the catalog model a Foundry deployment was marked as in /settings ("this is model X"); a price override for the
// deployment itself still wins.
export function findPrice(snapshot:PriceSnapshot,provider:KeyProvider,model:string,overrides:Record<string,ModelPrice>,alias?:string):ModelPrice|undefined{
 const own=(table:Record<string,ModelPrice>,id=model)=>Object.hasOwn(table,id)?table[id]:undefined;
 // Ollama runs on this Mac: nothing to bill, so budgets never pause it (v0.6.5).
 if(provider==='ollama')return {input:0,output:0,cacheRead:0};
 const override=own(overrides);
 // An explicit two-rate override applies its input rate to every input token; no cache discount is guessed.
 const overridden=override?{...override,cacheRead:override.cacheRead??override.input}:undefined;
 if(provider==='anthropic'||provider==='openai')return own(snapshot.providers[provider]);
 // v0.6.5 providers have no catalog prices: their override (/settings p) or unknown (`price ?`).
 if(provider!=='foundry')return overridden;
 if(!override&&alias)return own(snapshot.providers.azure,alias)??own(snapshot.providers.openai,alias)??own(snapshot.providers.anthropic,alias);
 return overridden??own(snapshot.providers.azure)??own(snapshot.providers.openai);
}

// The catalog model a Foundry deployment was marked as: own keys only, so a deployment named toString has no alias.
export function deploymentAlias(settings:Pick<Settings,'deploymentModels'>,deployment:string):string|undefined{const map=settings.deploymentModels;return map&&Object.hasOwn(map,deployment)?map[deployment]:undefined;}
export function findLimits(snapshot:PriceSnapshot,provider:KeyProvider,model:string,alias?:string):ModelLimits{
 const id=provider==='foundry'?alias??model:model,tables=provider==='foundry'?(['azure','openai','anthropic']as const):provider==='anthropic'||provider==='openai'?[provider]:[];
 for(const table of tables){const entry=snapshot.limits?.[table];if(entry&&Object.hasOwn(entry,id))return {...entry[id]};}
 return {};
}
