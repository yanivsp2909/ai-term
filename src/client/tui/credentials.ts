import type { AgentEngine, DeploymentTest, KeyProvider, KeyView, EnginesStatus, ThemeName, SuccessResponse, Settings, NotifierState,NotificationAuthorization } from '../../shared/protocol.js';
import { OLLAMA_DEFAULT_ENDPOINT, PROVIDER_LABELS, bedrockEndpoint, isDirectProvider, isLocalEndpoint } from '../../shared/providers.js';
import { ownLoginLabel } from '../../shared/models.js';
import { catalogIds } from '../../shared/model-catalog.js';
import { DEFAULT_AGENT_CAPS, type AgentCaps } from '../../shared/agent-facts.js';
import { DaemonRequestError, type RequestBody } from '../connection.js';
import { isEndpoint, isValidModelId } from '../../shared/validate.js';
import { Grid, type Frame } from './grid.js';
import type { Theme } from './theme.js';
interface Actions {
 request(body:RequestBody):Promise<SuccessResponse>;changed():void;close():void;
 login(engine:AgentEngine):Promise<void>;defaults(kind:'model'|'folder'|'effort'):void;price?(settings:Settings|undefined,keys:readonly KeyView[]):void;caps?(current:AgentCaps|undefined):void;theme(theme:ThemeName):Promise<void>;
}
// v0.6.5 adds the providers only AI Term's agent can use (no CLI login exists for them) and Ollama on this Mac.
const providerOrder:readonly KeyProvider[]=['anthropic','openai','foundry','xai','moonshot','zai','openrouter','bedrock','vertex','ollama'];
const providers:readonly [string,KeyProvider][]=providerOrder.map(p=>[PROVIDER_LABELS[p],p]);
const DEFAULT_LABELS:Partial<Record<KeyProvider,string>>={foundry:'Foundry',bedrock:'Bedrock',vertex:'Vertex'};
// One line per tested model: status, then the HTTP status or a fixed reason (never the provider's text).
const testText=(results:readonly DeploymentTest[])=>results.map(r=>`${r.model}: ${r.status}${r.httpStatus?' '+r.httpStatus:''}${r.errorCode?' '+r.errorCode:''}${r.reason?' · '+r.reason:''}`).join(' · ');
const themes:ThemeName[]=['graphite','slate','ink','auto','light'];
// The daemon answers with fixed texts only (KeyError or a generic fallback), so its reason is safe to show and says what to do.
const reason=(error:unknown,fallback:string)=>error instanceof DaemonRequestError?error.message:fallback;
export class CredentialsPanel {
 private screen:'providers'|'method'|'form'|'settings'|'import'|'names'|'result'|'deployments'|'catalog';
 // "This deployment is model X" (v0.4.2): the Foundry key and deployment being marked, and the catalog filter.
 private mapping:{key:KeyView;deployment:string;filter:string}|null=null;
 private choice=0;private row=0;private provider:KeyProvider='anthropic';private keys:KeyView[]=[];private engines?:EnginesStatus;private notifier?:NotifierState;private notificationPermission:NotificationAuthorization='unknown';private settings?:Settings;
 private label='';private endpoint='';private deployments='';private secret='';private path='';private names:{name:string;provider:KeyProvider}[]=[];private selected=new Set<string>();private message='';private busy=false;private disposed=false;
 constructor(kind:'login'|'settings',private readonly actions:Actions){this.screen=kind==='login'?'providers':'settings';}
 containsSecret():boolean{return this.secret.length>0;}
 dispose():void{this.secret='';this.disposed=true;}
 async load():Promise<void>{this.busy=true;this.actions.changed();
  // Independent requests: one failing must not blank the others or show engines as missing.
  const failures:string[]=[];
  try{this.keys=(await this.actions.request({kind:'keys.list'})).keys??[];}catch(error){failures.push(reason(error,'Keys unavailable'));}
  try{const status=await this.actions.request({kind:'engines.status'});this.engines=status.engines;this.notifier=status.notifier;}catch(error){failures.push(reason(error,'Engine status unavailable'));}
  try{const result=await this.actions.request({kind:'settings.get',refreshNotifications:true});this.settings=result.settings;this.notificationPermission=result.notificationPermission??'unknown';}catch(error){failures.push(reason(error,'Settings unavailable'));}
  this.message=failures.join(' · ');this.busy=false;this.actions.changed();}
 private capsText():string{const caps=this.settings?.agentCaps??DEFAULT_AGENT_CAPS;return `${caps.turns===null?'no turn cap':`${caps.turns} turns`} · ${caps.spendUsd===null?'no spend cap':`$${caps.spendUsd.toFixed(2)}`}`;}
 // With a filter typed, the first match is selected, so ⏎ right after typing picks it rather than clearing the mapping.
 private filteredChoice():number{return this.mapping?.filter&&this.catalogRows().length>1?1:0;}
 private catalogRows():string[]{const filter=this.mapping?.filter.toLowerCase()??'';return ['(not set)',...catalogIds().filter(id=>id.toLowerCase().includes(filter))];}
 private async saveMapping(choice:string|undefined):Promise<void>{
  const mapping=this.mapping;if(!mapping||!choice)return;
  const current={...this.settings?.deploymentModels};if(choice==='(not set)')delete current[mapping.deployment];else current[mapping.deployment]=choice;
  this.busy=true;
  try{this.settings=(await this.actions.request({kind:'settings.set',patch:{deploymentModels:current}})).settings;this.message=choice==='(not set)'?`${mapping.deployment}: model not set`:`${mapping.deployment} is ${choice}`;this.screen='settings';this.mapping=null;this.choice=0;}
  catch(error){this.message=reason(error,'Deployment model could not be saved');}
  finally{this.busy=false;this.actions.changed();}
 }
 // region (Bedrock) and endpoint share one value; models (v0.6.5 providers) and deployments (Foundry) share another.
 private fieldNames():string[]{const p=this.provider;return p==='foundry'?['label','endpoint','secret','deployments']:p==='bedrock'?['label','region','secret','models']:p==='ollama'?['label','endpoint']:isDirectProvider(p)?['label','secret','models']:['label','secret'];}
 private field():string{return this.screen==='import'?'path':this.fieldNames()[this.row]??'label';}
 paste(text:string):void{if(this.busy||this.disposed)return;const field=this.field();if(this.screen!=='form'&&this.screen!=='import')return;
  const safe=text.replace(/[\r\n]/g,'');if(field==='secret'){if(this.secret.length+safe.length>512){this.secret='';this.message='Key is too long; enter at most 512 characters';this.actions.changed();return;}this.secret+=safe;}
  else if(field==='path')this.path=(this.path+safe).slice(0,4096);else if(field==='label')this.label=(this.label+safe).slice(0,60);else if(field==='endpoint'||field==='region')this.endpoint=(this.endpoint+safe).slice(0,2048);else this.deployments=(this.deployments+safe).slice(0,3200);
  this.message='';this.actions.changed();
 }
 private backspace():void{const f=this.field();if(f==='secret')this.secret=this.secret.slice(0,-1);else if(f==='path')this.path=this.path.slice(0,-1);else if(f==='label')this.label=this.label.slice(0,-1);else if(f==='endpoint'||f==='region')this.endpoint=this.endpoint.slice(0,-1);else this.deployments=this.deployments.slice(0,-1);}
 private form(provider:KeyProvider):void{this.provider=provider;this.screen='form';this.row=0;this.label=DEFAULT_LABELS[provider]??PROVIDER_LABELS[provider];this.endpoint=provider==='ollama'?OLLAMA_DEFAULT_ENDPOINT:'';this.deployments='';this.secret='';this.message='';}
 async key(key:string):Promise<void>{
  if(this.disposed)return;
  if(key==='escape'){this.secret='';this.actions.close();return;}if(this.busy)return;
  if(key==='up'||key==='down'){const delta=key==='up'?-1:1;if(this.screen==='form')this.row=Math.max(0,Math.min(this.fieldNames().length-1,this.row+delta));else this.choice=Math.max(0,Math.min((this.screen==='settings'?this.keys.length+21:this.screen==='deployments'?this.mapping?.key.deployments?.length??0:this.screen==='catalog'?this.catalogRows().length:this.screen==='names'?this.names.length:this.screen==='providers'?providers.length:2)-1,this.choice+delta));this.actions.changed();return;}
  if(key==='backspace'&&(this.screen==='form'||this.screen==='import')){this.backspace();this.actions.changed();return;}
  if(this.screen==='providers'&&key==='enter'){this.provider=providers[this.choice]?.[1]??'anthropic';this.choice=0;if(this.provider==='anthropic'||this.provider==='openai')this.screen='method';else this.form(this.provider);this.actions.changed();return;}
  if(this.screen==='method'&&key==='enter'){if(this.choice===0){this.busy=true;this.actions.changed();try{await this.actions.login(this.provider==='anthropic'?'claude-code':'codex');this.actions.close();}catch(error){this.message=reason(error,'Login could not start');}finally{this.busy=false;this.actions.changed();}}else this.form(this.provider);this.actions.changed();return;}
  if(this.screen==='deployments'&&key==='enter'&&this.mapping){this.mapping={...this.mapping,deployment:this.mapping.key.deployments?.[this.choice]??''};this.screen='catalog';this.choice=0;this.actions.changed();return;}
  if(this.screen==='catalog'&&this.mapping){
   if(key==='backspace'){this.mapping={...this.mapping,filter:[...this.mapping.filter].slice(0,-1).join('')};this.choice=this.filteredChoice();this.actions.changed();return;}
   if(key==='enter'){await this.saveMapping(this.catalogRows()[this.choice]);return;}
   // Typing narrows the list; the saved value is always a catalog entry, never the typed text.
   if([...key].length===1&&/[A-Za-z0-9._:-]/.test(key)){this.mapping={...this.mapping,filter:(this.mapping.filter+key).slice(0,40)};this.choice=this.filteredChoice();this.actions.changed();return;}
   return;
  }
  if(this.screen==='form'&&key==='enter'){if(this.row<this.fieldNames().length-1){this.row++;this.actions.changed();return;}await this.save();return;}
  if(this.screen==='settings'){
   if(key==='enter'&&this.choice>=this.keys.length){const action=['a','i','l','d','f','tab','e','p','n','h','w','r','c','k','o','s','g','u','v','j','q'][this.choice-this.keys.length];if(action)await this.key(action);return;}
   if(key==='a'||key==='+'){this.screen='providers';this.choice=0;this.actions.changed();return;}
   if(key==='i'){this.screen='import';this.path='';this.message='';this.actions.changed();return;}
   if(key==='l'){this.screen='providers';this.choice=0;this.actions.changed();return;}
   if(key==='p'){this.actions.price?.(this.settings,this.keys);return;}
   if(key==='w'){this.busy=true;try{this.settings=(await this.actions.request({kind:'settings.set',patch:{worktrees:this.settings?.worktrees==='off'?'on':'off'}})).settings;this.message='';}catch{this.message='Worktrees setting could not be saved';}finally{this.busy=false;this.actions.changed();}return;}
   // D47's fallback: Foundry keys start AI Term's agent unless this says the CLI (Codex); accounts never change.
   if(key==='r'){this.busy=true;try{this.settings=(await this.actions.request({kind:'settings.set',patch:{keysRunOn:this.settings?.keysRunOn==='cli'?'ai-term':'cli'}})).settings;this.message='';}catch{this.message='Keys setting could not be saved';}finally{this.busy=false;this.actions.changed();}return;}
   if(key==='c'){this.actions.caps?.(this.settings?.agentCaps);return;}
   // D55: the 85% context warning has its own switch, on by default.
   if(key==='k'){this.busy=true;try{this.settings=(await this.actions.request({kind:'settings.set',patch:{contextWarning:this.settings?.contextWarning===false}})).settings;this.message='';}catch{this.message='Context warning setting could not be saved';}finally{this.busy=false;this.actions.changed();}return;}
   // D55: cost per task (v0.6.1) has its own switch, on by default; off also stops asking new subscription sessions for their tokens (running ones keep reporting until they exit).
   if(key==='o'){this.busy=true;try{this.settings=(await this.actions.request({kind:'settings.set',patch:{taskCost:this.settings?.taskCost===false}})).settings;this.message='';}catch{this.message='Cost per task setting could not be saved';}finally{this.busy=false;this.actions.changed();}return;}
   // D55: handoff (v0.6.3) spends tokens by itself, so it is off until turned on here.
   if(key==='g'){this.busy=true;try{this.settings=(await this.actions.request({kind:'settings.set',patch:{handoff:this.settings?.handoff!==true}})).settings;this.message='';}catch{this.message='Handoff setting could not be saved';}finally{this.busy=false;this.actions.changed();}return;}
   // D55: the secret scan before /merge and /pr (v0.7.3) has its own switch, on by default.
   if(key==='v'){this.busy=true;try{this.settings=(await this.actions.request({kind:'settings.set',patch:{secretScan:this.settings?.secretScan===false}})).settings;this.message='';}catch{this.message='Secret scan setting could not be saved';}finally{this.busy=false;this.actions.changed();}return;}
   // D55: auto-review (v0.7.4) spends tokens by itself, so it is off until turned on; it needs a model picked in /review.
   if(key==='q'){this.busy=true;try{const on=this.settings?.autoReview!==true;if(on&&!this.settings?.reviewModel){this.message='Pick a model with /review once; auto-review uses it';}else{this.settings=(await this.actions.request({kind:'settings.set',patch:{autoReview:on}})).settings;this.message='';}}catch{this.message='Auto-review setting could not be saved';}finally{this.busy=false;this.actions.changed();}return;}
   // D55: auto-test (v0.7.4) has its own switch, on by default.
   if(key==='j'){this.busy=true;try{this.settings=(await this.actions.request({kind:'settings.set',patch:{autoTest:this.settings?.autoTest===false}})).settings;this.message='';}catch{this.message='Auto-test setting could not be saved';}finally{this.busy=false;this.actions.changed();}return;}
   // D55: checkpoints (v0.7.2) have their own switch, on by default.
   if(key==='u'){this.busy=true;try{this.settings=(await this.actions.request({kind:'settings.set',patch:{checkpoints:this.settings?.checkpoints===false}})).settings;this.message='';}catch{this.message='Checkpoints setting could not be saved';}finally{this.busy=false;this.actions.changed();}return;}
   // D55: presets (v0.6.2) have their own switch, on by default.
   if(key==='s'){this.busy=true;try{this.settings=(await this.actions.request({kind:'settings.set',patch:{presetsEnabled:this.settings?.presetsEnabled===false}})).settings;this.message='';}catch{this.message='Presets setting could not be saved';}finally{this.busy=false;this.actions.changed();}return;}
   const marking=this.keys[this.choice];
   if(key==='m'&&marking?.provider==='foundry'&&marking.deployments?.length){this.mapping={key:marking,deployment:'',filter:''};this.screen='deployments';this.choice=0;this.message='';this.actions.changed();return;}
   if(key==='h'){this.busy=true;try{this.settings=(await this.actions.request({kind:'settings.set',patch:{bar:this.settings?.bar==='on'?'off':'on'}})).settings;this.message='';}catch{this.message='Bar setting could not be saved';}finally{this.busy=false;this.actions.changed();}return;}
   if(key==='n'){this.busy=true;try{this.settings=(await this.actions.request({kind:'settings.set',patch:{notifications:this.settings?.notifications===false}})).settings;this.message='';}catch{this.message='Notifications setting could not be saved';}finally{this.busy=false;this.actions.changed();}return;}
   if(key==='d'||key==='f'||key==='e'){this.actions.defaults(key==='d'?'model':key==='e'?'effort':'folder');return;}
   if(key==='tab'){this.busy=true;try{const settings=(await this.actions.request({kind:'settings.get'})).settings;const index=themes.indexOf(settings?.theme??'graphite');await this.actions.theme(themes[(index+1)%themes.length]??'graphite');this.message='Theme saved';}catch{this.message='Theme could not be saved';}finally{this.busy=false;this.actions.changed();}return;}
   const selected=this.keys[this.choice];if(selected&&(key==='x'||key==='t'||key==='enter')){this.busy=true;try{if(key==='x'){await this.actions.request({kind:'keys.remove',keyId:selected.id});this.message='Key removed from the OS keychain';this.keys=this.keys.filter(k=>k.id!==selected.id);this.choice=Math.min(this.choice,Math.max(0,this.keys.length-1));}else{const r=await this.actions.request({kind:'keys.test',keyId:selected.id});this.message=testText(r.results??[])||'no models found; pull one with ollama pull <model>, then t';}}catch(error){this.message=reason(error,'Key operation failed');this.busy=false;this.actions.changed();return;}
    try{this.keys=(await this.actions.request({kind:'keys.list'})).keys??[];}catch(error){this.message+=' · list not refreshed: '+reason(error,'keys unavailable');}finally{this.busy=false;this.actions.changed();}return;}
  }
  if(this.screen==='import'&&key==='enter'){this.busy=true;try{this.names=(await this.actions.request({kind:'keys.scanEnvFile',path:this.path})).found??[];this.selected=new Set(this.names.map(n=>n.name));this.screen='names';this.choice=0;this.message='';}catch(error){this.message=reason(error,'Env file could not be scanned');}finally{this.busy=false;this.actions.changed();}return;}
  if(this.screen==='names'&&key===' '){const name=this.names[this.choice]?.name;if(name){if(this.selected.has(name))this.selected.delete(name);else this.selected.add(name);}this.actions.changed();return;}
  if(this.screen==='names'&&key==='enter'){this.busy=true;try{const result=await this.actions.request({kind:'keys.importEnv',path:this.path,names:[...this.selected]});this.keys=result.keys??[];this.screen='result';this.message='✓ saved to the OS keychain · consider deleting the source .env file';}catch(error){this.message=reason(error,'Import failed; Foundry needs endpoint/deployment fields in the file');}finally{this.busy=false;this.actions.changed();}return;}
  if((this.screen==='form'||this.screen==='import')&&[...key].length===1)this.paste(key);
 }
 // What the form must hold before anything is sent, or the words saying what's missing.
 private formError(deployments:string[]):string|null{
  const p=this.provider,keyOk=this.secret.length>0&&!/\s/.test(this.secret),modelsOk=deployments.length>0&&deployments.every(isValidModelId);
  if(p==='ollama')return isLocalEndpoint(this.endpoint)?null:'Ollama must be at http://127.0.0.1:<port>';
  if(p==='foundry')return keyOk&&isEndpoint(this.endpoint)&&modelsOk?null:'Enter a key and valid endpoint/deployments';
  if(p==='bedrock')return keyOk&&bedrockEndpoint(this.endpoint)&&modelsOk?null:'Enter a key, a region like us-east-1 and model ids';
  if(isDirectProvider(p))return keyOk&&modelsOk?null:'Enter a key and model ids, comma separated';
  return keyOk?null:'Enter a key';
 }
 private async save():Promise<void>{
  const deployments=this.deployments.split(',').map(d=>d.trim()).filter(Boolean),p=this.provider;
  const error=this.formError(deployments);if(error){this.message=error;this.actions.changed();return;}
  const endpoint=p==='bedrock'?bedrockEndpoint(this.endpoint)??'':this.endpoint;
  // Ollama has no key: the request carries none at all.
  const body:Extract<RequestBody,{kind:'keys.add'}>={kind:'keys.add',provider:p,label:this.label,...(p!=='ollama'?{secret:this.secret}:{}),...(p==='foundry'||p==='bedrock'||p==='ollama'?{endpoint}:{}),...(p!=='anthropic'&&p!=='openai'&&p!=='ollama'?{deployments}:{})};
  this.secret='';this.busy=true;this.actions.changed();
  let saved:KeyView|undefined;
  try{const pending=this.actions.request(body);if(body.secret!==undefined)body.secret='';saved=(await pending).key;}
  catch(error){this.message=reason(error,'Key could not be saved; check OS keychain access');this.busy=false;this.actions.changed();return;}
  // From here the key is saved: a failed test or refresh must say so, or a retry saves it twice.
  this.screen='result';this.message=saved?.provider==='ollama'?'✓ saved · Ollama needs no key':'✓ saved to the OS keychain';
  // Every key that carries models is tested at once: a model is offered only after its test passed (v0.6.5).
  try{if(saved){this.keys=[saved];if(saved.provider!=='anthropic'&&saved.provider!=='openai'){const test=await this.actions.request({kind:'keys.test',keyId:saved.id});this.message+=' · '+(testText(test.results??[])||'no models found; pull one with ollama pull <model>, then t');this.keys=(await this.actions.request({kind:'keys.list'})).keys??[];}}}
  catch(error){this.message+=' · test failed: '+reason(error,'try t in /settings');}finally{this.busy=false;this.actions.changed();}
 }
 private notificationText():string{
  const text:Record<NotificationAuthorization,string>={allowed:'on · allowed',denied:'on · blocked: turn on AI Term in System Settings → Notifications','not-asked':"on · not asked yet: you'll be asked at the first notification",unknown:'on · permission unknown'};
  return text[this.notificationPermission];
 }
 lines():string[]{
  const lines:string[]=[];
  if(this.screen==='providers')lines.push('Connect a provider',...providers.map(([label],i)=>`${i===this.choice?'›':' '} ${label}`));
  if(this.screen==='method')lines.push(providers.find(p=>p[1]===this.provider)?.[0]??'',`${this.choice===0?'›':' '} ${this.provider==='anthropic'?'Claude Code':'Codex'} · ${ownLoginLabel(this.provider==='anthropic'?this.engines?.claudeCode.authMethod:this.engines?.codex.authMethod)} · official CLI login`,`${this.choice===1?'›':' '} API key · OS keychain`,'What happens: the CLI owns login; AI Term never reads its credentials');
  if(this.screen==='form'){lines.push(this.provider==='ollama'?'Add Ollama · this Mac, no key':`Add API key · ${PROVIDER_LABELS[this.provider]}`);for(const [i,name]of this.fieldNames().entries()){const value=name==='secret'?'•'.repeat(this.secret.length):name==='label'?this.label:name==='endpoint'||name==='region'?this.endpoint:this.deployments;lines.push(`${i===this.row?'›':' '} ${name}: ${value}`);}lines.push('↑↓ fields · ⏎ next/save · key is masked');}
  if(this.screen==='settings'){
   const action=(index:number,text:string)=>`${this.choice===this.keys.length+index?'›':' '} ${text}`;
   lines.push('KEYS · OS keychain');
   const keyStart=Math.max(0,Math.min(this.choice,this.keys.length-1)-2);
   for(const [offset,k]of this.keys.slice(keyStart,keyStart+5).entries())lines.push(`${keyStart+offset===this.choice?'›':' '} ${k.label} · ${PROVIDER_LABELS[k.provider]} · ${k.provider==='ollama'?'no key':`key ····${k.last4}`}${k.endpoint?' · '+k.endpoint:''}`);
   lines.push(action(0,'+ add key (a)'),action(1,'import from .env (i)'),action(2,'login (l)'),'ENGINES');
   for(const [name,status]of [['Claude Code',this.engines?.claudeCode],['Codex',this.engines?.codex]] as const)lines.push(status?`${name}: ${status.installed?'✓ installed':'✗ not installed'} · ${status.loggedIn===null?'status unavailable':status.loggedIn?'✓ logged in':'✗ not logged in · /login'} · ${ownLoginLabel(status.authMethod)}${status.error?' · '+status.error:''}`:`${name}: status unavailable`);
   lines.push('DEFAULTS',action(3,`model: ${this.settings?.defaultModel??'CLI default'} · ${this.settings?.defaultEngine??'claude-code'} (d)`),action(4,`folder: ${this.settings?.defaultCwd??'launch folder'} (f)`),action(5,`permission: ask only · theme: ${this.settings?.theme??'graphite'} · ⇥ change`),action(6,`effort: ${this.settings?.defaultEffort??'CLI default'} (e)`),action(7,'input/output price per 1M for a deployment or model · p override'),action(8,`notifications: ${this.settings?.notifications===false?'off':this.notificationText()} (n)`),action(9,`bar: ${this.settings?.bar??'off'} (h)`),action(10,`worktrees: ${this.settings?.worktrees??'on'} (w)`),action(11,`keys run on: ${this.settings?.keysRunOn==='cli'?'the cli':'ai term'} (r)`),action(12,`agent caps: ${this.capsText()} per run (c)`),action(13,`context warning at 85%: ${this.settings?.contextWarning===false?'off':'on'} (k)`),action(14,`cost per task: ${this.settings?.taskCost===false?'off':'on'} · cards and /usage (o)`),action(15,`presets: ${this.settings?.presetsEnabled===false?'off':'on'} · /preset (s)`),action(16,`handoff: ${this.settings?.handoff===true?'on':'off'} · /handoff spends tokens (g)`),action(17,`checkpoints: ${this.settings?.checkpoints===false?'off':'on'} · /undo and /redo (u)`),action(18,`secret scan: ${this.settings?.secretScan===false?'off':'on'} · before /merge and /pr (v)`),action(19,`auto-test: ${this.settings?.autoTest===false?'off':'on'} · /test-cmd runs when an agent finishes (j)`),action(20,`auto-review: ${this.settings?.autoReview===true?'on':'off'} · ${this.settings?.reviewModel?.model??'no model yet'}, up to $${(this.settings?.autoReviewDailyUsd??1).toFixed(2)} a day · spends tokens (q)`),'keys are never shown in full and never written to .env');
   // Fixed text only: the daemon reports one of three states.
   if(this.notifier==='not built')lines.push('notifications unavailable: helper not built · run npm run build:notifier');else if(this.notifier==='launch failed')lines.push('notifications unavailable: helper failed to launch');
  }
  if(this.screen==='deployments'&&this.mapping){lines.push(`Which model is each deployment? · ${this.mapping.key.label}`,...(this.mapping.key.deployments??[]).map((d,i)=>`${i===this.choice?'›':' '} ${d} · ${this.settings?.deploymentModels?.[d]??'model not set'}`),'prices and context come from the model you pick · ↑↓ · ⏎ pick · Esc closes');}
  if(this.screen==='catalog'&&this.mapping){const rows=this.catalogRows(),start=Math.max(0,this.choice-6);lines.push(`${this.mapping.deployment} is…`,`Filter: ${this.mapping.filter}█`,...rows.slice(start,start+12).map((id,i)=>`${start+i===this.choice?'›':' '} ${id}`),`${rows.length-1} catalog models · ↑↓ · ⏎ saves · Esc closes`);}
  if(this.screen==='import')lines.push('Import from .env',`path: ${this.path}█`,'Names only are shown; source file is never modified');
  if(this.screen==='names')lines.push('Select names to import',...this.names.map((n,i)=>`${i===this.choice?'›':' '} [${this.selected.has(n.name)?'x':' '}] ${n.name} · ${n.provider}`),'↑↓ select · Space toggle · ⏎ import');
  if(this.screen==='result')lines.push('Keys',...this.keys.map(k=>`${k.label} · ${k.provider==='ollama'?'no key':`key ····${k.last4}`}`),...this.keys.flatMap(k=>(k.lastTest??[]).map(r=>`${r.model} · ${r.status}${r.reason?' · '+r.reason:''}`)));
  if(this.message)lines.push(this.message);if(this.busy)lines.push('◐ working');lines.push('Esc back');return lines;
 }
 draw(frame:Frame,theme:Theme):Frame{
  const rows=frame.length,cols=frame[0]?.length??0,grid=new Grid(cols,rows,theme),lines=this.lines();
  for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){const cell=frame[y]?.[x];if(cell)grid.put(x,y,cell);}
  const w=Math.min(cols,110),h=Math.min(rows-2,Math.max(8,lines.length+2)),x=Math.floor((cols-w)/2),y=Math.max(1,rows-4-h);grid.box(x,y,w,h,this.screen==='settings'?'Settings':'Login',theme.colors.surface);
  const wrapped:string[]=[];let selected=0;
  for(const line of lines){
   if(line.startsWith('›'))selected=wrapped.length;
   let rest=line;
   while(rest.length>w-6&&w>6){const limit=w-6,space=rest.lastIndexOf(' ',limit),at=space>0?space:limit;wrapped.push(rest.slice(0,at));rest=rest.slice(at).trimStart();}
   wrapped.push(rest);
  }
  const start=Math.min(Math.max(0,selected-(h-4)),Math.max(0,wrapped.length-(h-2)));
  wrapped.slice(start,start+h-2).forEach((line,i)=>grid.text(x+3,y+i+1,line,theme.colors['ink-2'],theme.colors.surface,false,w-6));return grid.cells;
 }
}
