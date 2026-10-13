import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { stripVTControlCharacters } from 'node:util';
import { writeClaudeSettings,removeClaudeSettings } from './claude-settings.js';
import {parseClaudeStatus} from './claude-status.js';
import {parseCodexStatus,codexTitle,isCodexApproval,type CodexRun} from './codex-status.js';
import {initialStatus,reduceStatus,type StatusState} from './status-reducer.js';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Paths } from '../shared/paths.js';
import type { SessionInfo, SessionEvent, TerminalModes, CreateSession, ClaudeStatusEvent } from '../shared/protocol.js';
import { isUUID, isTitle, isSize, validCwd, validateSession } from '../shared/validate.js';
import { atomicWrite, readState } from './store.js';
import { Logger } from './log.js';
import { PtyHost, type SpawnRecipe } from './pty-host.js';
import { Mirror, type MirrorSignal } from './mirror.js';
import { buildShellEnv, buildSpawnEnv, buildArgs, buildUsageEnv, buildUsageArgs,buildStatusEnv,buildStatusArgs } from './env.js';
import { KeyStore, KeyError } from './keys.js';
import { checkEngine } from './engines.js';
import { UsageService } from './usage-service.js';
import { ReplyBudget } from './reply-budget.js';
interface Live {
    info: SessionInfo;
    host?: PtyHost;
    mirror: Mirror;
    output: Promise<void>;
    mirrorFailed?:boolean;
    statusState?:StatusState;
    lastReply?:string;
    codexRun?:CodexRun;
    pasting?:boolean;
    queuedBytes:number;
    paused:boolean;
    attached:boolean;
    clientPaused:boolean;
}
export class SessionManager extends EventEmitter {
    private sessions = new Map<string, Live>();
    private size = { cols: 85, rows: 30 };
    private saving: Promise<void> = Promise.resolve();
    private closing = false;
    private warnings = new Map<string, string>();
    private resuming=new Set<string>();
    private onLogFailure = () => this.warning('log', 'Log could not be saved; agents keep running.');
    private onLogRecovery = () => this.clearWarning('log');
    constructor(private readonly paths: Paths, private readonly log: Logger, private readonly recipe?: SpawnRecipe, private readonly childUmask?: number, private readonly writeState = atomicWrite, private readonly keys = new KeyStore(paths.root), private readonly usage?:UsageService,private readonly cliEntry=fileURLToPath(new URL('../cli/index.js',import.meta.url))) {
        super();usage?.on('claude-status',(id:string,raw:unknown,seq:number)=>this.ingressStatus(id,parseClaudeStatus(raw,seq,new Date().toISOString())));usage?.on('codex-status',(id:string,raw:unknown,seq:number)=>this.ingressStatus(id,parseCodexStatus(raw,seq,new Date().toISOString())));keys.on('warning',()=>this.keyMetadataWarning());usage?.on('settingsWarning',(on:boolean)=>{if(on)this.warning('usage-settings','Settings could not be read; usage uses last good prices.');else this.clearWarning('usage-settings');});usage?.on('warning',(on:boolean)=>{if(on)this.warning('usage','Usage could not be saved; agents keep running.');else this.clearWarning('usage');}); log.on('writeFailed', this.onLogFailure); log.on('writeRecovered', this.onLogRecovery);
    }
    keyMetadataWarning():void{this.warning('key-metadata','Invalid key metadata entry skipped; other keys remain usable.');}
    warningText(): string | null { return this.warnings.size ? [...this.warnings.values()].join(' ') : null; }
    private warning(source: string, text: string): void {
        if (this.warnings.get(source) === text) return;
        this.warnings.set(source, text); this.event({ kind: 'daemon.warning', text: this.warningText() ?? '' });
    }
    private clearWarning(source: string): void {
        if (!this.warnings.delete(source)) return;
        const text = this.warningText(); this.event(text ? { kind: 'daemon.warning', text } : { kind: 'daemon.warningCleared' });
    }
    async load(): Promise<void> {
        const state = await readState(this.paths.state);
        if (!state || typeof state !== 'object' || !('sessions' in state) || !Array.isArray(state.sessions))
            throw new Error('Invalid daemon state');
        for (const raw of state.sessions as unknown[]) {
            if (!raw || typeof raw !== 'object')
                throw new Error('Invalid session record');
            const r = raw as Record<string, unknown>;
            if (!isUUID(r.id) || !isTitle(r.title) || !['shell','claude-code','codex'].includes(String(r.engine)) || typeof r.cwd !== 'string' || typeof r.createdAt !== 'string')
                throw new Error('Invalid session record');
            const now = new Date().toISOString();
            const saved = validateSession(r);
            const info: SessionInfo = { id: saved.id, title: saved.title, engine: saved.engine, model: saved.model, auth: saved.auth, cwd: saved.cwd, permission: saved.permission, status: saved.status, statusDetail: saved.statusDetail, statusSince: saved.statusSince, exitCode: saved.exitCode, createdAt: saved.createdAt, lastOutputAt: saved.lastOutputAt, ctxPercent: saved.ctxPercent,lastActivity:saved.lastActivity??null, ...(saved.authMethod ? {authMethod:saved.authMethod} : {}), ...(saved.effort!==undefined?{effort:saved.effort}:{}), ...(saved.conversationId?{conversationId:saved.conversationId}:{}) };
            if (!['exited','error'].includes(info.status)) {
                info.status = 'exited'; info.statusDetail = 'background service restarted';
                info.statusSince = now; info.exitCode = null;
            }
            this.sessions.set(info.id, { info, mirror: new Mirror(this.size.cols, this.size.rows, () => { }), queuedBytes:0, attached:false,clientPaused:false, paused:false, output: Promise.resolve() });
        }
        await this.persist();
    }
    list(): SessionInfo[] { return [...this.sessions.values()].map(s => ({ ...s.info })); }
    get(id: string): SessionInfo { const live = this.sessions.get(id); if (!live)
        throw new Error('Session not found'); return { ...live.info }; }
    previewDimensions(): {
        cols: number;
        rows: number;
    } { return { ...this.size }; }
    // Live PTY children only; the This Mac sampler sums each one's process tree.
    sessionRoots(): { sessionId: string; pid: number }[] { return [...this.sessions.values()].flatMap(s => s.host && !['exited', 'error'].includes(s.info.status) ? [{ sessionId: s.info.id, pid: s.host.pty.pid }] : []); }
    activeCount(): number { return this.list().filter(s => !['exited','error'].includes(s.status)).length; }
    private event(event: SessionEvent): void { this.emit('event', event); }
    private persist(): Promise<void> {
        const data = { sessions: [...this.sessions.values()].map(s => ({ ...s.info, pid: s.host?.pty.pid ?? null, recipe: { engine: s.info.engine, model: s.info.model, auth: s.info.auth.kind==='key'?{kind:'key',keyId:s.info.auth.keyId}:{ kind: 'account' }, cwd: s.info.cwd, permission: s.info.permission, ...(s.info.effort!==undefined?{effort:s.info.effort}:{}), ...(s.info.conversationId?{conversationId:s.info.conversationId}:{}) } })) };
        this.saving = this.saving.then(async () => {
            try { await this.writeState(this.paths.state, data); }
            catch {
                this.warning('state', 'Session state could not be saved; agents keep running.');
                this.log.error('State write failed; will retry on the next change');
                return;
            }
            this.clearWarning('state');
        });
        return this.saving;
    }
    async resume(id:string):Promise<SessionInfo>{
        const saved=this.get(id);
        if(!['exited','error'].includes(saved.status))throw new Error('Resume needs a finished agent');
        if(saved.engine==='shell')throw new Error('A shell has no AI conversation to resume');
        if(saved.engine==='claude-code'&&!saved.conversationId)throw new Error('This older Claude agent has no conversation ID');
        if(saved.conversationId&&this.list().some(s=>s.conversationId===saved.conversationId&&!['exited','error'].includes(s.status)))throw new Error('Conversation already running');
        const identity=saved.conversationId??saved.id;if(this.resuming.has(identity))throw new Error('Conversation already starting');
        const auth=saved.auth.kind==='key'?{kind:'key' as const,keyId:saved.auth.keyId}:{kind:'account' as const};
        this.resuming.add(identity);
        try{return await this.create({engine:saved.engine,model:saved.model,effort:saved.effort??null,auth,cwd:saved.cwd,permission:saved.permission,title:saved.title},{...(saved.conversationId?{conversationId:saved.conversationId}:{})});}finally{this.resuming.delete(identity);}
    }
    async create(request: CreateSession | { cwd: string; title?: string }, continuation?:{conversationId?:string}): Promise<SessionInfo> {
        const cwdValid=await validCwd(request.cwd);
        if (this.closing || !cwdValid || (request.title !== undefined && !isTitle(request.title)))
            throw new Error('Invalid session request');
        const agent = 'engine' in request && request.engine !== 'shell' ? request : null;
        const conversationId=agent?.engine==='claude-code'&&!agent.login?(continuation?.conversationId??randomUUID()):undefined;
        // Status is not billing: subscription and key sessions both report it. Login sessions only sign in.
        const withStatus=Boolean(agent&&!agent.login&&this.usage);
        const codexStatus=withStatus&&agent?.engine==='codex'?{node:process.execPath,entry:this.cliEntry,...(this.cliEntry.endsWith('.ts')?{loader:createRequire(import.meta.url).resolve('tsx')}:{})}:undefined;
        const argvRequest=agent?{...agent,...(conversationId?{conversationId}:{}),...(continuation?{resume:true}:{}),...(codexStatus?{codexStatus}:{})}:null;
        let recipe: SpawnRecipe;
        let authMethod: SessionInfo['authMethod'];
        if (agent) {
            const status = await checkEngine(agent.engine);
            if (!status.installed || !status.path) throw new Error(`${agent.engine === 'codex' ? 'codex' : 'claude'} not found in PATH`);
            if (agent.auth.kind==='account' && !agent.login && status.loggedIn !== true) throw new Error(status.loggedIn === false ? 'Engine is not logged in' : 'Engine login status unavailable');
            authMethod = status.authMethod;
            if(agent.auth.kind==='key'){
                const key=await this.keys.view(agent.auth.keyId);
                if(agent.engine==='claude-code'&&key.provider!=='anthropic'||agent.engine==='codex'&&key.provider==='anthropic')throw new KeyError('Key provider does not match engine');
                if(key.provider==='foundry'&&(!agent.model||!key.deployments?.includes(agent.model)||!key.lastTest?.some(r=>r.model===agent.model&&r.status==='ready')))throw new KeyError('Foundry deployment must pass its test first');
                authMethod='api-key';
                recipe={executable:status.path,args:buildArgs({...agent,...argvRequest,...(key.provider==='foundry'?{foundryEndpoint:key.endpoint}:{}),...(key.provider==='openai'?{openaiKey:true}:{})}),env:{}};
            }else recipe = { executable: status.path, args: agent.login ? (agent.engine==='codex'?['--no-daemon','-c','check_for_update_on_startup=false','login']:['auth','login']) : buildArgs({...agent,...argvRequest}), env: buildSpawnEnv(agent.engine, {kind:'account'}, process.env) };
        } else recipe = this.recipe ? {executable:this.recipe.executable,args:[...this.recipe.args],env:{...this.recipe.env}} : { executable: process.env.SHELL || '/bin/zsh', args: ['-l'], env: buildShellEnv(process.env) };
        const keyView=agent?.auth.kind==='key'?await this.keys.view(agent.auth.keyId):null;
        const now = new Date().toISOString();
        const info: SessionInfo = { id: randomUUID(), title: request.title ?? (agent?.engine === 'codex' ? 'Codex' : agent ? 'Claude Code' : 'shell'), engine: agent?.engine ?? 'shell', model: agent ? agent.model : 'shell', ...(agent&&!agent.login?{effort:agent.effort??null}:{}), ...(conversationId?{conversationId}:{}), auth: keyView?{kind:'key',keyId:keyView.id,provider:keyView.provider,keyLabel:keyView.label,last4:keyView.last4}:{ kind: 'account' }, cwd: request.cwd, permission: agent?.permission ?? 'ask', ...(authMethod ? {authMethod} : {}), status: 'starting', statusDetail: 'starting', statusSince: now, exitCode: null, createdAt: now, lastOutputAt: null, ctxPercent: null,lastActivity:null };
        const statusTelemetry=withStatus&&agent?this.usage?.registerStatus(info.id,agent.engine):undefined;
        const telemetry=agent&&!agent.login&&authMethod==='api-key'&&this.usage?this.usage.register({sessionId:info.id,engine:agent.engine,provider:keyView?.provider??(agent.engine==='claude-code'?'anthropic':'openai'),model:agent.model}):undefined;
        if(telemetry){const extra=buildUsageArgs(agent?.engine??'codex',telemetry),delimiter=recipe.args.indexOf('--');if(delimiter>=0)recipe.args.splice(delimiter,0,...extra);else recipe.args.push(...extra);Object.assign(recipe.env,buildUsageEnv(agent?.engine??'codex',telemetry));}
        const replies = new ReplyBudget();
        let dropping = false;
        const reply = (data: string) => {
            if (replies.take(Buffer.byteLength(data))) { dropping = false; live.host?.write(data); return; }
            if (!dropping) this.log.error(`Dropped terminal query replies over budget for session ${info.id}`);
            dropping = true;
        };
        const live: Live = { info,...(statusTelemetry?{statusState:initialStatus(now)}:{}), mirror: new Mirror(this.size.cols, this.size.rows, reply, agent?.engine==='codex'?signal=>this.codexSignal(live,signal):undefined), queuedBytes:0, attached:false,clientPaused:false, paused:false, output: Promise.resolve() };
        this.sessions.set(info.id, live);
        try {
            if(statusTelemetry&&agent?.engine==='codex'){
                Object.assign(recipe.env,buildStatusEnv(statusTelemetry));
                if(!recipe.args.some(arg=>arg.startsWith('notify=')))this.log.error('Codex notify left off: node or ai path has characters outside the safe set; done and last reply need it');
            }
            if(statusTelemetry&&agent?.engine==='claude-code'){
                const settings=await writeClaudeSettings(this.paths.root,info.id,statusTelemetry.port,process.execPath,this.cliEntry);
                const extra=buildStatusArgs(settings),delimiter=recipe.args.indexOf('--');if(delimiter>=0)recipe.args.splice(delimiter,0,...extra);else recipe.args.push(...extra);
                Object.assign(recipe.env,buildStatusEnv(statusTelemetry));
            }
            if(agent?.auth.kind==='key') await this.keys.withSecret(agent.auth.keyId,secret=>{
                recipe.env=buildSpawnEnv(agent.engine,{kind:'key',secret,...(keyView?.provider==='openai'?{provider:'openai' as const}:{})},process.env);
                if(telemetry)Object.assign(recipe.env,buildUsageEnv(agent.engine,telemetry));
                if(statusTelemetry)Object.assign(recipe.env,buildStatusEnv(statusTelemetry));
                try{live.host=new PtyHost(recipe,request.cwd,this.size.cols,this.size.rows,this.childUmask);}finally{recipe.env={};}
            });
            else live.host = new PtyHost(recipe, request.cwd, this.size.cols, this.size.rows, this.childUmask);
            const host=live.host;if(!host)throw new Error('Spawn did not return a PTY');
            host.pty.onData(data => {
                if(live.mirrorFailed)return;
                const bytes=Buffer.byteLength(data);live.queuedBytes+=bytes;
                this.updatePause(live);
                live.output = live.output.then(async () => {
                    if(live.mirrorFailed)return;
                    await live.mirror.write(data);
                    info.lastOutputAt = new Date().toISOString();
                    if (info.status === 'starting'&&(!live.statusState||live.statusState.status==='starting')) {
                        // PTY output is not an ingress event: preserve its sequence while making the same startup transition in both records.
                        if(live.statusState)live.statusState={...live.statusState,status:'running',statusDetail:'running',statusSince:info.lastOutputAt};
                        info.status = 'running';
                        info.statusDetail = 'running';
                        info.statusSince = info.lastOutputAt;
                        await this.persist();
                        this.event({ kind: 'session.updated', session: { ...info } });
                    }
                    this.emit('output', info.id, Buffer.from(data));
                }).catch(async () => {
                    if(live.mirrorFailed)return;
                    live.mirrorFailed=true;this.usage?.revoke(info.id);
                    info.status='error';info.statusDetail='terminal mirror failed';info.exitCode=null;info.statusSince=new Date().toISOString();
                    this.log.error('Session terminal mirror failed');
                    await this.persist();this.event({kind:'session.updated',session:{...info}});
                    // Stop the failed child without waiting on live.output, which is this very task.
                    try{await host.stop();}catch{this.log.error('Failed to stop session after terminal mirror failure');}
                }).finally(()=>{
                    live.queuedBytes-=bytes;
                    this.updatePause(live);
                });
            });
            host.pty.onExit(event => {
                this.usage?.revoke(info.id);
                // Set terminal precedence synchronously: queued hook bodies must not win a process-exit race.
                if(live.statusState)live.statusState=reduceStatus(live.statusState,{seq:live.statusState.seq+1,at:new Date().toISOString(),kind:'exit',status:'exited',detail:'exited',exitCode:event.exitCode});
                live.output = live.output.then(async () => {
                    if(live.mirrorFailed)return;
                    // node-pty reports exitCode 0 for a killed child; only the signal tells a crash apart.
                    const crashed = Boolean(event.signal) && !live.host?.stopRequested;
                    info.exitCode = crashed ? null : event.exitCode;
                    info.status = event.exitCode === 0 && !crashed ? 'exited' : 'error';
                    info.statusDetail = crashed ? `signal ${event.signal}` : `exit ${event.exitCode}`;
                    info.statusSince = new Date().toISOString();
                    if(live.statusState)live.statusState={...live.statusState,status:info.status,statusDetail:info.statusDetail,statusSince:info.statusSince,exitCode:info.exitCode};
                    await this.persist();
                    this.event({ kind: 'session.updated', session: { ...info } });
                }).catch(error => { this.log.error('Exit record failed'); this.emit('fatal', error); });
            });
        }
        catch (error) {
            this.usage?.revoke(info.id);
            if(error instanceof KeyError){this.sessions.delete(info.id);live.mirror.dispose();throw error;}
            info.status = 'error';
            info.statusDetail = 'spawn failed';
            // Spawn errors can include argv or child output, so keep diagnostics fixed for every session.
            this.log.error('PTY spawn failed for session');
        }
        await this.persist();
        this.event({ kind: 'session.updated', session: { ...info } });
        return { ...info };
    }
    private ingressStatus(id:string,update:{event:ClaudeStatusEvent;reply?:string}|null):void{
        const live=this.sessions.get(id);if(!live?.statusState||live.mirrorFailed||['exited','error'].includes(live.statusState.status)||!update)return;
        // A reply stays the newest reply even when its status event lost to a newer one.
        if(update.reply!==undefined)live.lastReply=update.reply;
        this.applyStatus(live,reduceStatus(live.statusState,update.event));
    }
    private applyStatus(live:Live,next:StatusState):void{
        if(!live.statusState||next===live.statusState)return;
        live.statusState=next;
        Object.assign(live.info,{status:next.status,statusDetail:next.statusDetail,statusSince:next.statusSince,ctxPercent:next.ctxPercent,lastActivity:next.lastActivity});
        this.event({kind:'session.updated',session:{...live.info}});
        void this.persist();
    }
    // Codex terminal signals and Enter from the attached owner wait behind status requests that arrived earlier. Each applies only
    // when it changes what a card would show, so a repainting title cannot reset statusSince or flood state writes.
    private codexStatus(live:Live,event:{kind:'running'}|{kind:'waiting';reason:'permission'}|{kind:'context';percent:number},when?:(state:StatusState)=>boolean):void{
        this.usage?.enqueueStatus(live.info.id,seq=>{
            const state=live.statusState;if(!state||live.mirrorFailed||['exited','error'].includes(state.status)||when&&!when(state))return;
            const next=reduceStatus(state,{...event,seq,at:new Date().toISOString()});
            if(next.status===state.status&&next.statusDetail===state.statusDetail&&next.ctxPercent===state.ctxPercent)return;
            this.applyStatus(live,next);
        });
    }
    private codexSignal(live:Live,signal:MirrorSignal):void{
        // Signals run inside the mirror's parser; a failure here must not mark the terminal mirror failed and stop the agent.
        try{this.readCodexSignal(live,signal);}catch{this.log.error('Codex status signal failed');}
    }
    private readCodexSignal(live:Live,signal:MirrorSignal):void{
        // A bare bell counts only during a turn: with osc9 Codex itself never rings, so a stray bell after done is not an approval.
        if(signal.kind==='bell'){this.codexStatus(live,{kind:'waiting',reason:'permission'},state=>state.status==='running');return;}
        if(signal.kind==='osc9'&&isCodexApproval(signal.text)){this.codexStatus(live,{kind:'waiting',reason:'permission'});return;}
        if(signal.kind!=='title')return;
        const title=codexTitle(signal.title),previous=live.codexRun;live.codexRun=title.run;
        if(title.leftPercent!==null)this.codexStatus(live,{kind:'context',percent:100-title.leftPercent});
        // Only a change into a run state counts: the spinner repaints the same "Working" title after notify already said done.
        // Ready is left to notify, which marks the turn done.
        if(title.run===previous)return;
        if(title.run==='working')this.codexStatus(live,{kind:'running'});
        else if(title.run==='action')this.codexStatus(live,{kind:'waiting',reason:'permission'});
    }
    async snapshot(id: string, publish?: (snapshot: string, size:{cols:number;rows:number}) => void): Promise<string> { const live = this.sessions.get(id); if (!live)
        throw new Error('Session not found'); return live.output.then(() => { const snapshot = live.mirror.snapshot(); publish?.(snapshot,{cols:live.mirror.terminal.cols,rows:live.mirror.terminal.rows}); return snapshot; }); }
    async text(id:string,lastReply=false):Promise<import('../shared/protocol.js').SessionText>{
        if(!isUUID(id))throw new Error('Invalid session UUID');const live=this.sessions.get(id);if(!live)throw new Error('Session not found');
        return live.output.then(()=>{
            if(lastReply&&live.info.engine!=='shell'&&live.lastReply!==undefined){
                // eslint-disable-next-line no-control-regex -- Explicit copy strips controls before reaching a clipboard.
                const text=stripVTControlCharacters(live.lastReply).replace(/\r\n?/g,'\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\p{Zl}\p{Zp}]|(?!\u200d)\p{Cf}/gu,'');
                return {sessionId:id,text,truncated:false,source:'last-reply' as const};
            }
            return {sessionId:id,...live.mirror.plainText()};
        });
    }
    async stop(id: string): Promise<void> { const live = this.sessions.get(id); if (!live)
        throw new Error('Session not found'); await live.host?.stop(); await live.output; }
    async remove(id: string): Promise<void> { const live = this.sessions.get(id); if (!live)
        throw new Error('Session not found'); if (!['exited', 'error'].includes(live.info.status))
        throw new Error('Only exited sessions can be removed'); if(live.mirrorFailed)await this.stop(id); await live.output; await removeClaudeSettings(this.paths.root,id);live.lastReply=undefined;live.mirror.dispose(); this.sessions.delete(id); await this.persist(); this.event({ kind: 'session.removed', sessionId: id }); }
    async rename(id: string, title: string): Promise<SessionInfo> { const live = this.sessions.get(id); if (!live || !isTitle(title))
        throw new Error('Invalid session or title'); live.info.title = title; await this.persist(); this.event({ kind: 'session.updated', session: { ...live.info } }); return { ...live.info }; }
    async previewSize(cols: number, rows: number): Promise<void> { if (!isSize(cols, rows))
        throw new Error('Invalid preview size'); this.size = { cols, rows }; for (const live of this.sessions.values()) {
        await live.output;
        if(!live.attached && (live.mirror.terminal.cols !== cols || live.mirror.terminal.rows !== rows)){
            live.mirror.resize(cols, rows);live.host?.resize(cols, rows);
            this.event({kind:'session.previewResized',sessionId:live.info.id,cols,rows});
        }
    } }
    private updatePause(live:Live):void {
        const blocked=live.clientPaused||live.queuedBytes>=1024*1024;
        if(blocked&&!live.paused){live.host?.pause();live.paused=true;}
        else if(!live.clientPaused&&live.queuedBytes<=256*1024&&live.paused){live.host?.resume();live.paused=false;}
    }
    clientBackpressure(id:string,paused:boolean):void {const live=this.sessions.get(id);if(!live)return;live.clientPaused=paused;this.updatePause(live);}
    input(id:string,data:Buffer):void {
        const live=this.sessions.get(id);if(!live?.attached)return;live.host?.write(data);
        // Enter after a finished turn or an answered prompt starts work; plain CR or the kitty-protocol Enter (CSI 13 u).
        if(live.info.engine!=='codex')return;
        // A bracketed paste may carry newlines without submitting anything, and a long one spans several chunks.
        const start=data.lastIndexOf('\x1b[200~'),end=data.lastIndexOf('\x1b[201~'),inPaste=live.pasting||start>=0||end>=0;
        live.pasting=start>end||(start<0&&end<0&&live.pasting===true);
        if(!inPaste&&(data.includes(0x0d)||data.includes('\x1b[13u')||data.includes('\x1b[13;1u')))this.codexStatus(live,{kind:'running'},state=>state.status==='done'||state.status==='waiting');
    }
    async attach(id:string,cols:number,rows:number,publish:(snapshot:string,size:{cols:number;rows:number},modes:TerminalModes)=>void):Promise<void> {
        const live=this.sessions.get(id);if(!live||!isSize(cols,rows)||this.closing)throw new Error('Invalid attach');
        const task=live.output.then(()=>{
            if(this.closing||this.sessions.get(id)!==live)throw new Error('Session unavailable');
            live.mirror.resize(cols,rows);live.host?.resize(cols,rows);
            const snapshot=live.mirror.snapshot();
            live.attached=true;live.mirror.setAttached(true);
            publish(snapshot,{cols,rows},live.mirror.modes());
            this.event({kind:'session.previewResized',sessionId:id,cols,rows});
        });
        live.output=task.catch(()=>{this.log.error('Attach failed');});await task;
    }
    async detach(id:string,owned:()=>boolean):Promise<void> {
        const live=this.sessions.get(id);if(!live)return;
        const task=live.output.then(()=>{
            if(!owned())return;
            live.attached=false;live.mirror.setAttached(false);live.clientPaused=false;this.updatePause(live);
            live.mirror.resize(this.size.cols,this.size.rows);live.host?.resize(this.size.cols,this.size.rows);
            this.event({kind:'session.previewResized',sessionId:id,...this.size});
        });
        live.output=task.catch(()=>{this.log.error('Attachment change failed');});await task;
    }
    async resizeAttached(id:string,cols:number,rows:number,owned:()=>boolean):Promise<void> {
        const live=this.sessions.get(id);if(!live||!isSize(cols,rows))throw new Error('Invalid resize');
        const task=live.output.then(()=>{if(!owned())throw new Error('Not attached');live.mirror.resize(cols,rows);live.host?.resize(cols,rows);this.event({kind:'session.previewResized',sessionId:id,cols,rows});});
        live.output=task.catch(()=>{this.log.error('Attachment change failed');});await task;
    }
    async shutdown(): Promise<void> {
        this.closing=true;
        const ids=[...this.sessions.keys()];
        const stopped=await Promise.allSettled(ids.map(id=>this.stop(id)));
        for(const [index,result]of stopped.entries())if(result.status==='rejected')this.log.error(`Session stop failed: ${ids[index]}`);
        await this.saving;
        for(const live of this.sessions.values())live.mirror.dispose();
        this.log.off('writeFailed',this.onLogFailure);this.log.off('writeRecovered',this.onLogRecovery);
    }
}
