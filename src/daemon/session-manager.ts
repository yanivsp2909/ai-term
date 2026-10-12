import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Paths } from '../shared/paths.js';
import type { SessionInfo, SessionEvent, TerminalModes, CreateSession } from '../shared/protocol.js';
import { isUUID, isTitle, isSize, validCwd, validateSession } from '../shared/validate.js';
import { atomicWrite, readState } from './store.js';
import { Logger } from './log.js';
import { PtyHost, type SpawnRecipe } from './pty-host.js';
import { Mirror } from './mirror.js';
import { buildShellEnv, buildSpawnEnv, buildArgs, buildUsageEnv, buildUsageArgs } from './env.js';
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
    constructor(private readonly paths: Paths, private readonly log: Logger, private readonly recipe?: SpawnRecipe, private readonly childUmask?: number, private readonly writeState = atomicWrite, private readonly keys = new KeyStore(paths.root), private readonly usage?:UsageService) {
        super();keys.on('warning',()=>this.keyMetadataWarning());usage?.on('settingsWarning',(on:boolean)=>{if(on)this.warning('usage-settings','Settings could not be read; usage uses last good prices.');else this.clearWarning('usage-settings');});usage?.on('warning',(on:boolean)=>{if(on)this.warning('usage','Usage could not be saved; agents keep running.');else this.clearWarning('usage');}); log.on('writeFailed', this.onLogFailure); log.on('writeRecovered', this.onLogRecovery);
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
            const info: SessionInfo = { id: saved.id, title: saved.title, engine: saved.engine, model: saved.model, auth: saved.auth, cwd: saved.cwd, permission: saved.permission, status: saved.status, statusDetail: saved.statusDetail, statusSince: saved.statusSince, exitCode: saved.exitCode, createdAt: saved.createdAt, lastOutputAt: saved.lastOutputAt, ctxPercent: saved.ctxPercent, ...(saved.authMethod ? {authMethod:saved.authMethod} : {}), ...(saved.effort!==undefined?{effort:saved.effort}:{}), ...(saved.conversationId?{conversationId:saved.conversationId}:{}) };
            if (info.status === 'starting' || info.status === 'running') {
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
    activeCount(): number { return this.list().filter(s => s.status === 'starting' || s.status === 'running').length; }
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
        const argvRequest=agent?{...agent,...(conversationId?{conversationId}:{}),...(continuation?{resume:true}:{})}:null;
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
        const info: SessionInfo = { id: randomUUID(), title: request.title ?? (agent?.engine === 'codex' ? 'Codex' : agent ? 'Claude Code' : 'shell'), engine: agent?.engine ?? 'shell', model: agent ? agent.model : 'shell', ...(agent&&!agent.login?{effort:agent.effort??null}:{}), ...(conversationId?{conversationId}:{}), auth: keyView?{kind:'key',keyId:keyView.id,provider:keyView.provider,keyLabel:keyView.label,last4:keyView.last4}:{ kind: 'account' }, cwd: request.cwd, permission: agent?.permission ?? 'ask', ...(authMethod ? {authMethod} : {}), status: 'starting', statusDetail: 'starting', statusSince: now, exitCode: null, createdAt: now, lastOutputAt: null, ctxPercent: null };
        const telemetry=agent&&!agent.login&&authMethod==='api-key'&&this.usage?this.usage.register({sessionId:info.id,engine:agent.engine,provider:keyView?.provider??(agent.engine==='claude-code'?'anthropic':'openai'),model:agent.model}):undefined;
        if(telemetry){const extra=buildUsageArgs(agent?.engine??'codex',telemetry),delimiter=recipe.args.indexOf('--');if(delimiter>=0)recipe.args.splice(delimiter,0,...extra);else recipe.args.push(...extra);Object.assign(recipe.env,buildUsageEnv(agent?.engine??'codex',telemetry));}
        const replies = new ReplyBudget();
        let dropping = false;
        const reply = (data: string) => {
            if (replies.take(Buffer.byteLength(data))) { dropping = false; live.host?.write(data); return; }
            if (!dropping) this.log.error(`Dropped terminal query replies over budget for session ${info.id}`);
            dropping = true;
        };
        const live: Live = { info, mirror: new Mirror(this.size.cols, this.size.rows, reply), queuedBytes:0, attached:false,clientPaused:false, paused:false, output: Promise.resolve() };
        this.sessions.set(info.id, live);
        try {
            if(agent?.auth.kind==='key') await this.keys.withSecret(agent.auth.keyId,secret=>{
                recipe.env=buildSpawnEnv(agent.engine,{kind:'key',secret,...(keyView?.provider==='openai'?{provider:'openai' as const}:{})},process.env);
                if(telemetry)Object.assign(recipe.env,buildUsageEnv(agent.engine,telemetry));
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
                    if (info.status === 'starting') {
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
                live.output = live.output.then(async () => {
                    if(live.mirrorFailed)return;
                    // node-pty reports exitCode 0 for a killed child; only the signal tells a crash apart.
                    const crashed = Boolean(event.signal) && !live.host?.stopRequested;
                    info.exitCode = crashed ? null : event.exitCode;
                    info.status = event.exitCode === 0 && !crashed ? 'exited' : 'error';
                    info.statusDetail = crashed ? `signal ${event.signal}` : `exit ${event.exitCode}`;
                    info.statusSince = new Date().toISOString();
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
    async snapshot(id: string, publish?: (snapshot: string, size:{cols:number;rows:number}) => void): Promise<string> { const live = this.sessions.get(id); if (!live)
        throw new Error('Session not found'); return live.output.then(() => { const snapshot = live.mirror.snapshot(); publish?.(snapshot,{cols:live.mirror.terminal.cols,rows:live.mirror.terminal.rows}); return snapshot; }); }
    async text(id:string):Promise<import('../shared/protocol.js').SessionText>{
        if(!isUUID(id))throw new Error('Invalid session UUID');const live=this.sessions.get(id);if(!live)throw new Error('Session not found');
        return live.output.then(()=>({sessionId:id,...live.mirror.plainText()}));
    }
    async stop(id: string): Promise<void> { const live = this.sessions.get(id); if (!live)
        throw new Error('Session not found'); await live.host?.stop(); await live.output; }
    async remove(id: string): Promise<void> { const live = this.sessions.get(id); if (!live)
        throw new Error('Session not found'); if (!['exited', 'error'].includes(live.info.status))
        throw new Error('Only exited sessions can be removed'); await live.output; live.mirror.dispose(); this.sessions.delete(id); await this.persist(); this.event({ kind: 'session.removed', sessionId: id }); }
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
    input(id:string,data:Buffer):void {const live=this.sessions.get(id);if(live?.attached)live.host?.write(data);}
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
