import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Paths } from '../shared/paths.js';
import type { SessionInfo, SessionEvent } from '../shared/protocol.js';
import { isUUID, isTitle, isSize, validCwd } from '../shared/validate.js';
import { atomicWrite, readState } from './store.js';
import { Logger } from './log.js';
import { PtyHost, type SpawnRecipe } from './pty-host.js';
import { Mirror } from './mirror.js';
import { buildShellEnv } from './env.js';
interface Live { info: SessionInfo; host?: PtyHost; mirror: Mirror; output: Promise<void> }
export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Live>();
  private size = { cols: 85, rows: 30 };
  private saving: Promise<void> = Promise.resolve();
  private closing = false;
  constructor(private readonly paths: Paths, private readonly log: Logger, private readonly recipe: SpawnRecipe = { executable: process.env.SHELL || '/bin/zsh', args: ['-l'], env: buildShellEnv(process.env) }) { super(); }
  async load(): Promise<void> {
    const state = await readState(this.paths.state);
    if (!state || typeof state !== 'object' || !('sessions' in state) || !Array.isArray(state.sessions)) throw new Error('Invalid daemon state');
    for (const raw of state.sessions as unknown[]) {
      if (!raw || typeof raw !== 'object') throw new Error('Invalid session record');
      const r = raw as Record<string, unknown>;
      if (!isUUID(r.id) || !isTitle(r.title) || r.engine !== 'shell' || typeof r.cwd !== 'string' || typeof r.createdAt !== 'string') throw new Error('Invalid session record');
      const now = new Date().toISOString();
      const info: SessionInfo = { id: r.id, title: r.title, engine: 'shell', model: 'shell', auth: {kind:'account'}, cwd: r.cwd, permission:'ask', status:'exited', statusDetail:'background service restarted', statusSince:now, exitCode:null, createdAt:r.createdAt, lastOutputAt:null, ctxPercent:null };
      this.sessions.set(info.id, {info, mirror:new Mirror(this.size.cols,this.size.rows,()=>{}), output:Promise.resolve()});
    }
    await this.persist();
  }
  list(): SessionInfo[] { return [...this.sessions.values()].map(s => ({ ...s.info })); }
  get(id: string): SessionInfo { const live = this.sessions.get(id); if (!live) throw new Error('Session not found'); return { ...live.info }; }
  activeCount(): number { return this.list().filter(s => s.status === 'starting' || s.status === 'running').length; }
  private event(event: SessionEvent): void { this.emit('event', event); }
  private persist(): Promise<void> {
    const data = { sessions: [...this.sessions.values()].map(s => ({ ...s.info, pid: s.host?.pty.pid ?? null, recipe: {engine:'shell',model:'shell',auth:{kind:'account'},cwd:s.info.cwd,permission:'ask'} })) };
    const next = this.saving.then(() => atomicWrite(this.paths.state, data));
    this.saving = next.catch(error => { this.log.error(`State write failed: ${error instanceof Error ? error.message : 'unknown'}`); this.emit('fatal', error); });
    return next;
  }
  async create(request: {cwd:string;title?:string}): Promise<SessionInfo> {
    if (this.closing || !(await validCwd(request.cwd)) || (request.title !== undefined && !isTitle(request.title))) throw new Error('Invalid session request');
    const now = new Date().toISOString();
    const info: SessionInfo = {id:randomUUID(),title:request.title??'shell',engine:'shell',model:'shell',auth:{kind:'account'},cwd:request.cwd,permission:'ask',status:'starting',statusDetail:'starting',statusSince:now,exitCode:null,createdAt:now,lastOutputAt:null,ctxPercent:null};
    const live: Live = {info,mirror:new Mirror(this.size.cols,this.size.rows,data=>live.host?.write(data)),output:Promise.resolve()};
    this.sessions.set(info.id, live);
    try {
      live.host = new PtyHost(this.recipe, request.cwd, this.size.cols, this.size.rows);
      live.host.pty.onData(data => {
        live.output = live.output.then(async () => {
          await live.mirror.write(data);
          info.lastOutputAt = new Date().toISOString();
          if (info.status === 'starting') { info.status='running'; info.statusDetail='running'; info.statusSince=info.lastOutputAt; await this.persist(); this.event({kind:'session.updated',session:{...info}}); }
          this.emit('output', info.id, Buffer.from(data));
        }).catch(error=>{this.log.error(`Mirror update failed: ${error instanceof Error ? error.message : 'unknown'}`);this.emit('fatal',error);});
      });
      live.host.pty.onExit(event => {
        live.output = live.output.then(async () => {
          info.exitCode=event.exitCode; info.status=event.exitCode===0?'exited':'error'; info.statusDetail=`exit ${event.exitCode}`; info.statusSince=new Date().toISOString();
          await this.persist(); this.event({kind:'session.updated',session:{...info}});
        }).catch(error=>{this.log.error(`Exit record failed: ${error instanceof Error ? error.message : 'unknown'}`);this.emit('fatal',error);});
      });
    } catch (error) { info.status='error'; info.statusDetail='spawn failed'; this.log.error(`PTY spawn failed: ${error instanceof Error ? error.message : 'unknown'}`); }
    await this.persist(); this.event({kind:'session.updated',session:{...info}}); return {...info};
  }
  async snapshot(id:string):Promise<string> { const live=this.sessions.get(id);if(!live)throw new Error('Session not found');await live.output;return live.mirror.snapshot(); }
  async stop(id:string):Promise<void> { const live=this.sessions.get(id);if(!live)throw new Error('Session not found');await live.host?.stop();await live.output; }
  async remove(id:string):Promise<void> { const live=this.sessions.get(id);if(!live)throw new Error('Session not found');if(!['exited','error'].includes(live.info.status))throw new Error('Only exited sessions can be removed');await live.output;live.mirror.dispose();this.sessions.delete(id);await this.persist();this.event({kind:'session.removed',sessionId:id}); }
  async rename(id:string,title:string):Promise<SessionInfo> { const live=this.sessions.get(id);if(!live||!isTitle(title))throw new Error('Invalid session or title');live.info.title=title;await this.persist();this.event({kind:'session.updated',session:{...live.info}});return {...live.info}; }
  async previewSize(cols:number,rows:number):Promise<void> { if(!isSize(cols,rows))throw new Error('Invalid preview size');this.size={cols,rows};for(const live of this.sessions.values()){await live.output;live.mirror.resize(cols,rows);live.host?.resize(cols,rows);} }
  async shutdown():Promise<void> { this.closing=true;await Promise.all([...this.sessions.keys()].map(id=>this.stop(id)));await this.saving;for(const live of this.sessions.values())live.mirror.dispose(); }
}
