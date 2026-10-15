import { ExtensionService } from './extensions.js';
import { catalogIds } from '../shared/model-catalog.js';
import { createServer, type Socket, type Server } from 'node:net';
import type { Paths } from '../shared/paths.js';
import { listenPrivate, closePrivate, type SocketIdentity } from './private-socket.js';
import { FrameDecoder, encodeControl, encodeData, decodeControl, ProtocolError, PROTOCOL_VERSION, MAX_FRAME_BYTES, COPY_CHUNK_BYTES, type NotifierState,type NotificationAuthorization, type SessionText, type Request, type SessionEvent, type SystemStats } from '../shared/protocol.js';
import { previewWorktree } from './worktrees.js';
import { WORKTREE_DELETE_ERRORS } from './worktree-removal.js';
import { activateTerminal } from './terminal-activate.js';
import type { TerminalBundle } from '../shared/protocol.js';
import { validateRequest } from '../shared/validate.js';
import { SessionManager, AGENT_COMMAND_ERRORS, FORK_ERRORS, HANDOFF_ERRORS } from './session-manager.js';
import { SettingsStore } from './settings.js';
import { Logger } from './log.js';
import { UsageService } from './usage-service.js';
import { enginesStatus } from './engines.js';
import { KeyStore, KeyError, FOUNDRY_KEY_ERRORS } from './keys.js';
import { testFoundry } from './providers/foundry.js';
import { testDirect } from './providers/direct.js';
import { PROFILE_OTHER_ENGINE } from './accounts.js';
import { CHECKPOINT_ERRORS } from './checkpoints.js';
import { CHECKOUT_NOT_ON_BASE, MERGE_ERRORS, MergeError } from './merge.js';
import { TEST_ERRORS } from './test-run.js';
import { REVIEW_ERRORS } from './review.js';
import { listOllama, OllamaError, OLLAMA_ERRORS } from './providers/ollama.js';
import { DIRECT_HOSTS } from '../shared/providers.js';
import { SystemSampler, defaultSamplerDeps } from './sysstats.js';
import packageInfo from '../../package.json' with { type: 'json' };
interface Peer {
    socket: Socket;
    hello: boolean;
    closing:boolean;
    preview: string | null;
    attached:string|null;
    refreshing: boolean;
    lagged: boolean;
    stats: boolean; usage:boolean;
    clicks: boolean;
    terminal?: TerminalBundle;
    queue: Promise<void>;
    snapshotId?: string;
}
export { socketAnswers } from './private-socket.js';
export class DaemonServer {
    private server: Server;
    private readonly settings: SettingsStore;
    private peers = new Set<Peer>();
    private owners=new Map<string,Peer>();
    private socketIdentity: SocketIdentity | undefined;
    private readonly sampler: SystemSampler;
    private closed = false;
    constructor(private readonly paths: Paths, private readonly manager: SessionManager, private readonly log: Logger, sampler?: SystemSampler, private readonly keys = new KeyStore(paths.root), private readonly usage?:UsageService, private readonly notifier?:{state():NotifierState;permission?():NotificationAuthorization;refreshPermission?():Promise<NotificationAuthorization>}, private readonly activate=activateTerminal) {
        this.settings = new SettingsStore(paths.root,()=>manager.keyMetadataWarning());
        keys.on('warning',()=>manager.keyMetadataWarning());
        usage?.on('updated',summary=>{for(const peer of this.peers)if(peer.hello&&peer.usage)this.control(peer,{kind:'usage.updated',usage:summary});});
        this.sampler = sampler ?? new SystemSampler(defaultSamplerDeps(() => manager.sessionRoots(), log));
        this.sampler.on('stats', (stats: SystemStats) => { for (const peer of this.peers) if (peer.hello && peer.stats) this.control(peer, { kind: 'system.stats', stats }); });
        this.server = createServer(socket => this.accept(socket));
        this.server.on('error', error => { this.log.error('Server failed'); this.manager.emit('fatal', error); });
        manager.on('event', (event: SessionEvent) => { for (const peer of this.peers)
            if (peer.hello)
                this.control(peer, event); });
        manager.on('output', (id: string, data: Buffer) => {
            for (const peer of this.peers) {
                if(this.owners.get(id)===peer){
                    peer.socket.write(encodeData(2,id,data));
                    if(peer.socket.writableLength>1024*1024)this.manager.clientBackpressure(id,true);
                    continue;
                }
                if (peer.preview !== id || peer.refreshing || peer.lagged)
                    continue;
                if (peer.socket.writableLength > 1024 * 1024) {
                    peer.lagged = true;
                    continue;
                }
                peer.socket.write(encodeData(2, id, data));
            }
        });
    }
    clientCount(): number { return this.peers.size; }
    private control(peer: Peer, value: unknown): void {
        if (peer.socket.destroyed)
            return;
        // Control/event consumers cannot keep an unbounded queue either. One snapshot response can
        // fill a whole frame, so the bound leaves room for it plus 2 MiB of events behind it.
        if (peer.socket.writableLength > MAX_FRAME_BYTES + 2 * 1024 * 1024) {
            peer.socket.destroy();
            return;
        }
        peer.socket.write(encodeControl(value));
    }
    async listen(): Promise<void> {
        await this.settings.get();
        this.socketIdentity = await listenPrivate(this.server, this.paths.socket);
    }
    // Homepage clients that route notification clicks (they send clicks.subscribe). None open → the click opens Terminal.
    clickClients(): number { return [...this.peers].filter(peer => peer.hello && peer.clicks && !peer.socket.destroyed).length; }
    selectSession(sessionId: string): void {
        const terminals=new Set<TerminalBundle>();
        for(const peer of this.peers)if(peer.hello&&peer.clicks&&!peer.socket.destroyed){
            this.control(peer,{kind:'session.select',sessionId});if(peer.terminal)terminals.add(peer.terminal);
        }
        for(const terminal of terminals)void this.activate(terminal).catch(()=>this.log.error('Notification click could not activate terminal'));
    }
    private async sendText(peer:Peer,id:string,copy:SessionText):Promise<void>{
        const bytes=Buffer.from(copy.text,'utf8');let start=0;
        do{
            let end=Math.min(bytes.length,start+COPY_CHUNK_BYTES);while(end<bytes.length&&((bytes[end]??0)&0xc0)===0x80)end--;
            const more=end<bytes.length;
            // Chunk JSON stays below 4 MiB even with quotes/newlines; respect the socket's backpressure.
            const frame=encodeControl({id,ok:true,copy:{sessionId:copy.sessionId,text:bytes.subarray(start,end).toString('utf8'),truncated:copy.truncated,...(copy.source?{source:copy.source}:{}),more}});
            await new Promise<void>((resolve,reject)=>peer.socket.write(frame,error=>error?reject(error):resolve()));start=end;
        }while(start<bytes.length);
    }
    private accept(socket: Socket): void {
        const peer: Peer = { socket, closing:false, hello: false, attached:null, preview: null, refreshing: false, lagged: false, stats: false, usage:false, clicks:false, queue: Promise.resolve() };
        this.peers.add(peer);
        const decoder = new FrameDecoder();
        let queued = 0;let queuedBytes=0;
        socket.setTimeout(5000, () => { if (!peer.hello)
            socket.destroy(); });
        socket.on('error', () => this.log.error('Client socket failed'));
        socket.on('close', () => {this.peers.delete(peer);this.updateSampling();void this.detach(peer).catch(error=>{this.log.error('Disconnect detach failed');this.manager.emit('fatal',error);});});
        socket.on('drain', () => { if(peer.attached&&this.owners.get(peer.attached)===peer&&socket.writableLength<256*1024)this.manager.clientBackpressure(peer.attached,false);
            if (peer.lagged && peer.preview && !peer.refreshing)
            void this.refresh(peer).catch(() => { this.log.error('Preview refresh failed'); socket.destroy(); }); });
        socket.on('data', data => {
            try {
                for (const frame of decoder.push(data)) {
                    if(frame.type===2)throw new ProtocolError('UNSUPPORTED_FRAME','Output frames are daemon-only');
                    const value=frame.type===1?decodeControl(frame):null;
                    queuedBytes+=frame.payload.length;
                    if (++queued > 128 || queuedBytes > 8*1024*1024)
                        throw new ProtocolError('TOO_MANY_REQUESTS', 'Request queue exceeded');
                    peer.queue = peer.queue.then(async () => { if (!socket.destroyed&&!peer.closing)
                        if(frame.type===3){
                            const id=frame.payload.subarray(0,36).toString('ascii');
                            if(peer.hello&&this.owners.get(id)===peer)this.manager.input(id,frame.payload.subarray(36));
                            else this.log.info('Dropped input from non-attached client');
                        }else await this.handle(peer,value); }).catch(() => { this.log.error('Request failed'); this.control(peer, { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Request failed' } }); }).finally(() => { queued--;queuedBytes-=frame.payload.length; });
                }
            }
            catch (error) {
                this.control(peer, { ok: false, error: { code: error instanceof ProtocolError ? error.code : 'INVALID_FRAME', message: error instanceof ProtocolError ? error.message : 'Invalid frame' } });
                peer.closing=true;socket.end();
            }
        });
    }
    private async refresh(peer: Peer, requestId?: string): Promise<void> {
        const id = peer.preview;
        if (!id)
            return;
        peer.refreshing = true;
        try {
            await this.manager.snapshot(id, (snapshot,size) => {
                if (peer.preview !== id || peer.socket.destroyed)
                    return;
                this.control(peer, { id: requestId ?? peer.snapshotId, ok: true, sessionId: id, snapshot, ...size });
                peer.lagged = false;
                peer.refreshing = false;
            });
        }
        finally {
            peer.refreshing = false;
        }
    }
    private async handle(peer: Peer, value: unknown): Promise<void> {
        let request: Request;
        try {
            request = await validateRequest(value);
        }
        catch (error) {
            const id = value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' ? value.id : undefined;
            this.control(peer, { id, ok: false, error: { code: 'INVALID_REQUEST', message: error instanceof Error ? error.message : 'Invalid request' } });
            return;
        }
        if (request.kind === 'hello') {
            if (request.protocol !== PROTOCOL_VERSION) {
                this.control(peer, { id: request.id, kind: 'helloMismatch', protocol: PROTOCOL_VERSION });
                peer.closing=true;peer.socket.end();
                return;
            }
            peer.hello = true;
            peer.socket.setTimeout(0);
            this.control(peer, { id: request.id, ok: true, kind: 'hello', protocol: PROTOCOL_VERSION, version: packageInfo.version, daemonPid: process.pid });
            const warning = this.manager.warningText();
            if (warning) this.control(peer, { kind: 'daemon.warning', text: warning });
            return;
        }
        if (!peer.hello) {
            this.control(peer, { id: request.id, ok: false, error: { code: 'HELLO_REQUIRED', message: 'Send hello first' } });
            return;
        }
        try {
            switch (request.kind) {
                case 'usage.summary':this.control(peer,{id:request.id,ok:true,usage:this.usage?.summary()});break;
                case 'usage.diagnostics':this.control(peer,{id:request.id,ok:true,usageDiagnostics:this.usage?.diagnostics()});break;
                case 'usage.subscribe':peer.usage=request.on;this.control(peer,{id:request.id,ok:true});break;
                case 'clicks.subscribe':peer.clicks=request.on;peer.terminal=request.on?request.terminal:undefined;this.control(peer,{id:request.id,ok:true});break;
                case 'keys.list': this.control(peer,{id:request.id,ok:true,keys:await this.keys.list()}); break;
                case 'keys.add': this.control(peer,{id:request.id,ok:true,key:await this.keys.add(request)}); break;
                case 'keys.remove': await this.keys.remove(request.keyId); this.control(peer,{id:request.id,ok:true}); break;
                case 'keys.scanEnvFile': this.control(peer,{id:request.id,ok:true,found:await this.keys.scanEnvFile(request.path)}); break;
                case 'keys.importEnv': this.control(peer,{id:request.id,ok:true,keys:await this.keys.importEnv(request.path,request.names)}); break;
                case 'keys.test': {
                    const key=await this.keys.view(request.keyId),provider=key.provider;
                    // Ollama: the local server's own list is the check; it has no key to send anywhere.
                    if(provider==='ollama'){
                        let models:string[];
                        try{models=await listOllama(key.endpoint??'');}catch(error){this.log.error(`Ollama list failed: ${error instanceof OllamaError?error.detail:'unexpected error'}`);throw new KeyError(error instanceof OllamaError?error.message:'Ollama did not answer');}
                        const saved=await this.keys.saveModels(key.id,models);this.control(peer,{id:request.id,ok:true,results:saved.lastTest??[]});break;
                    }
                    if(provider==='anthropic'||provider==='openai'||!key.deployments)throw new KeyError('Only Foundry keys have deployment tests');
                    // Only the Keychain-bound endpoint and deployments, never settings.json's copy (B12); the fixed-host
                    // providers' hosts come from code (v0.6.5).
                    const results=await this.keys.withSecret(key.id,(secret,binding)=>{
                        if(provider==='foundry'){if(!binding)throw new KeyError('Only Foundry keys have deployment tests');return testFoundry(binding.endpoint,binding.deployments,secret);}
                        if(provider==='bedrock'){if(!binding)throw new KeyError('Bedrock key details changed outside AI Term; add the key again');return testDirect('bedrock',binding.endpoint,binding.deployments,secret);}
                        return testDirect(provider,DIRECT_HOSTS[provider],key.deployments??[],secret);
                    });
                    await this.keys.saveTest(key.id,results);this.control(peer,{id:request.id,ok:true,results});break;
                }
                case 'engines.status':
                    this.control(peer, { id: request.id, ok: true, engines: await enginesStatus(), notifier: this.notifier?.state() ?? 'not built' });
                    break;
                case 'mcp.list': case 'mcp.add': case 'mcp.remove': case 'mcp.toggle': case 'mcp.approve': case 'mcp.discover': case 'mcp.schema': case 'mcp.call': case 'mcp.cancel': case 'mcp.stop':
                    if(['mcp.schema','mcp.call','mcp.cancel','mcp.stop'].includes(request.kind))throw new Error('MCP tool calls require an agent');
                    this.control(peer,{id:request.id,ok:true,...await this.manager.mcp.query('homepage',request)});break;
                case 'extensions.list': case 'extensions.read': case 'extensions.toggle':
                    this.control(peer, {id:request.id,ok:true,...await new ExtensionService(this.settings).query(request)}); break;
                case 'settings.get':
                    this.control(peer, { id: request.id, ok: true, settings: await this.settings.get(),notificationPermission:(request.refreshNotifications?await this.notifier?.refreshPermission?.():this.notifier?.permission?.())??'unknown' });
                    break;
                case 'settings.set':
                    // A deployment can only be marked as a model the catalog knows: its prices and limits come from there.
                    if (request.patch.deploymentModels && Object.values(request.patch.deploymentModels).some(model => !catalogIds().includes(model))) throw new Error('Unknown catalog model');
                    this.control(peer, { id: request.id, ok: true, settings: await this.settings.set(request.patch) });
                    break;
                case 'sessions.list':
                    this.control(peer, { id: request.id, ok: true, sessions: this.manager.list() });
                    if (this.manager.warningText()) this.control(peer, { kind: 'daemon.warning', text: this.manager.warningText() });
                    if (this.manager.notice) this.control(peer, { kind: 'daemon.notice', text: this.manager.notice });
                    break;
                case 'sessions.resume':
                    this.control(peer,{id:request.id,ok:true,session:await this.manager.resume(request.sessionId)});
                    break;
                case 'worktrees.preview':
                    this.control(peer,{id:request.id,ok:true,worktreePreview:(await this.settings.get()).worktrees==='off'?{}:await previewWorktree(this.paths.root,request.cwd,request.title)});
                    break;
                case 'worktrees.list':
                    this.control(peer,{id:request.id,ok:true,worktrees:await this.manager.worktreeViews()});
                    break;
                case 'worktrees.check':
                    this.control(peer,{id:request.id,ok:true,worktree:await this.manager.checkWorktree(request.path)});
                    break;
                case 'worktrees.delete':
                    await this.manager.deleteWorktree(request.path,request.fingerprint,request.confirm);
                    this.control(peer,{id:request.id,ok:true,deletedWorktree:request.path});
                    break;
                case 'sessions.create':
                    this.control(peer, { id: request.id, ok: true, session: await this.manager.create(request) });
                    break;
                case 'sessions.forkPlan':
                    this.control(peer,{id:request.id,ok:true,forkPlan:await this.manager.forkPlan(request.sessionId,{engine:request.engine,model:request.model,auth:request.auth,...(request.effort!==undefined?{effort:request.effort}:{})})});
                    break;
                case 'sessions.fork':
                    this.control(peer,{id:request.id,ok:true,session:await this.manager.fork(request.sessionId,{engine:request.engine,model:request.model,auth:request.auth,...(request.effort!==undefined?{effort:request.effort}:{})})});
                    break;
                case 'sessions.reviewPlan':
                    this.control(peer,{id:request.id,ok:true,reviewPlan:await this.manager.reviewPlan(request.sessionId)});
                    break;
                case 'sessions.review':
                    this.control(peer,{id:request.id,ok:true,review:await this.manager.review(request.sessionId,request.keyId,request.model,request.fingerprint)});
                    break;
                case 'sessions.lastReview':
                    this.control(peer,{id:request.id,ok:true,review:await this.manager.lastReview(request.sessionId)});
                    break;
                case 'sessions.testPlan':
                    this.control(peer,{id:request.id,ok:true,testPlan:await this.manager.testPlan(request.sessionId)});
                    break;
                case 'sessions.test':
                    await this.manager.runTestPlan(request.sessionId,request.fingerprint);
                    this.control(peer,{id:request.id,ok:true});
                    break;
                case 'project.testCommand':
                    this.control(peer,{id:request.id,ok:true,testCommand:await this.manager.testCommand(request.cwd)});
                    break;
                case 'project.setTestCommand':
                    this.control(peer,{id:request.id,ok:true,testCommand:await this.manager.setTestCommand(request.cwd,request.command)});
                    break;
                case 'sessions.mergePlan':
                    this.control(peer,{id:request.id,ok:true,mergePlan:await this.manager.mergePlan(request.sessionId)});
                    break;
                case 'sessions.prPlan':
                    this.control(peer,{id:request.id,ok:true,prPlan:await this.manager.prPlan(request.sessionId)});
                    break;
                case 'sessions.merge':
                    this.control(peer,{id:request.id,ok:true,merged:await this.manager.merge(request.sessionId,request.fingerprint,request.override)});
                    break;
                case 'sessions.pr':
                    this.control(peer,{id:request.id,ok:true,pr:await this.manager.pr(request.sessionId,request.fingerprint,request.override)});
                    break;
                case 'sessions.undoPlan':
                    this.control(peer,{id:request.id,ok:true,undoPlan:await this.manager.undoPlan(request.sessionId,request.redo?'redo':'undo')});
                    break;
                case 'sessions.undo':
                    this.control(peer,{id:request.id,ok:true,undone:await this.manager.undo(request.sessionId,request.redo?'redo':'undo',request.fingerprint)});
                    break;
                case 'sessions.export':
                    this.control(peer,{id:request.id,ok:true,exportData:await this.manager.exportSession(request.sessionId)});
                    break;
                case 'sessions.diff':
                    this.control(peer,{id:request.id,ok:true,diff:await this.manager.diff(request.sessionId,request.against)});
                    break;
                case 'sessions.text':
                    await this.sendText(peer,request.id,await this.manager.text(request.sessionId,request.lastReply));
                    break;
                case 'sessions.attach':
                    if(peer.attached&&peer.attached!==request.sessionId)await this.detach(peer);
                    await this.manager.attach(request.sessionId,request.cols,request.rows,(snapshot,size,modes)=>{
                        const old=this.owners.get(request.sessionId);
                        if(old&&old!==peer){old.attached=null;this.control(old,{kind:'session.detached',sessionId:request.sessionId,reason:'attached elsewhere'});}
                        this.manager.clientBackpressure(request.sessionId,false);
                        this.owners.set(request.sessionId,peer);peer.attached=request.sessionId;peer.preview=null;
                        this.control(peer,{id:request.id,ok:true,sessionId:request.sessionId,snapshot,...size,modes,session:this.manager.get(request.sessionId)});
                    });
                    if(peer.socket.destroyed||peer.closing)await this.detach(peer);
                    break;
                case 'sessions.detach':
                    if(peer.attached===request.sessionId)await this.detach(peer);
                    this.control(peer,{id:request.id,ok:true});break;
                case 'sessions.resize':
                    await this.manager.resizeAttached(request.sessionId,request.cols,request.rows,()=>this.owners.get(request.sessionId)===peer);
                    this.control(peer,{id:request.id,ok:true});break;
                case 'sessions.preview':
                    if (request.sessionId !== null)
                        this.manager.get(request.sessionId);
                    peer.preview = request.sessionId;
                    peer.snapshotId = request.id;
                    peer.lagged = false;
                    if (peer.preview) {
                        try{await this.refresh(peer,request.id);}catch(error){peer.preview=null;throw error;}
                    }
                    else
                        this.control(peer, { id: request.id, ok: true, snapshot: '',...this.manager.previewDimensions() });
                    break;
                case 'sessions.stop':
                    await this.manager.stop(request.sessionId);
                    this.control(peer, { id: request.id, ok: true });
                    break;
                case 'sessions.remove': {
                    const keptWorktree=this.manager.get(request.sessionId).worktree;
                    await this.manager.remove(request.sessionId);
                    this.forget(request.sessionId);
                    this.control(peer, { id: request.id, ok: true, ...(keptWorktree?{keptWorktree}:{}) });
                    break;
                }
                case 'sessions.retry': {
                    // The new agent replaces the old record, which retry has already removed (or logged that it couldn't).
                    const session=await this.manager.retry(request.sessionId);
                    if(!this.manager.list().some(s=>s.id===request.sessionId))this.forget(request.sessionId);
                    this.control(peer,{id:request.id,ok:true,session});
                    break;
                }
                case 'sessions.handoffPlan':
                    this.control(peer,{id:request.id,ok:true,handoffPlan:await this.manager.handoffPlan(request.sessionId,request.engine,request.account)});
                    break;
                case 'sessions.handoff': {
                    const handed=await this.manager.handoff(request.sessionId,request.engine,request.writer,request.account);
                    this.control(peer,{id:request.id,ok:true,session:handed.session,handoffSummary:handed.summary,handoffOldRunning:handed.oldKeptRunning});
                    break;
                }
                case 'sessions.send':
                    await this.manager.send(request.sessionId,request.text);
                    this.control(peer,{id:request.id,ok:true});
                    break;
                case 'sessions.find': {
                    const {matches,more}=this.manager.find(request.text);
                    this.control(peer,{id:request.id,ok:true,matches,moreMatches:more});
                    break;
                }
                case 'sessions.rename':
                    this.control(peer, { id: request.id, ok: true, session: await this.manager.rename(request.sessionId, request.title) });
                    break;
                case 'system.subscribe':
                    peer.stats = request.on;
                    this.updateSampling();
                    this.control(peer, { id: request.id, ok: true });
                    break;
                case 'layout.previewSize':
                    await this.manager.previewSize(request.cols, request.rows);
                    this.control(peer, { id: request.id, ok: true });
                    break;
            }
        }
        catch (error) {
            if(request.kind==='sessions.text')this.log.error('Session text export failed');
            if(request.kind==='sessions.text'){this.control(peer,{id:request.id,ok:false,error:{code:'OPERATION_FAILED',message:error instanceof Error&&error.message==='Session not found'?'Session not found':'Session text unavailable'}});return;}
            const fixed = new Set([
                'claude not found in PATH','codex not found in PATH','Engine is not logged in','Engine login status unavailable',
                'Current terminal screen exceeds snapshot frame limit','Session not found','Only exited sessions can be removed','Background service is stopping','Account not found for this engine','This agent has no worktree to diff',...CHECKPOINT_ERRORS,...MERGE_ERRORS,...TEST_ERRORS,...REVIEW_ERRORS,...FORK_ERRORS,'This worktree has no recorded start to diff against','Diff unavailable; git could not read the worktree',PROFILE_OTHER_ENGINE,"Settings unreadable; can't tell which account to use",
                'Resume needs a finished agent','A shell has no AI conversation to resume','This older Claude agent has no conversation ID',
                'Conversation already running','Conversation already starting','Invalid session request','Invalid session or title',
                'Invalid preview size','Invalid attach','Session unavailable','Invalid resize','Not attached',
                'Session stop timed out','Session stop signal failed',
                'Invalid key id','Key not found','Invalid key metadata','Invalid key details','Key details must not contain the secret',
                'Only Foundry keys have deployment tests','Foundry needs an endpoint and deployments','Key provider does not match engine','Foundry deployment must pass its test first',
                // AI Term's agent (v0.4.1–v0.4.2).
                'AI Term agent needs an API key',"AI Term agent can't use this key yet","AI Term agent can't resume yet; /retry starts it fresh",'Pick a model for AI Term agent','Unknown catalog model',
                'OS keychain unavailable; key was not saved','OS keychain unavailable; key was not removed','OS keychain unavailable',
                'Key metadata failed and keychain cleanup failed; remove the new test entry in Keychain Access',
                'Key metadata could not be saved','Key removed from keychain; metadata could not be saved','Key is missing from the OS keychain',
                'Env file must be a small regular file owned by you','Env file contains duplicate import fields',
                'Invalid env import selection','Selected env key is missing or invalid','Foundry import needs AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENT',...FOUNDRY_KEY_ERRORS,...OLLAMA_ERRORS,'Model must pass its test first; test the key in /settings (t)',...HANDOFF_ERRORS,...WORKTREE_DELETE_ERRORS,...AGENT_COMMAND_ERRORS
            ]);
            const message = error instanceof Error && (fixed.has(error.message) || error instanceof MergeError && CHECKOUT_NOT_ON_BASE.test(error.message) || error instanceof KeyError && /^Import failed and [1-9]\d? new keys? could not be removed; remove (?:it|them) in \/settings or Keychain Access$/.test(error.message)) ? error.message : 'Session operation failed';
            // The validated request kind and the same fixed reason the client gets: never argv, paths or provider text.
            this.log.error(`Operation failed: ${request.kind} (${message === 'Session operation failed' ? 'unexpected error' : message})`);
            this.control(peer, { id: request.id, ok: false, error: { code: 'OPERATION_FAILED', message } });
        }
    }
    // Sampling runs only while some connected client wants it (architecture §10).
    private updateSampling(): void { if (this.closed) return; this.sampler.setSubscribers([...this.peers].filter(peer => peer.stats).length); }
    // A removed record has no owner and no previewers left.
    private forget(id:string):void{
        const owner=this.owners.get(id);if(owner)owner.attached=null;
        this.owners.delete(id);
        for(const p of this.peers)if(p.preview===id)p.preview=null;
    }
    private async detach(peer:Peer):Promise<void> {
        const id=peer.attached;if(!id)return;
        await this.manager.detach(id,()=>{
            if(this.owners.get(id)!==peer)return false;
            this.owners.delete(id);peer.attached=null;return true;
        });
    }
    async close(): Promise<void> {
        // Peers' close handlers run after this; they must not restart sampling during shutdown.
        this.closed = true;
        this.sampler.setSubscribers(0);
        for (const peer of this.peers)
            peer.socket.destroy();
        await closePrivate(this.server, this.paths.socket, this.socketIdentity);
    }
}
