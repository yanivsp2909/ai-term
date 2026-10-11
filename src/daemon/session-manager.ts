import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Paths } from '../shared/paths.js';
import type { SessionInfo, SessionEvent, TerminalModes } from '../shared/protocol.js';
import { isUUID, isTitle, isSize, validCwd } from '../shared/validate.js';
import { atomicWrite, readState } from './store.js';
import { Logger } from './log.js';
import { PtyHost, type SpawnRecipe } from './pty-host.js';
import { Mirror } from './mirror.js';
import { buildShellEnv } from './env.js';
interface Live {
    info: SessionInfo;
    host?: PtyHost;
    mirror: Mirror;
    output: Promise<void>;
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
    constructor(private readonly paths: Paths, private readonly log: Logger, private readonly recipe: SpawnRecipe = { executable: process.env.SHELL || '/bin/zsh', args: ['-l'], env: buildShellEnv(process.env) }, private readonly childUmask?: number) { super(); }
    async load(): Promise<void> {
        const state = await readState(this.paths.state);
        if (!state || typeof state !== 'object' || !('sessions' in state) || !Array.isArray(state.sessions))
            throw new Error('Invalid daemon state');
        for (const raw of state.sessions as unknown[]) {
            if (!raw || typeof raw !== 'object')
                throw new Error('Invalid session record');
            const r = raw as Record<string, unknown>;
            if (!isUUID(r.id) || !isTitle(r.title) || r.engine !== 'shell' || typeof r.cwd !== 'string' || typeof r.createdAt !== 'string')
                throw new Error('Invalid session record');
            const now = new Date().toISOString();
            const info: SessionInfo = { id: r.id, title: r.title, engine: 'shell', model: 'shell', auth: { kind: 'account' }, cwd: r.cwd, permission: 'ask', status: 'exited', statusDetail: 'background service restarted', statusSince: now, exitCode: null, createdAt: r.createdAt, lastOutputAt: null, ctxPercent: null };
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
    activeCount(): number { return this.list().filter(s => s.status === 'starting' || s.status === 'running').length; }
    private event(event: SessionEvent): void { this.emit('event', event); }
    private persist(): Promise<void> {
        const data = { sessions: [...this.sessions.values()].map(s => ({ ...s.info, pid: s.host?.pty.pid ?? null, recipe: { engine: 'shell', model: 'shell', auth: { kind: 'account' }, cwd: s.info.cwd, permission: 'ask' } })) };
        const next = this.saving.then(() => atomicWrite(this.paths.state, data));
        this.saving = next.catch(error => { this.log.error(`State write failed: ${error instanceof Error ? error.message : 'unknown'}`); this.emit('fatal', error); });
        return next;
    }
    async create(request: {
        cwd: string;
        title?: string;
    }): Promise<SessionInfo> {
        const cwdValid=await validCwd(request.cwd);
        if (this.closing || !cwdValid || (request.title !== undefined && !isTitle(request.title)))
            throw new Error('Invalid session request');
        const now = new Date().toISOString();
        const info: SessionInfo = { id: randomUUID(), title: request.title ?? 'shell', engine: 'shell', model: 'shell', auth: { kind: 'account' }, cwd: request.cwd, permission: 'ask', status: 'starting', statusDetail: 'starting', statusSince: now, exitCode: null, createdAt: now, lastOutputAt: null, ctxPercent: null };
        const live: Live = { info, mirror: new Mirror(this.size.cols, this.size.rows, data => live.host?.write(data)), queuedBytes:0, attached:false,clientPaused:false, paused:false, output: Promise.resolve() };
        this.sessions.set(info.id, live);
        try {
            live.host = new PtyHost(this.recipe, request.cwd, this.size.cols, this.size.rows, this.childUmask);
            live.host.pty.onData(data => {
                const bytes=Buffer.byteLength(data);live.queuedBytes+=bytes;
                this.updatePause(live);
                live.output = live.output.then(async () => {
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
                }).catch(error => { this.log.error(`Mirror update failed: ${error instanceof Error ? error.message : 'unknown'}`); this.emit('fatal', error); }).finally(()=>{
                    live.queuedBytes-=bytes;
                    this.updatePause(live);
                });
            });
            live.host.pty.onExit(event => {
                live.output = live.output.then(async () => {
                    // node-pty reports exitCode 0 for a killed child; only the signal tells a crash apart.
                    const crashed = Boolean(event.signal) && !live.host?.stopRequested;
                    info.exitCode = crashed ? null : event.exitCode;
                    info.status = event.exitCode === 0 && !crashed ? 'exited' : 'error';
                    info.statusDetail = crashed ? `signal ${event.signal}` : `exit ${event.exitCode}`;
                    info.statusSince = new Date().toISOString();
                    await this.persist();
                    this.event({ kind: 'session.updated', session: { ...info } });
                }).catch(error => { this.log.error(`Exit record failed: ${error instanceof Error ? error.message : 'unknown'}`); this.emit('fatal', error); });
            });
        }
        catch (error) {
            info.status = 'error';
            info.statusDetail = 'spawn failed';
            this.log.error(`PTY spawn failed: ${error instanceof Error ? error.message : 'unknown'}`);
        }
        await this.persist();
        this.event({ kind: 'session.updated', session: { ...info } });
        return { ...info };
    }
    async snapshot(id: string, publish?: (snapshot: string, size:{cols:number;rows:number}) => void): Promise<string> { const live = this.sessions.get(id); if (!live)
        throw new Error('Session not found'); return live.output.then(() => { const snapshot = live.mirror.snapshot(); publish?.(snapshot,{cols:live.mirror.terminal.cols,rows:live.mirror.terminal.rows}); return snapshot; }); }
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
        live.output=task.catch(error=>{this.log.error(`Attach failed: ${error instanceof Error?error.message:'unknown'}`);});await task;
    }
    async detach(id:string,owned:()=>boolean):Promise<void> {
        const live=this.sessions.get(id);if(!live)return;
        const task=live.output.then(()=>{
            if(!owned())return;
            live.attached=false;live.mirror.setAttached(false);live.clientPaused=false;this.updatePause(live);
            live.mirror.resize(this.size.cols,this.size.rows);live.host?.resize(this.size.cols,this.size.rows);
            this.event({kind:'session.previewResized',sessionId:id,...this.size});
        });
        live.output=task.catch(error=>{this.log.error(`Attachment change failed: ${error instanceof Error?error.message:'unknown'}`);});await task;
    }
    async resizeAttached(id:string,cols:number,rows:number,owned:()=>boolean):Promise<void> {
        const live=this.sessions.get(id);if(!live||!isSize(cols,rows))throw new Error('Invalid resize');
        const task=live.output.then(()=>{if(!owned())throw new Error('Not attached');live.mirror.resize(cols,rows);live.host?.resize(cols,rows);this.event({kind:'session.previewResized',sessionId:id,cols,rows});});
        live.output=task.catch(error=>{this.log.error(`Attachment change failed: ${error instanceof Error?error.message:'unknown'}`);});await task;
    }
    async shutdown(): Promise<void> { this.closing = true; await Promise.all([...this.sessions.keys()].map(id => this.stop(id))); await this.saving; for (const live of this.sessions.values())
        live.mirror.dispose(); }
}
