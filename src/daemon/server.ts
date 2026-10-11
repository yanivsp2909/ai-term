import { createServer, createConnection, type Socket, type Server } from 'node:net';
import { lstat, unlink, chmod } from 'node:fs/promises';
import type { Paths } from '../shared/paths.js';
import { isFsError } from '../shared/paths.js';
import { FrameDecoder, encodeControl, encodeData, decodeControl, ProtocolError, PROTOCOL_VERSION, type Request, type SessionEvent } from '../shared/protocol.js';
import { validateRequest } from '../shared/validate.js';
import { SessionManager } from './session-manager.js';
import { Logger } from './log.js';
import packageInfo from '../../package.json' with { type: 'json' };
interface Peer {
    socket: Socket;
    hello: boolean;
    closing:boolean;
    preview: string | null;
    attached:string|null;
    refreshing: boolean;
    lagged: boolean;
    queue: Promise<void>;
    snapshotId?: string;
}
export async function socketAnswers(path: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(path);
        let settled = false;
        const finish = (alive: boolean) => { if (!settled) {
            settled = true;
            socket.destroy();
            resolve(alive);
        } };
        socket.setTimeout(300, () => finish(true)); // A hung listener still owns the address; never unlink it.
        socket.once('connect', () => finish(true));
        socket.once('error', error => { if (isFsError(error, 'ENOENT') || isFsError(error, 'ECONNREFUSED'))
            finish(false);
        else {
            settled = true;
            socket.destroy();
            reject(error);
        } });
    });
}
export class DaemonServer {
    private server: Server;
    private peers = new Set<Peer>();
    private owners=new Map<string,Peer>();
    private socketIdentity: {
        ino: number;
        dev: number;
    } | undefined;
    constructor(private readonly paths: Paths, private readonly manager: SessionManager, private readonly log: Logger) {
        this.server = createServer(socket => this.accept(socket));
        this.server.on('error', error => { this.log.error(`Server failed: ${error.message}`); this.manager.emit('fatal', error); });
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
        // Control/event consumers cannot keep an unbounded queue either.
        if (peer.socket.writableLength > 2 * 1024 * 1024) {
            peer.socket.destroy();
            return;
        }
        peer.socket.write(encodeControl(value));
    }
    async listen(): Promise<void> {
        try {
            const stat = await lstat(this.paths.socket);
            if (!stat.isSocket() || stat.uid !== process.getuid?.())
                throw new Error('Unsafe socket path');
            if (await socketAnswers(this.paths.socket))
                throw new Error('Daemon socket already in use');
            const current = await lstat(this.paths.socket);
            if (current.ino !== stat.ino || current.dev !== stat.dev)
                throw new Error('Socket changed during stale check');
            await unlink(this.paths.socket);
        }
        catch (error) {
            if (!isFsError(error, 'ENOENT'))
                throw error;
        }
        await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.paths.socket, () => { this.server.off('error', reject); resolve(); }); });
        await chmod(this.paths.socket, 0o600);
        const stat = await lstat(this.paths.socket);
        this.socketIdentity = { ino: stat.ino, dev: stat.dev };
    }
    private accept(socket: Socket): void {
        const peer: Peer = { socket, closing:false, hello: false, attached:null, preview: null, refreshing: false, lagged: false, queue: Promise.resolve() };
        this.peers.add(peer);
        const decoder = new FrameDecoder();
        let queued = 0;let queuedBytes=0;
        socket.setTimeout(5000, () => { if (!peer.hello)
            socket.destroy(); });
        socket.on('error', error => this.log.error(`Client socket failed: ${error.message}`));
        socket.on('close', () => {this.peers.delete(peer);void this.detach(peer).catch(error=>{this.log.error(`Disconnect detach failed: ${error instanceof Error?error.message:'unknown'}`);this.manager.emit('fatal',error);});});
        socket.on('drain', () => { if(peer.attached&&this.owners.get(peer.attached)===peer&&socket.writableLength<256*1024)this.manager.clientBackpressure(peer.attached,false);
            if (peer.lagged && peer.preview && !peer.refreshing)
            void this.refresh(peer).catch(error => { this.log.error(`Preview refresh failed: ${error instanceof Error ? error.message : 'unknown'}`); socket.destroy(); }); });
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
                        }else await this.handle(peer,value); }).catch(error => { this.log.error(`Request failed: ${error instanceof Error ? error.message : 'unknown'}`); this.control(peer, { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Request failed' } }); }).finally(() => { queued--;queuedBytes-=frame.payload.length; });
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
            return;
        }
        if (!peer.hello) {
            this.control(peer, { id: request.id, ok: false, error: { code: 'HELLO_REQUIRED', message: 'Send hello first' } });
            return;
        }
        try {
            switch (request.kind) {
                case 'sessions.list':
                    this.control(peer, { id: request.id, ok: true, sessions: this.manager.list() });
                    break;
                case 'sessions.create':
                    this.control(peer, { id: request.id, ok: true, session: await this.manager.create(request) });
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
                case 'sessions.remove':
                    await this.manager.remove(request.sessionId);
                    for (const p of this.peers)
                        if (p.preview === request.sessionId)
                            p.preview = null;
                    this.control(peer, { id: request.id, ok: true });
                    break;
                case 'sessions.rename':
                    this.control(peer, { id: request.id, ok: true, session: await this.manager.rename(request.sessionId, request.title) });
                    break;
                case 'layout.previewSize':
                    await this.manager.previewSize(request.cols, request.rows);
                    this.control(peer, { id: request.id, ok: true });
                    break;
            }
        }
        catch (error) {
            this.log.error(`Operation failed: ${error instanceof Error ? error.message : 'unknown'}`);
            this.control(peer, { id: request.id, ok: false, error: { code: 'OPERATION_FAILED', message: 'Session operation failed' } });
        }
    }
    private async detach(peer:Peer):Promise<void> {
        const id=peer.attached;if(!id)return;
        await this.manager.detach(id,()=>{
            if(this.owners.get(id)!==peer)return false;
            this.owners.delete(id);peer.attached=null;return true;
        });
    }
    async close(): Promise<void> {
        for (const peer of this.peers)
            peer.socket.destroy();
        if (this.server.listening)
            await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
        try {
            const stat = await lstat(this.paths.socket);
            if (stat.ino === this.socketIdentity?.ino && stat.dev === this.socketIdentity.dev)
                await unlink(this.paths.socket);
        }
        catch (error) {
            if (!isFsError(error, 'ENOENT'))
                throw error;
        }
    }
}
