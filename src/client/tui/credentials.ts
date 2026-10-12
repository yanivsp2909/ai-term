import type { AgentEngine, KeyProvider, KeyView, EnginesStatus, ThemeName, SuccessResponse, Settings } from '../../shared/protocol.js';
import { ownLoginLabel } from '../../shared/models.js';
import type { RequestBody } from '../connection.js';
import { isEndpoint, isValidModelId } from '../../shared/validate.js';
import { Grid, type Frame } from './grid.js';
import type { Theme } from './theme.js';
interface Actions {
 request(body:RequestBody):Promise<SuccessResponse>;changed():void;close():void;
 login(engine:AgentEngine):Promise<void>;defaults(kind:'model'|'folder'|'effort'):void;price?():void;theme(theme:ThemeName):Promise<void>;
}
const providers:readonly [string,KeyProvider][]=[['Anthropic','anthropic'],['OpenAI','openai'],['Microsoft Foundry','foundry']];
const themes:ThemeName[]=['graphite','slate','ink','auto','light'];
export class CredentialsPanel {
 private screen:'providers'|'method'|'form'|'settings'|'import'|'names'|'result';
 private choice=0;private row=0;private provider:KeyProvider='anthropic';private keys:KeyView[]=[];private engines?:EnginesStatus;private settings?:Settings;
 private label='';private endpoint='';private deployments='';private secret='';private path='';private names:{name:string;provider:KeyProvider}[]=[];private selected=new Set<string>();private message='';private busy=false;private disposed=false;
 constructor(kind:'login'|'settings',private readonly actions:Actions){this.screen=kind==='login'?'providers':'settings';}
 containsSecret():boolean{return this.secret.length>0;}
 dispose():void{this.secret='';this.disposed=true;}
 async load():Promise<void>{this.busy=true;this.actions.changed();try{this.keys=(await this.actions.request({kind:'keys.list'})).keys??[];this.engines=(await this.actions.request({kind:'engines.status'})).engines;this.settings=(await this.actions.request({kind:'settings.get'})).settings;}catch{this.message='Credentials status unavailable';}finally{this.busy=false;this.actions.changed();}}
 private fieldNames():string[]{return this.provider==='foundry'?['label','endpoint','secret','deployments']:['label','secret'];}
 private field():string{return this.screen==='import'?'path':this.fieldNames()[this.row]??'label';}
 paste(text:string):void{if(this.busy||this.disposed)return;const field=this.field();if(this.screen!=='form'&&this.screen!=='import')return;
  const safe=text.replace(/[\r\n]/g,'');if(field==='secret'){if(this.secret.length+safe.length>512){this.secret='';this.message='Key is too long; enter at most 512 characters';this.actions.changed();return;}this.secret+=safe;}
  else if(field==='path')this.path=(this.path+safe).slice(0,4096);else if(field==='label')this.label=(this.label+safe).slice(0,60);else if(field==='endpoint')this.endpoint=(this.endpoint+safe).slice(0,2048);else this.deployments=(this.deployments+safe).slice(0,3200);
  this.message='';this.actions.changed();
 }
 private backspace():void{const f=this.field();if(f==='secret')this.secret=this.secret.slice(0,-1);else if(f==='path')this.path=this.path.slice(0,-1);else if(f==='label')this.label=this.label.slice(0,-1);else if(f==='endpoint')this.endpoint=this.endpoint.slice(0,-1);else this.deployments=this.deployments.slice(0,-1);}
 private form(provider:KeyProvider):void{this.provider=provider;this.screen='form';this.row=0;this.label=provider==='foundry'?'Foundry':provider==='openai'?'OpenAI':'Anthropic';this.endpoint='';this.deployments='';this.secret='';this.message='';}
 async key(key:string):Promise<void>{
  if(this.disposed)return;
  if(key==='escape'){this.secret='';this.actions.close();return;}if(this.busy)return;
  if(key==='up'||key==='down'){const delta=key==='up'?-1:1;if(this.screen==='form')this.row=Math.max(0,Math.min(this.fieldNames().length-1,this.row+delta));else this.choice=Math.max(0,Math.min((this.screen==='settings'?this.keys.length+8:this.screen==='names'?this.names.length:this.screen==='providers'?3:2)-1,this.choice+delta));this.actions.changed();return;}
  if(key==='backspace'&&(this.screen==='form'||this.screen==='import')){this.backspace();this.actions.changed();return;}
  if(this.screen==='providers'&&key==='enter'){this.provider=providers[this.choice]?.[1]??'anthropic';this.choice=0;if(this.provider==='foundry')this.form('foundry');else this.screen='method';this.actions.changed();return;}
  if(this.screen==='method'&&key==='enter'){if(this.choice===0){this.busy=true;this.actions.changed();try{await this.actions.login(this.provider==='anthropic'?'claude-code':'codex');this.actions.close();}catch{this.message='Login could not start';}finally{this.busy=false;this.actions.changed();}}else this.form(this.provider);this.actions.changed();return;}
  if(this.screen==='form'&&key==='enter'){if(this.row<this.fieldNames().length-1){this.row++;this.actions.changed();return;}await this.save();return;}
  if(this.screen==='settings'){
   if(key==='enter'&&this.choice>=this.keys.length){const action=['a','i','l','d','f','tab','p','e'][this.choice-this.keys.length];if(action)await this.key(action);return;}
   if(key==='a'||key==='+'){this.screen='providers';this.choice=0;this.actions.changed();return;}
   if(key==='i'){this.screen='import';this.path='';this.message='';this.actions.changed();return;}
   if(key==='l'){this.screen='providers';this.choice=0;this.actions.changed();return;}
   if(key==='p'){this.actions.price?.();return;}
   if(key==='d'||key==='f'||key==='e'){this.actions.defaults(key==='d'?'model':key==='e'?'effort':'folder');return;}
   if(key==='tab'){this.busy=true;try{const settings=(await this.actions.request({kind:'settings.get'})).settings;const index=themes.indexOf(settings?.theme??'graphite');await this.actions.theme(themes[(index+1)%themes.length]??'graphite');this.message='Theme saved';}catch{this.message='Theme could not be saved';}finally{this.busy=false;this.actions.changed();}return;}
   const selected=this.keys[this.choice];if(selected&&(key==='x'||key==='t'||key==='enter')){this.busy=true;try{if(key==='x'){await this.actions.request({kind:'keys.remove',keyId:selected.id});this.message='Key removed from the OS keychain';}else{const r=await this.actions.request({kind:'keys.test',keyId:selected.id});this.message=(r.results??[]).map(r=>`${r.model}: ${r.status}${r.httpStatus?' '+r.httpStatus:''}${r.errorCode?' '+r.errorCode:''}`).join(' · ');}this.keys=(await this.actions.request({kind:'keys.list'})).keys??[];}catch{this.message='Key operation failed';}finally{this.busy=false;this.actions.changed();}return;}
  }
  if(this.screen==='import'&&key==='enter'){this.busy=true;try{this.names=(await this.actions.request({kind:'keys.scanEnvFile',path:this.path})).found??[];this.selected=new Set(this.names.map(n=>n.name));this.screen='names';this.choice=0;this.message='';}catch{this.message='Env file could not be scanned';}finally{this.busy=false;this.actions.changed();}return;}
  if(this.screen==='names'&&key===' '){const name=this.names[this.choice]?.name;if(name){if(this.selected.has(name))this.selected.delete(name);else this.selected.add(name);}this.actions.changed();return;}
  if(this.screen==='names'&&key==='enter'){this.busy=true;try{const result=await this.actions.request({kind:'keys.importEnv',path:this.path,names:[...this.selected]});this.keys=result.keys??[];this.screen='result';this.message='✓ saved to the OS keychain · consider deleting the source .env file';}catch{this.message='Import failed; Foundry needs endpoint/deployment fields in the file';}finally{this.busy=false;this.actions.changed();}return;}
  if((this.screen==='form'||this.screen==='import')&&[...key].length===1)this.paste(key);
 }
 private async save():Promise<void>{
  const deployments=this.deployments.split(',').map(d=>d.trim()).filter(Boolean);
  if(!this.secret||/\s/.test(this.secret)||this.provider==='foundry'&&(!isEndpoint(this.endpoint)||!deployments.length||deployments.some(m=>!isValidModelId(m)))){this.message='Enter a key and valid endpoint/deployments';this.actions.changed();return;}
  const body:Extract<RequestBody,{kind:'keys.add'}>={kind:'keys.add',provider:this.provider,label:this.label,secret:this.secret,...(this.provider==='foundry'?{endpoint:this.endpoint,deployments}: {})};
  this.secret='';this.busy=true;this.actions.changed();
  try{const pending=this.actions.request(body);body.secret='';const result=await pending;this.screen='result';this.message='✓ saved to the OS keychain';if(result.key){this.keys=[result.key];if(result.key.provider==='foundry'){const test=await this.actions.request({kind:'keys.test',keyId:result.key.id});this.message+=' · '+(test.results??[]).map(r=>`${r.model}: ${r.status}`).join(' · ');this.keys=(await this.actions.request({kind:'keys.list'})).keys??[];}}}
  catch{this.message='Key could not be saved or tested; check OS keychain access';}finally{this.busy=false;this.actions.changed();}
 }
 lines():string[]{
  const lines:string[]=[];
  if(this.screen==='providers')lines.push('Connect a provider',...providers.map(([label],i)=>`${i===this.choice?'›':' '} ${label}`));
  if(this.screen==='method')lines.push(providers.find(p=>p[1]===this.provider)?.[0]??'',`${this.choice===0?'›':' '} ${this.provider==='anthropic'?'Claude Code':'Codex'} · ${ownLoginLabel(this.provider==='anthropic'?this.engines?.claudeCode.authMethod:this.engines?.codex.authMethod)} · official CLI login`,`${this.choice===1?'›':' '} API key · OS keychain`,'What happens: the CLI owns login; AI Term never reads its credentials');
  if(this.screen==='form'){lines.push('Add API key');for(const [i,name]of this.fieldNames().entries()){const value=name==='secret'?'•'.repeat(this.secret.length):name==='label'?this.label:name==='endpoint'?this.endpoint:this.deployments;lines.push(`${i===this.row?'›':' '} ${name}: ${value}`);}lines.push('↑↓ fields · ⏎ next/save · key is masked');}
  if(this.screen==='settings'){
   const action=(index:number,text:string)=>`${this.choice===this.keys.length+index?'›':' '} ${text}`;
   lines.push('KEYS · OS keychain');
   const keyStart=Math.max(0,Math.min(this.choice,this.keys.length-1)-2);
   for(const [offset,k]of this.keys.slice(keyStart,keyStart+5).entries())lines.push(`${keyStart+offset===this.choice?'›':' '} ${k.label} · ${k.provider} · key ····${k.last4}${k.endpoint?' · '+k.endpoint:''}`);
   lines.push(action(0,'+ add key (a)'),action(1,'import from .env (i)'),action(2,'login (l)'),'ENGINES');
   for(const [name,status]of [['Claude Code',this.engines?.claudeCode],['Codex',this.engines?.codex]] as const)lines.push(`${name}: ${status?.installed?'✓ installed':'✗ not installed'} · ${status?.loggedIn?'✓ logged in':'✗ not logged in · /login'} · ${ownLoginLabel(status?.authMethod)}`);
   lines.push('DEFAULTS',action(3,`model: ${this.settings?.defaultModel??'CLI default'} · ${this.settings?.defaultEngine??'claude-code'} (d)`),action(4,`folder: ${this.settings?.defaultCwd??'launch folder'} (f)`),action(5,`permission: ask only · theme: ${this.settings?.theme??'graphite'} · ⇥ change`),action(6,'Foundry input/output price per 1M · p override'),action(7,`effort: ${this.settings?.defaultEffort??'CLI default'} (e)`),'keys are never shown in full and never written to .env');
  }
  if(this.screen==='import')lines.push('Import from .env',`path: ${this.path}█`,'Names only are shown; source file is never modified');
  if(this.screen==='names')lines.push('Select names to import',...this.names.map((n,i)=>`${i===this.choice?'›':' '} [${this.selected.has(n.name)?'x':' '}] ${n.name} · ${n.provider}`),'↑↓ select · Space toggle · ⏎ import');
  if(this.screen==='result')lines.push('Keys',...this.keys.map(k=>`${k.label} · key ····${k.last4}`),...this.keys.flatMap(k=>(k.lastTest??[]).map(r=>`${r.model} · ${r.status}`)));
  if(this.message)lines.push(this.message);if(this.busy)lines.push('◐ working');lines.push('Esc back');return lines;
 }
 draw(frame:Frame,theme:Theme):Frame{
  const rows=frame.length,cols=frame[0]?.length??0,grid=new Grid(cols,rows,theme),lines=this.lines();
  for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){const cell=frame[y]?.[x];if(cell)grid.put(x,y,cell);}
  const w=Math.min(cols,110),h=Math.min(rows-2,Math.max(8,lines.length+2)),x=Math.floor((cols-w)/2),y=Math.max(1,rows-4-h);grid.box(x,y,w,h,this.screen==='settings'?'Settings':'Login',theme.colors.surface);
  lines.slice(0,h-2).forEach((line,i)=>grid.text(x+3,y+i+1,line,theme.colors['ink-2'],theme.colors.surface,false,w-6));return grid.cells;
 }
}
